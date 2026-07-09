# pdf-reducer

Reduce the file size of user-uploaded PDFs — typically phone "scans" of
documents, which tend to be large — by re-compressing their embedded raster
images while preserving everything else.

The core is a single ESM module, [`pdfSizeReducer.js`](./pdfSizeReducer.js),
exposing one method: `reduce(base64Pdf)`. It is **surgical** — it re-encodes
only eligible embedded images and replaces each stream *in place at the same
object ref*, so text, AcroForm fields and values, the OCR text layer,
annotations, bookmarks, and structure round-trip untouched.

**Guarantee:** `reduce()` never throws and never returns a broken document. On
any problem — invalid input, an encrypted or signed PDF, or no achievable
saving — it returns the **original** base64 string unchanged.

For the full rationale, trade-offs, and the audit trail, see
[`DECISIONS.md`](./DECISIONS.md).

## Requirements

- Node.js ≥ 18
- Dependencies: [`pdf-lib`](https://www.npmjs.com/package/pdf-lib) (PDF
  parse/rewrite) and [`sharp`](https://www.npmjs.com/package/sharp) (JPEG
  resize/re-encode). Both are permissively licensed; the commercial licensing
  gate is enforced by `npm run licenses:check` (fails on AGPL/GPL).

```sh
npm install
```

## Embedding `pdfSizeReducer.js` in your application

This is the primary integration path. The public boundary is
**base64 string in → base64 string out** — no files, buffers, or paths.

```js
import { reduce } from './pdfSizeReducer.js';

// `base64Pdf` is whatever your upload layer already has as a base64 string.
const smaller = await reduce(base64Pdf);

// `smaller` may be a re-compressed PDF, or — if nothing could be improved —
// the exact original string you passed in. Either way it is a valid PDF.
```

### A realistic server-side example

```js
import { reduce } from './pdfSizeReducer.js';

// e.g. an Express-style handler receiving a file upload.
export async function handleUpload(req, res) {
  const originalBase64 = req.file.buffer.toString('base64');

  const reducedBase64 = await reduce(originalBase64);

  // Persist / forward the smaller version. It is safe to always use the
  // result: on failure or no-gain it is byte-identical to the input.
  const bytes = Buffer.from(reducedBase64, 'base64');
  await storage.put(req.file.id, bytes);

  const savedPct = 100 * (1 - reducedBase64.length / originalBase64.length);
  res.json({ id: req.file.id, savedPct: Math.max(0, savedPct).toFixed(1) });
}
```

### Tuning options

`reduce(base64Pdf, options?)` accepts an optional second argument. Unknown or
out-of-range values are clamped to safe bounds — it never throws on bad options.

| Option            | Default | Meaning                                                         |
| ----------------- | ------- | -------------------------------------------------------------- |
| `maxDimension`    | `2000`  | Cap on an image's longest side, in pixels (never upscales).    |
| `quality`         | `72`    | JPEG quality (mozjpeg), 1–100.                                 |
| `minSavingsRatio` | `0.95`  | Keep a re-encoded image only if it is ≤ 95% of the original.   |
| `concurrency`     | `4`     | Max images re-encoded in parallel (bounds peak memory).       |
| `useObjectStreams`| `true`  | pdf-lib save option (lossless).                                |

```js
// Smaller output, more aggressive downscaling:
const smaller = await reduce(base64Pdf, { maxDimension: 1500, quality: 60 });
```

The frozen defaults are exported as `DEFAULTS` if you want to read them:

```js
import { DEFAULTS } from './pdfSizeReducer.js';
```

### Read-only inspection

`inspectImages(base64Pdf)` lists every image XObject with the fields the
re-compression gate depends on and whether each is eligible — useful for
diagnostics and tests. It performs no mutation.

```js
import { inspectImages } from './pdfSizeReducer.js';
const rows = await inspectImages(base64Pdf);
// [{ ref, width, height, filter, colorSpace, eligible, skipReason, ... }]
```

## Command-line tools

Two small Node scripts wrap the module for local use. Both read from and write
to disk for convenience; the module itself stays string-in/string-out.

### `main.js` — reduce a PDF on disk

Reads a PDF, runs `reduce()`, and writes the result to a **copy** (the original
is never modified).

```sh
node main.js <input.pdf> [output.pdf]
```

- `output.pdf` defaults to `<input>.reduced.pdf` next to the input.
- Prints the input size, output size, and the percentage saved. If nothing
  could be improved, it writes an identical copy and says so.

```sh
$ node main.js 2.pdf
in : 2.pdf  (773.5 KB)
out: 2.reduced.pdf  (249.6 KB)
reduced by 67.7%
```

### `analyze.js` — diagnose *why* a PDF is large

`reduce()` only re-compresses raster images. When a PDF barely shrinks, the
weight lives elsewhere. `analyze.js` opens the PDF, attributes every byte to a
role (content stream, image, embedded font, metadata, …), and reports the
dominant contributor. It is **read-only** — it never writes or modifies the
input.

```sh
node analyze.js <input.pdf> [--json] [--top N] [--max-decode-mb N]
```

- `--json` — emit the full report as JSON instead of a formatted table.
- `--top N` — number of largest streams to list (default `12`).
- `--max-decode-mb N` — cap the content-stream operator scan (default `512`).

The report includes a byte breakdown by category (compressed **and** decoded
sizes), a content-stream operator profile that distinguishes *real text* from
*glyphs drawn as vector outlines*, an image-eligibility summary explaining what
`reduce()` could act on, and a plain-language diagnosis.

Example: `1.pdf` looks like a text document but barely reduces. The
tool shows why — it is 99% vector-path content streams with **no** text
operators and **no** embedded fonts (every glyph is a filled path), so there is
essentially nothing for the image reducer to touch.

## Commands

- `npm test` — run the test suite (`node --test`). Single file:
  `node --test test/e2e.test.js`.
- `npm run licenses` — production dependency license summary.
- `npm run licenses:check` — **fails on AGPL/GPL** in the production tree (the
  commercial licensing gate).

## How it works (in brief)

1. **Guard.** Encrypted or digitally signed PDFs are passed through untouched
   (re-saving would strip protection or invalidate signatures).
2. **Enumerate.** Collect every image XObject.
3. **Gate** (`canReencode`). Re-compress only single-filter DCTDecode images in
   DeviceRGB/DeviceGray with no `/Decode`, `/Mask`, `/Matte`, or image mask.
4. **Re-encode.** Downscale + JPEG re-encode eligible images with `sharp`, under
   bounded concurrency.
5. **Keep only if smaller**, replace in place, and save. Any error or
   non-improvement returns the original base64 verbatim.

See [`DECISIONS.md`](./DECISIONS.md) for the reasoning behind each choice.
