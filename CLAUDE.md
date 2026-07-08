# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Goal

Build a JavaScript helper that reduces the file size of user-uploaded PDFs. The PDFs are typically phone "scans" of documents and are therefore large. See `TASK.md` for the authoritative spec.

## Deliverable / API contract

- Single output file: `pdfSizeReducer.js`.
- Exposes one method: `reduce(base64Pdf)` — takes a base64-encoded PDF string and returns a base64-encoded string of the reduced PDF.

## Hard Constraints

- Language: JavaScript.
- Both input and output are base64-encoded strings (not files, buffers, or paths at the public boundary).
- Prefer using libraries over hand-rolled code wherever possible.
- **Licensing is a gating requirement.** This is a commercial application, so copyleft/AGPL-encumbered dependencies are disqualified. Ghostscript (AGPL) is explicitly excluded. Verify every candidate library's license before adopting it.

## Working Process

`TASK.md` defines an ordered, approval-gated workflow. Follow it strictly:

1. Research adequate libraries.
2. Weigh pros and cons of each.
3. Present an overview of resulting approaches with pros/cons for the user to choose from.
4. Refine the chosen approach together with the user.
5. Write an implementation plan.
6. Execute step by step, waiting for approval at each step.

Rules that govern how to work here:

- **Never assume.** Research thoroughly and ask the user when anything is unclear or ambiguous.
- **Never advance a step without explicit approval** of the current one — the user may review results and request changes that affect the remaining plan.
- **Document continuously.** Record progress and every decision, including *why* it was made. When a decision changes, document what changed and why so the reasoning stays auditable.

## Architecture

Single ESM module `pdfSizeReducer.js` (deps: `pdf-lib` for PDF parse/rewrite, `sharp` for JPEG resize/re-encode). `reduce()` is **surgical**: it re-compresses only eligible embedded images and replaces each stream *in place at the same object ref*, so text, AcroForm fields/values, the OCR text layer, annotations, and structure round-trip untouched. Pipeline: guard (encrypted/signed → pass through) → enumerate image XObjects → `canReencode` gate (only single-filter DCTDecode DeviceRGB/DeviceGray, no `/Decode`/`/Mask`/`/Matte`/ImageMask) → bounded-concurrency sharp re-encode → keep only if smaller → save. Any error or non-improvement returns the **original** base64 verbatim. Full rationale and the audit trail live in `DECISIONS.md`.

The module also exports `inspectImages(base64Pdf)` — a read-only listing of every image XObject and whether the gate accepts it.

### Supporting files

- `main.js` — CLI wrapper: `node main.js <input.pdf> [output.pdf]` reads a PDF, runs `reduce()`, writes a copy (original untouched).
- `analyze.js` — read-only diagnostic: `node analyze.js <input.pdf> [--json] [--top N] [--max-decode-mb N]`. Attributes every byte to a role (content stream, image, embedded font, metadata, …) and reports the dominant contributor, including a content-stream operator profile that distinguishes real text from glyphs drawn as vector outlines. Reuses `inspectImages()` for the image-eligibility section. Explains why a "text-looking" PDF may not reduce.
- `README.md` — developer-facing usage for the module, `main.js`, and `analyze.js`, plus an embedding example.

## Commands

- `npm test` — run the test suite (`node --test`, no extra runner). Single file: `node --test test/e2e.test.js`.
- `npm run licenses` — production dependency license summary.
- `npm run licenses:check` — **fails the build on AGPL/GPL** in the production tree (the commercial licensing gate).

## Usage

```js
import { reduce } from './pdfSizeReducer.js';
const smaller = await reduce(base64Pdf); // options: { maxDimension, quality, minSavingsRatio, concurrency }
```

See `README.md` for the full embedding guide and CLI usage.