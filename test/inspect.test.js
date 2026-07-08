// Step 3 tests: read-only enumeration + gating. Verifies that inspectImages()
// finds every image XObject and that the canReencode gate accepts only
// DCTDecode DeviceRGB/DeviceGray and skips everything else.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { PDFDocument, PDFName, PDFBool, PDFRawStream } from 'pdf-lib';

import { inspectImages } from '../pdfSizeReducer.js';

const W = 240;
const H = 160;

const rgbJpg = () =>
  sharp({ create: { width: W, height: H, channels: 3, background: { r: 200, g: 120, b: 40 } } })
    .jpeg()
    .toBuffer();

// Force a single-channel (DeviceGray) JPEG.
const grayJpg = () =>
  sharp({ create: { width: W, height: H, channels: 3, background: { r: 128, g: 128, b: 128 } } })
    .toColourspace('b-w')
    .jpeg()
    .toBuffer();

const cmykJpg = () =>
  sharp({ create: { width: W, height: H, channels: 3, background: { r: 10, g: 20, b: 30 } } })
    .toColourspace('cmyk')
    .jpeg()
    .toBuffer();

const rgbPng = () =>
  sharp({ create: { width: 80, height: 80, channels: 3, background: { r: 1, g: 2, b: 3 } } })
    .png()
    .toBuffer();

/** Build a single-image PDF and return its base64. */
async function pdfWith(embed) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([W, H]);
  const img = await embed(doc);
  page.drawImage(img, { x: 0, y: 0, width: W, height: H });
  return Buffer.from(await doc.save()).toString('base64');
}

/** Reload a PDF, set a key on the first image XObject's dict, and re-save.
 * Needed because pdf-lib embeds images lazily (only at save time), so the
 * image object doesn't exist in the context until the doc is saved once. */
async function mutateFirstImage(base64, key, value) {
  const doc = await PDFDocument.load(Buffer.from(base64, 'base64'));
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream && obj.dict.lookup(PDFName.of('Subtype')) === PDFName.of('Image')) {
      obj.dict.set(PDFName.of(key), value(doc));
      break;
    }
  }
  return Buffer.from(await doc.save()).toString('base64');
}

test('DCTDecode DeviceRGB JPEG is eligible', async () => {
  const base64 = await pdfWith(async (d) => d.embedJpg(await rgbJpg()));
  const imgs = (await inspectImages(base64)).filter((i) => i.filter === '/DCTDecode');
  assert.equal(imgs.length, 1);
  assert.equal(imgs[0].colorSpace, '/DeviceRGB');
  assert.equal(imgs[0].eligible, true);
  assert.equal(imgs[0].skipReason, null);
});

test('DCTDecode DeviceGray JPEG is eligible', async () => {
  const base64 = await pdfWith(async (d) => d.embedJpg(await grayJpg()));
  const imgs = (await inspectImages(base64)).filter((i) => i.filter === '/DCTDecode');
  assert.equal(imgs.length, 1);
  assert.equal(imgs[0].colorSpace, '/DeviceGray');
  assert.equal(imgs[0].eligible, true);
});

test('DeviceCMYK JPEG is skipped', async () => {
  const base64 = await pdfWith(async (d) => d.embedJpg(await cmykJpg()));
  const img = (await inspectImages(base64)).find((i) => i.colorSpace === '/DeviceCMYK');
  assert.ok(img, 'expected a CMYK image');
  assert.equal(img.eligible, false);
  assert.ok(img.skipReason, 'expected a skip reason');
});

test('FlateDecode (PNG) image is skipped (filter not DCTDecode)', async () => {
  const base64 = await pdfWith(async (d) => d.embedPng(await rgbPng()));
  const imgs = await inspectImages(base64);
  assert.equal(imgs.length, 1);
  assert.equal(imgs[0].eligible, false);
  assert.equal(imgs[0].skipReason, 'filter is not a single DCTDecode');
});

test('a /Decode array disqualifies an otherwise-eligible JPEG', async () => {
  let base64 = await pdfWith(async (d) => d.embedJpg(await rgbJpg()));
  base64 = await mutateFirstImage(base64, 'Decode', (d) => d.context.obj([1, 0, 1, 0, 1, 0]));

  const img = (await inspectImages(base64)).find((i) => i.filter === '/DCTDecode');
  assert.equal(img.hasDecode, true);
  assert.equal(img.eligible, false);
  assert.equal(img.skipReason, 'has /Decode array');
});

test('an ImageMask is skipped', async () => {
  let base64 = await pdfWith(async (d) => d.embedJpg(await rgbJpg()));
  base64 = await mutateFirstImage(base64, 'ImageMask', () => PDFBool.True);

  const img = (await inspectImages(base64)).find((i) => i.isImageMask);
  assert.ok(img, 'expected an image mask');
  assert.equal(img.eligible, false);
  assert.equal(img.skipReason, 'image mask');
});

test('a text-only PDF yields no image XObjects', async () => {
  const doc = await PDFDocument.create();
  doc.addPage([100, 100]);
  const base64 = Buffer.from(await doc.save()).toString('base64');
  assert.deepEqual(await inspectImages(base64), []);
});