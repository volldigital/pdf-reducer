// Step 2 tests: I/O + guards. Every one of these inputs must come back
// byte-identical, because the skeleton changes nothing and the guards must
// pass problematic documents through untouched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';

import { reduce } from '../src/pdfSizeReducer.ts';

/** A minimal valid, image-free PDF (text only) as base64. */
async function makeTextPdfBase64(): Promise<string> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([200, 200]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('hello', { x: 20, y: 100, size: 24, font });
  const bytes = await doc.save({ useObjectStreams: true });
  return Buffer.from(bytes).toString('base64');
}

/** A valid PDF with an /Encrypt entry injected into the trailer, so a strict
 * load reports it as encrypted. */
async function makeEncryptedPdfBase64(): Promise<string> {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  // Presence of /Encrypt in the trailer is what triggers EncryptedPDFError on
  // load; the dict contents are irrelevant for that check.
  const encRef = doc.context.register(doc.context.obj({ Filter: 'Standard', V: 1, R: 2 }));
  doc.context.trailerInfo.Encrypt = encRef;
  const bytes = await doc.save({ useObjectStreams: false });
  return Buffer.from(bytes).toString('base64');
}

test('valid image-free PDF is returned byte-identical (no-op)', async () => {
  const input = await makeTextPdfBase64();
  const output = await reduce(input);
  assert.equal(output, input);
});

test('corrupt / non-PDF input is returned verbatim', async () => {
  const garbage = Buffer.from('this is definitely not a pdf').toString('base64');
  const output = await reduce(garbage);
  assert.equal(output, garbage);
});

test('empty string is returned verbatim', async () => {
  assert.equal(await reduce(''), '');
});

test('encrypted PDF is passed through untouched', async () => {
  const input = await makeEncryptedPdfBase64();
  // Sanity: confirm the fixture really is detected as encrypted by pdf-lib.
  await assert.rejects(PDFDocument.load(Buffer.from(input, 'base64')), /encrypted/i);
  const output = await reduce(input);
  assert.equal(output, input);
});

test('non-string input is returned as-is', async () => {
  // Deliberate contract misuse from untyped JS callers: reduce() must hand the
  // value straight back, so we bypass the string type on purpose.
  assert.equal(await reduce(undefined as unknown as string), undefined);
  assert.equal(await reduce(null as unknown as string), null);
});
