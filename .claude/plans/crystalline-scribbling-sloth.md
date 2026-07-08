# Plan: `pdfSizeReducer.js` — surgical image re-compression

## Context

`TASK.md` requires a JS helper `pdfSizeReducer.js` exposing `reduce(base64Pdf) → base64Pdf` to shrink large phone-**scanned** PDFs. This is a **commercial, closed-source** app, so no AGPL/GPL dependencies (rules out MuPDF/mupdf.js and any Ghostscript wrapper).

**Research outcome (Task 1–3):** phone scans are dominated by embedded raster images (usually `DCTDecode`/JPEG), so size reduction = downsampling + re-encoding those images. The only mainstream, maintained, **permissively-licensed** JS lib that can decode images inside an existing PDF is pdf.js (Apache-2.0) — but for the JPEG case we don't even need it, because a `DCTDecode` stream's bytes *are* a JPEG.

**User decisions (Task 4):**
- Runtime: **Node.js**.
- Approach: **B — surgical, structure-preserving.** Must preserve text, AcroForm fields + values, hidden OCR text layer, annotations, bookmarks, structure. Only image data may change.
- v1 image scope: **JPEG (`DCTDecode`) DeviceRGB/DeviceGray only**; pass everything else through untouched.
- Defaults: **Balanced** — max longest side ~2000px, JPEG quality ~72 (mozjpeg). Tunable per call.

**Approach confirmation:** the requirements do **not** change the approach category — it remains B — but v1 is realized as **pdf-lib + sharp, with pdf.js dropped** (pdf.js can't cleanly return a single image XObject's decoded bytes without rasterizing the whole page, which would defeat the surgical goal).

> ⚠️ Web verification was down during research; licenses are from Jan-2026 model knowledge (high-confidence, stable). Spot-check the key license URLs (pdf-lib MIT, sharp Apache-2.0 / libvips LGPL) before shipping.

## Stack & licenses (all permissive — commercial-safe)
- **pdf-lib** (MIT) — parse PDF, rewrite image XObject streams in place, re-serialize.
- **sharp** (Apache-2.0; bundles prebuilt libvips = LGPL as a dynamic lib, compliant; prebuilt binaries include mozjpeg, no system deps) — resize + JPEG re-encode.
- Dev-only: `node:test`, and a license scanner (e.g. `license-checker`) in CI to assert no GPL/AGPL in the resolved tree.

## Core algorithm

1. base64 → bytes.
2. **Guard:** if the PDF is **encrypted** (`PDFDocument.load` without `ignoreEncryption` throws `EncryptedPDFError`, or trailer has `/Encrypt`) or **digitally signed** (`/Sig` field or `/Perms`), return the **original base64 verbatim** (re-saving would strip encryption / break signatures).
3. `PDFDocument.load(bytes, { updateMetadata: false })`.
4. Enumerate image XObjects: `context.enumerateIndirectObjects()`, keep `PDFRawStream`s whose dict `Subtype === /Image` (use interned `PDFName.of('Image')` identity).
5. **Gate each image** — re-encode only if ALL hold: `Filter === DCTDecode` (single name, not a filter-chain array); `ColorSpace ∈ {DeviceRGB, DeviceGray}`; no `/Decode` array; not an `ImageMask`. Otherwise **pass through untouched**.
6. For gated images: `sharp(bytes).resize({ width/height clamped to maxDimension, fit:'inside', withoutEnlargement:true })`, `.grayscale()` when DeviceGray, `.jpeg({ quality, mozjpeg:true })`. **Do NOT call `sharp().rotate()`** (EXIF auto-rotate would desync the image from its content-stream CTM).
7. **Keep-only-if-smaller:** replace only when `newBytes.length <= original * 0.95`; else leave original. Wrap each image in its own try/catch so one bad image can't abort the run.
8. Replace in place: update dict `Width/Height/BitsPerComponent(8)/ColorSpace/Filter(DCTDecode)`, delete `DecodeParms`; `context.assign(ref, PDFRawStream.of(dict, newBytes))`. (`/Length` is set automatically by pdf-lib at write time — verify empirically.) Reusing the ref keeps every content-stream `Do` reference valid; shared images update everywhere at once.
9. **SMask:** a `/SMask` is a separate grayscale image object that appears on its own in the enumeration — re-encode it independently as grayscale, keep its `/SMask` link (preserved automatically). Skip if its filter isn't DCTDecode.
10. If **zero** images changed → return original base64 verbatim (don't re-save). Else `doc.save({ useObjectStreams:true })` → base64. Final guard: if output isn't smaller than input, return original.
11. **Any thrown error anywhere → return the original base64 unchanged** ("never return a broken document").

### Pass-through in v1 (by design, never corrupt)
DeviceCMYK (incl. inverted-CMYK/APP14 trap), ICCBased, Indexed, Separation, Lab, `/Decode` present, stencil/`ImageMask`, color-key `/Mask`, JBIG2/CCITTFax bilevel (JPEG would bloat/blur), JPXDecode, and Flate raw-sample images.

## Module design

Single ESM file `pdfSizeReducer.js`; `package.json` with `"type":"module"`, deps `pdf-lib` + `sharp`.

```
export async function reduce(base64Pdf, options = {}) // → Promise<string>
// options: { maxDimension = 2000, quality = 72, minSavingsRatio = 0.95, useObjectStreams = true }
```

Helpers: `toBytes`/`toBase64`, `isEncryptedOrSigned`, `collectImageStreams`, `readImageParams`, `canReencode` (the gate), `reencode`, `applyReencoded`. Bound memory with a small hand-rolled concurrency pool (~4) — no extra dependency.

## Files
- `pdfSizeReducer.js` (create) — the module.
- `package.json` (create) — ESM, deps, `test`/license scripts.
- `.gitignore` — add `node_modules` (currently only ignores `.idea`).
- `DECISIONS.md` (create) — record decisions + *why* (TASK.md requirement): Approach B, pdf-lib+sharp, no pdf.js, JPEG-RGB/Gray-only v1 scope, CMYK/ICC/bilevel pass-through, no CTM/DPI calc in v1, Balanced defaults, encrypted/signed pass-through.
- `CLAUDE.md` — update "Tooling status" with real `test`/lint commands once they exist.

## Execution — approval-gated steps (TASK.md: stop for approval at each; update `DECISIONS.md` each step)
1. **Scaffold & decisions.** `package.json`, `.gitignore`, seed `DECISIONS.md`.
2. **I/O + guards skeleton.** base64 decode/encode; encrypted/signed detection; top-level try/catch; no-op `reduce()` returning the original. Test: identity round-trip, corrupt input, encrypted input all return input verbatim.
3. **Enumeration + gating (read-only).** Collect image XObjects, extract params, apply `canReencode`; log candidates vs skips. No mutation. Test correct selection; CMYK/ICC/bilevel/masked skipped.
4. **DCTDecode re-encode + in-place replace + smaller-only rule** for RGB/Gray. Verify `/Length` auto-handling and content-stream byte-identity. Test size reduction + preservation.
5. **SMask handling** + finalize all pass-throughs.
6. **Options + hardening** (`maxDimension`, `quality`, `minSavingsRatio`, concurrency pool, final size guard, zero-change verbatim return).
7. **Full test suite + fixtures + license scan + docs.**

## Verification (end-to-end)
`node --test`. Fixtures: (a) RGB DCTDecode scan, (b) grayscale scan, (c) scan **with OCR text layer**, (d) **AcroForm with filled values**, (e) annotations + bookmarks, (f) CMYK/ICC (must pass through), (g) bilevel CCITT/JBIG2 (must pass through), (h) image with SMask, (i) encrypted PDF, (j) corrupt PDF.

Assertions:
- **Size:** output < input for compressible scans (a/b/c).
- **Byte-identical pass-through:** for (f)/(g) and text-only inputs, `reduce(x) === x` exactly.
- **Corrupt/encrypted:** `reduce(x) === x`, no throw.
- **Structure preservation (strongest proof):** equal page count; **every page's content-stream bytes byte-identical** input↔output; non-image indirect object set unchanged.
- **Form fields:** each field's low-level `/V` (read via object graph, not `getForm()`) identical input↔output.
- **OCR/text:** covered by content-stream byte-identity (dependency-free); optional pdf.js `getTextContent` cross-check (dev-only).
- **Annotations/bookmarks:** `/Annots` counts per page and outline entry count equal.
- **Image sanity:** modified images still decode via sharp; Width/Height/ColorSpace/BPC/Length self-consistent; SMask link present.
- **License gate (CI):** no GPL/AGPL in resolved dependency tree.
- Live-verify key license URLs once web tooling is restored.
