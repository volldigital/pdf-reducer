// Step 5 tests: SMask handling and finalized edge-case pass-throughs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFArray,
  decodePDFRawStream,
} from 'pdf-lib';
import type { PDFRef, PDFDict } from 'pdf-lib';

import { reduce, inspectImages } from '../src/pdfSizeReducer.ts';

type ImageObj = { ref: PDFRef; obj: PDFRawStream };

const noisyJpg = (w: number, h: number, gray = false): Promise<Buffer> => {
  let p = sharp({
    // sharp's Create type wrongly requires `background`; `noise` fills the
    // canvas at runtime, so cast rather than add one (which changes the bytes).
    create: {
      width: w,
      height: h,
      channels: 3,
      noise: { type: 'gaussian', mean: 128, sigma: 60 },
    } as unknown as sharp.Create,
  });
  if (gray) p = p.toColourspace('b-w');
  return p.jpeg({ quality: 92 }).toBuffer();
};

const cmykJpg = (w: number, h: number): Promise<Buffer> =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r: 10, g: 20, b: 30 } } })
    .toColourspace('cmyk')
    .jpeg({ quality: 92 })
    .toBuffer();

const b64Len = (s: string): number => Buffer.from(s, 'base64').length;

function imageObjects(doc: PDFDocument): ImageObj[] {
  const out: ImageObj[] = [];
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (
      obj instanceof PDFRawStream &&
      obj.dict.lookup(PDFName.of('Subtype')) === PDFName.of('Image')
    ) {
      out.push({ ref, obj });
    }
  }
  return out;
}

async function pageContentBytes(base64: string): Promise<string[]> {
  const doc = await PDFDocument.load(Buffer.from(base64, 'base64'));
  return doc.getPages().map((page) => {
    const contents = page.node.Contents();
    const streams = contents instanceof PDFArray ? contents.asArray() : [contents];
    const chunks = streams.map((s) => {
      const stream = (s instanceof PDFRawStream ? s : doc.context.lookup(s)) as PDFRawStream;
      return Buffer.from(decodePDFRawStream(stream).decode());
    });
    return Buffer.concat(chunks).toString('latin1');
  });
}

test('base image with a grayscale DCT SMask: both re-encoded, link preserved', async () => {
  // Build: RGB base + a DeviceGray JPEG, then wire the gray image as the
  // base's /SMask.
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 450]);
  const base = await doc.embedJpg(await noisyJpg(3000, 2250));
  const mask = await doc.embedJpg(await noisyJpg(2500, 1875, true));
  page.drawImage(base, { x: 0, y: 0, width: 600, height: 450 });
  page.drawImage(mask, { x: 0, y: 0, width: 10, height: 10 }); // ensure embedded
  let input = Buffer.from(await doc.save()).toString('base64');

  const linkDoc = await PDFDocument.load(Buffer.from(input, 'base64'));
  let baseDict: PDFDict | undefined;
  let grayRef: PDFRef | undefined;
  for (const { ref, obj } of imageObjects(linkDoc)) {
    const cs = obj.dict.lookup(PDFName.of('ColorSpace'));
    if (cs === PDFName.of('DeviceRGB')) baseDict = obj.dict;
    if (cs === PDFName.of('DeviceGray')) grayRef = ref;
  }
  assert.ok(baseDict, 'expected a DeviceRGB base image');
  assert.ok(grayRef, 'expected a DeviceGray mask image');
  baseDict.set(PDFName.of('SMask'), grayRef);
  input = Buffer.from(await linkDoc.save()).toString('base64');

  const output = await reduce(input);
  assert.ok(b64Len(output) < b64Len(input), 'output should be smaller');

  // The base still links to a DeviceGray SMask image, now downsampled.
  const out = await PDFDocument.load(Buffer.from(output, 'base64'));
  const base2 = imageObjects(out).find(
    ({ obj }) => obj.dict.lookup(PDFName.of('ColorSpace')) === PDFName.of('DeviceRGB'),
  );
  assert.ok(base2);
  const smaskVal = base2.obj.dict.get(PDFName.of('SMask'));
  assert.ok(smaskVal, 'base image must keep its /SMask');
  const smaskImg = out.context.lookup(smaskVal);
  assert.ok(smaskImg instanceof PDFRawStream, 'SMask resolves to an image stream');
  assert.equal(smaskImg.dict.lookup(PDFName.of('ColorSpace')), PDFName.of('DeviceGray'));
  const smaskW = smaskImg.dict.lookup(PDFName.of('Width'), PDFNumber).asNumber();
  assert.ok(smaskW <= 2000, 'SMask was downsampled within the cap');

  // Preservation: page content streams untouched.
  assert.deepEqual(await pageContentBytes(output), await pageContentBytes(input));
});

test('image with a /Mask is skipped (pass through verbatim)', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 450]);
  const img = await doc.embedJpg(await noisyJpg(3000, 2250));
  page.drawImage(img, { x: 0, y: 0, width: 600, height: 450 });
  let input = Buffer.from(await doc.save()).toString('base64');

  // Inject a color-key /Mask array onto the (only) image.
  const d2 = await PDFDocument.load(Buffer.from(input, 'base64'));
  imageObjects(d2)[0]!.obj.dict.set(PDFName.of('Mask'), d2.context.obj([0, 0, 0, 0, 0, 0]));
  input = Buffer.from(await d2.save()).toString('base64');

  const [img0] = await inspectImages(input);
  assert.ok(img0);
  assert.equal(img0.eligible, false);
  assert.equal(img0.skipReason, 'has /Mask');

  assert.equal(await reduce(input), input, 'masked image → nothing to do → verbatim');
});

test('mixed doc: eligible JPEG shrinks, CMYK passes through byte-identical', async () => {
  const doc = await PDFDocument.create();
  const p1 = doc.addPage([600, 450]);
  const p2 = doc.addPage([600, 450]);
  const rgb = await doc.embedJpg(await noisyJpg(3000, 2250));
  const cmyk = await doc.embedJpg(await cmykJpg(3000, 2250));
  p1.drawImage(rgb, { x: 0, y: 0, width: 600, height: 450 });
  p2.drawImage(cmyk, { x: 0, y: 0, width: 600, height: 450 });
  const input = Buffer.from(await doc.save()).toString('base64');

  const output = await reduce(input);
  assert.ok(b64Len(output) < b64Len(input), 'RGB image should shrink the file');

  // The CMYK image bytes are unchanged.
  const inDoc = await PDFDocument.load(Buffer.from(input, 'base64'));
  const outDoc = await PDFDocument.load(Buffer.from(output, 'base64'));
  const isCmyk = ({ obj }: ImageObj): boolean =>
    obj.dict.lookup(PDFName.of('ColorSpace')) === PDFName.of('DeviceCMYK');
  const cIn = imageObjects(inDoc).find(isCmyk);
  const cOut = imageObjects(outDoc).find(isCmyk);
  assert.ok(cIn && cOut, 'CMYK image present in both');
  assert.deepEqual(Buffer.from(cOut.obj.contents), Buffer.from(cIn.obj.contents));

  // Content streams identical across the whole doc.
  assert.deepEqual(await pageContentBytes(output), await pageContentBytes(input));
});

test('an image shared across two pages is re-encoded once', async () => {
  const doc = await PDFDocument.create();
  const img = await doc.embedJpg(await noisyJpg(3000, 2250));
  for (let i = 0; i < 2; i++) {
    doc.addPage([600, 450]).drawImage(img, { x: 0, y: 0, width: 600, height: 450 });
  }
  const input = Buffer.from(await doc.save()).toString('base64');

  const output = await reduce(input);
  assert.ok(b64Len(output) < b64Len(input), 'shared image should shrink the file');

  const out = await PDFDocument.load(Buffer.from(output, 'base64'));
  assert.equal(out.getPageCount(), 2);
  const imgs = imageObjects(out);
  assert.equal(imgs.length, 1, 'still a single shared image object');
  assert.ok(imgs[0]!.obj.dict.lookup(PDFName.of('Width'), PDFNumber).asNumber() <= 2000);
});
