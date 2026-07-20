#!/usr/bin/env node
// bin/analyze.js
//
// Diagnose *why* a PDF is large. The reducer in pdfSizeReducer.js only touches
// embedded raster images; when a PDF barely shrinks, the weight lives somewhere
// else. This tool opens the PDF with pdf-lib, attributes every byte to a role
// (content stream, image, embedded font, metadata, ...), and prints a report
// pointing at the dominant contributor.
//
// Usage:
//   node bin/analyze.js <input.pdf> [--json] [--top N] [--max-decode-mb N]
//
// It is read-only: it never writes or modifies the input.

import { readFile } from 'node:fs/promises';

import { PDFDocument, EncryptedPDFError } from 'pdf-lib';

import { inspectImages } from '../pdfSizeReducer.js';
import { AnalyzeHelpers } from './analyzeHelpers.js';

async function main(): Promise<void> {
  const args = AnalyzeHelpers.parseArgs(process.argv.slice(2));
  if (!args.input) {
    console.error('Usage: node bin/analyze.js <input.pdf> [--json] [--top N] [--max-decode-mb N]');
    process.exit(1);
  }

  const bytes = new Uint8Array(await readFile(args.input));

  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (err) {
    if (err instanceof EncryptedPDFError) {
      console.error(
        `Cannot analyze: "${args.input}" is encrypted. pdf-lib refuses to open it for inspection.`,
      );
      process.exit(2);
    }
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`Cannot analyze: "${args.input}" is not a parseable PDF (${reason}).`);
    process.exit(2);
  }

  const report = AnalyzeHelpers.analyze(doc, bytes, args);

  // The image sub-report reuses the reducer's own eligibility gate, so the
  // report explains exactly why reduce() could or could not act.
  try {
    report.images = await inspectImages(Buffer.from(bytes).toString('base64'));
  } catch {
    report.images = [];
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    AnalyzeHelpers.printReport(report, args);
  }
}

main().catch((err: unknown) => {
  console.error('Failed:', err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
