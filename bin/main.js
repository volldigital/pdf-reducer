// Small CLI to try the reducer on a real file:
//
//   node bin/main.js <input.pdf> [output.pdf]
//
// Reads the PDF from disk, runs reduce(), and writes the result to a COPY
// (defaults to "<input>.reduced.pdf") — the original is never modified.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { reduce } from '../pdfSizeReducer.js';

const fmtKB = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

async function main() {
  const [inputPath, outputArg] = process.argv.slice(2);
  if (!inputPath) {
    console.error('Usage: node bin/main.js <input.pdf> [output.pdf]');
    process.exit(1);
  }

  const outputPath =
    outputArg ??
    path.join(
      path.dirname(inputPath),
      `${path.basename(inputPath, path.extname(inputPath))}.reduced.pdf`,
    );

  const inputBytes = await readFile(inputPath);
  const reducedBase64 = await reduce(inputBytes.toString('base64'));
  const outputBytes = Buffer.from(reducedBase64, 'base64');
  await writeFile(outputPath, outputBytes);

  const saved = 1 - outputBytes.length / inputBytes.length;
  console.log(`in : ${inputPath}  (${fmtKB(inputBytes.length)})`);
  console.log(`out: ${outputPath}  (${fmtKB(outputBytes.length)})`);
  console.log(
    saved > 0
      ? `reduced by ${(saved * 100).toFixed(1)}%`
      : 'no reduction possible — wrote an identical copy',
  );
}

main().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
