// Step 6 tests: option validation/clamping, the smaller-only knob, robustness
// to bad options, and multi-image concurrency.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFArray,
  decodePDFRawStream,
} from 'pdf-lib';

import { reduce, inspectImages, type ReduceOptions } from '../src/pdfSizeReducer.ts';

const noisyJpg = (w: number, h: number): Promise<Buffer> =>
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

async function pdfWithImages(count: number): Promise<string> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < count; i++) {
    // Distinct sizes so each is a separate object and each is > the cap.
    const img = await doc.embedJpg(await noisyJpg(2600 + i * 40, 2000 + i * 30));
    doc.addPage([600, 450]).drawImage(img, { x: 0, y: 0, width: 600, height: 450 });
  }
  return Buffer.from(await doc.save()).toString('base64');
}

async function firstImageWidth(base64: string): Promise<number | undefined> {
  const imgs = (await inspectImages(base64)).filter((i) => i.filter === '/DCTDecode');
  return imgs[0]?.width;
}

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

test('maxDimension option caps the output resolution', async () => {
  const input = await pdfWithImages(1);
  const output = await reduce(input, { maxDimension: 800, quality: 60 });
  assert.ok((await firstImageWidth(output))! <= 800);
});

test('a smaller maxDimension yields a smaller file than the default', async () => {
  const input = await pdfWithImages(1);
  const big = await reduce(input); // default 2000
  const small = await reduce(input, { maxDimension: 600 });
  assert.ok(b64Len(small) < b64Len(big));
});

test('out-of-range options are clamped, not thrown', async () => {
  const input = await pdfWithImages(1);
  // quality 999 and negative maxDimension: must not throw, must stay valid.
  const output = await reduce(input, { quality: 999, maxDimension: -50 });
  assert.equal(typeof output, 'string');
  await assert.doesNotReject(PDFDocument.load(Buffer.from(output, 'base64')));
});

test('non-object options are ignored (defaults used)', async () => {
  const input = await pdfWithImages(1);
  // Deliberate misuse from untyped callers: non-object options must be ignored.
  assert.equal(await reduce(input, null as unknown as ReduceOptions), await reduce(input));
  assert.equal(await reduce(input, 'nonsense' as unknown as ReduceOptions), await reduce(input));
});

test('minSavingsRatio = 0 keeps nothing → original returned verbatim', async () => {
  const input = await pdfWithImages(1);
  // Sanity: with defaults it does reduce.
  assert.notEqual(await reduce(input), input);
  // With ratio 0, no re-encode is ever "small enough", so nothing changes.
  assert.equal(await reduce(input, { minSavingsRatio: 0 }), input);
});

test('multi-image PDF: all images re-encoded under a concurrency pool', async () => {
  const input = await pdfWithImages(5);
  const output = await reduce(input, { concurrency: 4 });

  assert.ok(b64Len(output) < b64Len(input));
  const imgs = (await inspectImages(output)).filter((i) => i.filter === '/DCTDecode');
  assert.equal(imgs.length, 5);
  for (const img of imgs) assert.ok(img.width! <= 2000, 'each image downsampled within cap');

  // Preservation holds across all pages.
  assert.deepEqual(await pageContentBytes(output), await pageContentBytes(input));
});

test('concurrency = 1 and concurrency = 8 produce the same result', async () => {
  const input = await pdfWithImages(4);
  const seq = await reduce(input, { concurrency: 1 });
  const par = await reduce(input, { concurrency: 8 });
  assert.equal(seq, par);
});
