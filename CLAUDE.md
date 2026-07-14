# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Goal

Build a JavaScript helper that reduces the file size of user-uploaded PDFs. The PDFs are typically phone "scans" of documents and are therefore large.

## Deliverable / API contract

- Source: `src/pdfSizeReducer.ts` (TypeScript), compiled to `dist/pdfSizeReducer.js` + `dist/pdfSizeReducer.d.ts` — the published entry point (`package.json` `main`/`types`/`exports`).
- Exposes one method: `reduce(base64Pdf)` — takes a base64-encoded PDF string and returns a base64-encoded string of the reduced PDF.

## Hard Constraints

- Language: TypeScript, authored in `src/` and compiled to ESM JavaScript + `.d.ts` type declarations in `dist/` (the published artifact). ESM-only — no dual CJS build.
- Both input and output are base64-encoded strings (not files, buffers, or paths at the public boundary).
- Prefer using libraries over hand-rolled code wherever possible.
- **Licensing is a gating requirement.** To keep the package permissively licensed (0BSD), copyleft/AGPL-encumbered dependencies are disqualified. Ghostscript (AGPL) is explicitly excluded. Verify every candidate library's license before adopting it.

## Working Process

Follow this ordered, approval-gated workflow strictly:

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

Single ESM module authored as `src/pdfSizeReducer.ts` and compiled to `dist/pdfSizeReducer.js` + `.d.ts` (deps: `pdf-lib` for PDF parse/rewrite, `sharp` for JPEG resize/re-encode). `reduce()` is **surgical**: it re-compresses only eligible embedded images and replaces each stream *in place at the same object ref*, so text, AcroForm fields/values, the OCR text layer, annotations, and structure round-trip untouched. Pipeline: guard (encrypted/signed → pass through) → enumerate image XObjects → `canReencode` gate (only single-filter DCTDecode DeviceRGB/DeviceGray, no `/Decode`/`/Mask`/`/Matte`/ImageMask) → bounded-concurrency sharp re-encode → keep only if smaller → save. Any error or non-improvement returns the **original** base64 verbatim. Full rationale and the audit trail live in `DECISIONS.md`.

The module also exports `inspectImages(base64Pdf)` — a read-only listing of every image XObject and whether the gate accepts it — plus the public types `ReduceOptions` and `ImageInspection`.

### Supporting files

- `src/bin/main.ts` → `dist/bin/main.js` — CLI wrapper (installed command `pdf-reducer`, or `node dist/bin/main.js <input.pdf> [output.pdf]` from a clone after `npm run build`): reads a PDF, runs `reduce()`, writes a copy (original untouched).
- `src/bin/analyze.ts` → `dist/bin/analyze.js` — read-only diagnostic (installed command `pdf-reducer-analyze`, or `node dist/bin/analyze.js <input.pdf> [--json] [--top N] [--max-decode-mb N]`). Attributes every byte to a role (content stream, image, embedded font, metadata, …) and reports the dominant contributor, including a content-stream operator profile that distinguishes real text from glyphs drawn as vector outlines. Reuses `inspectImages()` for the image-eligibility section. Explains why a "text-looking" PDF may not reduce.
- `README.md` — developer-facing usage for the module, both CLIs, and an embedding example.

## Build & tooling

- TypeScript authored in `src/`; two configs: `tsconfig.json` (strict base, type-checks `src/` + `test/`, `noEmit`) and `tsconfig.build.json` (emits `src/` → `dist/`, declarations + source maps).
- Tests are `.ts` under `test/`; they import `src/*.ts` directly and run via Node's native type-stripping — **no build step needed to test**.
- `dist/` is git-ignored; built on demand and by `prepublishOnly` at `npm publish`.

## Commands

- `npm run build` — compile `src/` → `dist/` (JS + `.d.ts` + source maps) via `tsc -p tsconfig.build.json`.
- `npm run typecheck` — strict type-check of `src/` + `test/`, no emit (`tsc -p tsconfig.json`).
- `npm test` — run the test suite (`node --test`, native TS type-stripping against `src/`). Single file: `node --test test/e2e.test.ts`.
- `npm run licenses` — production dependency license summary.
- `npm run licenses:check` — **fails the build on AGPL/GPL** in the production tree (the gate that keeps the dependency tree permissively licensed).

## Usage

```js
import { reduce } from '@disphere/pdf-reducer';
const smaller = await reduce(base64Pdf); // options: { maxDimension, quality, minSavingsRatio, concurrency }
```

See `README.md` for the full embedding guide and CLI usage.