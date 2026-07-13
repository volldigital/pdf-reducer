// Step 7 end-to-end tests: the headline preservation guarantees on a
// realistic document — an AcroForm field with a value, an invisible OCR-style
// text layer, and a widget annotation, all over a large image.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFArray,
  StandardFonts,
  decodePDFRawStream,
} from 'pdf-lib';

import { reduce, inspectImages } from '../src/pdfSizeReducer.ts';

const noisyJpg = (w = 3000, h = 2250): Promise<Buffer> =>
  sharp({
    // sharp's Create type wrongly requires `background`; `noise` fills the
    // canvas at runtime, so cast rather than add one (which changes the bytes).
    create: {
      width: w,
      height: h,
      channels: 3,
      noise: { type: 'gaussian', mean: 128, sigma: 60 },
    } as unknown as sharp.Create,
  })
    .jpeg({ quality: 92 })
    .toBuffer();

const b64Len = (s: string): number => Buffer.from(s, 'base64').length;

async function pageContentBytes(base64: string): Promise<string[]> {
  const doc = await PDFDocument.load(Buffer.from(base64, 'base64'));
  return doc.getPages().map((page) => {
    const contents = page.node.Contents();
    const streams = contents instanceof PDFArray ? contents.asArray() : [contents];
    return Buffer.concat(
      streams.map((s) => {
        const stream = (s instanceof PDFRawStream ? s : doc.context.lookup(s)) as PDFRawStream;
        return Buffer.from(decodePDFRawStream(stream).decode());
      }),
    ).toString('latin1');
  });
}

const FIELD_NAME = 'patient.name';
const FIELD_VALUE = 'Erika Mustermann';
const OCR_TOKEN = 'OCR_HIDDEN_TOKEN_42';

/** A scan-like PDF: big image + invisible OCR text + a filled form field. */
async function buildKitchenSink(): Promise<string> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([600, 800]);

  const img = await doc.embedJpg(await noisyJpg());
  page.drawImage(img, { x: 0, y: 0, width: 600, height: 800 });

  // Invisible OCR-style text layer (opacity 0): real text operators in the
  // content stream, just not painted.
  page.drawText(OCR_TOKEN, { x: 50, y: 400, size: 12, font, opacity: 0 });

  const form = doc.getForm();
  const field = form.createTextField(FIELD_NAME);
  field.setText(FIELD_VALUE);
  field.addToPage(page, { x: 50, y: 720, width: 220, height: 22 });

  return Buffer.from(await doc.save()).toString('base64');
}

test('reduces the file while preserving form value, OCR text, and annotations', async () => {
  const input = await buildKitchenSink();
  const output = await reduce(input);

  // It actually got smaller.
  assert.ok(b64Len(output) < b64Len(input), 'output should be smaller');

  const inDoc = await PDFDocument.load(Buffer.from(input, 'base64'));
  const outDoc = await PDFDocument.load(Buffer.from(output, 'base64'));

  // Form field value survived.
  assert.equal(outDoc.getForm().getTextField(FIELD_NAME).getText(), FIELD_VALUE);

  // Page count unchanged.
  assert.equal(outDoc.getPageCount(), inDoc.getPageCount());

  // Annotation count per page unchanged (the field's widget).
  const annots = (doc: PDFDocument): number[] =>
    doc.getPages().map((p) => p.node.Annots()?.size() ?? 0);
  assert.deepEqual(annots(outDoc), annots(inDoc));

  // Content streams byte-identical → all text (incl. the invisible OCR layer)
  // is preserved verbatim.
  const [inContent] = await pageContentBytes(input);
  const [outContent] = await pageContentBytes(output);
  assert.equal(outContent, inContent);
  // pdf-lib writes the text as a hex string literal (<...> Tj), so look for
  // the hex-encoded token rather than raw ASCII.
  const tokenHex = Buffer.from(OCR_TOKEN, 'latin1').toString('hex').toUpperCase();
  assert.ok(
    outContent && outContent.toUpperCase().includes(tokenHex),
    'OCR text token still present',
  );

  // The image was downsampled.
  const imgs = (await inspectImages(output)).filter((i) => i.filter === '/DCTDecode');
  assert.equal(imgs.length, 1);
  const [img] = imgs;
  assert.ok(img);
  assert.ok(img.width! <= 2000);
});

test('running reduce twice is stable (second pass is a no-op)', async () => {
  const input = await buildKitchenSink();
  const once = await reduce(input);
  const twice = await reduce(once);
  // After the first pass the image is already within the cap/quality, so the
  // smaller-only rule keeps nothing and the second pass returns verbatim.
  assert.equal(twice, once);
});

test('filter chain [FlateDecode DCTDecode] is skipped', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 450]);
  const img = await doc.embedJpg(await noisyJpg());
  page.drawImage(img, { x: 0, y: 0, width: 600, height: 450 });
  let base64 = Buffer.from(await doc.save()).toString('base64');

  const d2 = await PDFDocument.load(Buffer.from(base64, 'base64'));
  for (const [, obj] of d2.context.enumerateIndirectObjects()) {
    if (
      obj instanceof PDFRawStream &&
      obj.dict.lookup(PDFName.of('Subtype')) === PDFName.of('Image')
    ) {
      obj.dict.set(
        PDFName.of('Filter'),
        d2.context.obj([PDFName.of('FlateDecode'), PDFName.of('DCTDecode')]),
      );
      break;
    }
  }
  base64 = Buffer.from(await d2.save()).toString('base64');

  const [img0] = await inspectImages(base64);
  assert.ok(img0);
  assert.equal(img0.eligible, false);
  assert.equal(img0.skipReason, 'filter is not a single DCTDecode');
});

test('a bilevel CCITTFax-filtered image is skipped (filter gate)', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 450]);
  const img = await doc.embedJpg(await noisyJpg());
  page.drawImage(img, { x: 0, y: 0, width: 600, height: 450 });
  let base64 = Buffer.from(await doc.save()).toString('base64');

  const d2 = await PDFDocument.load(Buffer.from(base64, 'base64'));
  for (const [, obj] of d2.context.enumerateIndirectObjects()) {
    if (
      obj instanceof PDFRawStream &&
      obj.dict.lookup(PDFName.of('Subtype')) === PDFName.of('Image')
    ) {
      obj.dict.set(PDFName.of('Filter'), PDFName.of('CCITTFaxDecode'));
      break;
    }
  }
  base64 = Buffer.from(await d2.save()).toString('base64');

  const [img0] = await inspectImages(base64);
  assert.ok(img0);
  assert.equal(img0.eligible, false);
  assert.equal(img0.skipReason, 'filter is not a single DCTDecode');
});
