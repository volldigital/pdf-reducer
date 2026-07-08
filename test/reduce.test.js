// Step 4 tests: DCTDecode re-encode + in-place replacement. Proves the file
// shrinks, that only image data changed (page content streams are byte-
// identical), that /Length stays consistent, and that modified images still
// decode.

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

import { reduce, inspectImages } from '../pdfSizeReducer.js';

/** A large, noisy JPEG that does not compress trivially, so downsampling
 * yields a real size reduction. */
// Larger than the default 2000px cap (like a real phone scan), so both
// downsampling and re-encoding contribute to a real size reduction.
const bigNoisyJpg = (w = 3000, h = 2250) =>
  sharp({
    create: { width: w, height: h, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 60 } },
  })
    .jpeg({ quality: 92 })
    .toBuffer();

const bigNoisyGrayJpg = (w = 3000, h = 2250) =>
  sharp({
    create: { width: w, height: h, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 60 } },
  })
    .toColourspace('b-w')
    .jpeg({ quality: 92 })
    .toBuffer();

async function pdfWithImage(jpgBuffer) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 450]);
  const img = await doc.embedJpg(jpgBuffer);
  page.drawImage(img, { x: 0, y: 0, width: 600, height: 450 });
  return Buffer.from(await doc.save()).toString('base64');
}

const b64Len = (s) => Buffer.from(s, 'base64').length;

/** Decoded content-stream bytes for every page, concatenated per page. */
async function pageContentBytes(base64) {
  const doc = await PDFDocument.load(Buffer.from(base64, 'base64'));
  return doc.getPages().map((page) => {
    const contents = page.node.Contents();
    const streams = contents instanceof PDFArray ? contents.asArray() : [contents];
    const chunks = streams.map((s) => {
      const stream = s instanceof PDFRawStream ? s : doc.context.lookup(s);
      return decodePDFRawStream(stream).decode();
    });
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('latin1');
  });
}

test('reduces an RGB-JPEG scan and only image data changes', async () => {
  const input = await pdfWithImage(await bigNoisyJpg());
  const output = await reduce(input);

  // Size actually went down.
  assert.ok(b64Len(output) < b64Len(input), 'output should be smaller');
  assert.notEqual(output, input);

  // Preservation: page content streams are byte-identical (we never touch them).
  assert.deepEqual(await pageContentBytes(output), await pageContentBytes(input));

  // Same page count.
  const inDoc = await PDFDocument.load(Buffer.from(input, 'base64'));
  const outDoc = await PDFDocument.load(Buffer.from(output, 'base64'));
  assert.equal(outDoc.getPageCount(), inDoc.getPageCount());
});

test('reduces a grayscale-JPEG scan and keeps it DeviceGray', async () => {
  const input = await pdfWithImage(await bigNoisyGrayJpg());
  const output = await reduce(input);

  assert.ok(b64Len(output) < b64Len(input), 'output should be smaller');
  const imgs = (await inspectImages(output)).filter((i) => i.filter === '/DCTDecode');
  assert.equal(imgs.length, 1);
  assert.equal(imgs[0].colorSpace, '/DeviceGray');
});

test('re-encoded image has consistent /Length and still decodes', async () => {
  const input = await pdfWithImage(await bigNoisyJpg());
  const output = await reduce(input);

  const doc = await PDFDocument.load(Buffer.from(output, 'base64'));
  let checked = 0;
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream && obj.dict.lookup(PDFName.of('Subtype')) === PDFName.of('Image')) {
      const length = obj.dict.lookup(PDFName.of('Length'), PDFNumber)?.asNumber();
      assert.equal(length, obj.contents.length, '/Length matches contents');
      // The stored bytes are still a valid JPEG.
      const meta = await sharp(Buffer.from(obj.contents)).metadata();
      assert.equal(meta.format, 'jpeg');
      assert.ok(meta.width <= 2000 && meta.height <= 2000, 'downsampled within cap');
      checked++;
    }
  }
  assert.equal(checked, 1);
});

test('an already-small image is left alone (smaller-only rule) → verbatim', async () => {
  // A tiny flat-color JPEG will not get smaller when re-encoded.
  const tiny = await sharp({
    create: { width: 32, height: 32, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .jpeg({ quality: 40 })
    .toBuffer();
  const input = await pdfWithImage(tiny);
  const output = await reduce(input);
  assert.equal(output, input, 'no improvement possible → original returned verbatim');
});