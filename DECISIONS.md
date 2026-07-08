# Decisions Log

This file records the decisions made while building `pdfSizeReducer.js`, and **why**, per the rules in `TASK.md`. When a decision changes, add a new dated entry explaining what changed and why — do not silently overwrite history.

---

## 2026-07-08 — Step 1: Approach and stack

### D1. Approach: surgical, structure-preserving image re-compression (not rasterization)
**Decision:** Reduce size by re-compressing/downsampling only the embedded raster images, replacing each image object *in place* and leaving everything else byte-for-byte untouched.
**Why:** The user requires that text, AcroForm form fields **and their values**, the hidden OCR text layer, annotations, bookmarks, and overall structure survive reduction. Full-page rasterization (rendering each page to an image) would destroy all of that, so it was rejected. Phone scans are dominated by image bytes, so re-compressing images alone still yields the bulk of the savings.

### D2. Library stack: `pdf-lib` (MIT) + `sharp` (Apache-2.0)
**Decision:** Use `pdf-lib` to parse the PDF and rewrite image XObject streams in place, and `sharp` to resize + re-encode JPEGs.
**Why:** This is a **commercial, closed-source** application, so AGPL/GPL is disqualified — which rules out MuPDF/`mupdf.js` (AGPL) and every Ghostscript wrapper (AGPL). `pdf-lib` (MIT) and `sharp` (Apache-2.0) are both permissive. `sharp` bundles `libvips` (LGPL-2.1+) as a prebuilt dynamic library, which is LGPL-compliant for closed-source use, and its prebuilt binaries include `mozjpeg` (no system dependencies needed).
> Licensing was researched from model knowledge (web verification tooling was down at research time). These license facts are stable and high-confidence, but the key URLs (pdf-lib, sharp/libvips) should be live-verified before shipping.

### D3. Drop `pdf.js` from v1
**Decision:** Do not use `pdf.js`.
**Why:** For the JPEG (`DCTDecode`) case a stream's bytes already *are* a JPEG file, so no PDF-aware decoder is needed — `sharp` handles it directly. `pdf.js` has no clean API to return a single image XObject's decoded bytes without rasterizing the whole page (which would defeat the surgical goal). Reconsider only if a real corpus turns out to be dominated by a decodable non-JPEG filter.

### D4. v1 image scope: `DCTDecode` (JPEG), `DeviceRGB`/`DeviceGray` only
**Decision:** Only re-compress single-filter `DCTDecode` images in `DeviceRGB` or `DeviceGray` with no `/Decode` array and not used as an `ImageMask`. Everything else is **passed through untouched**.
**Why:** This is the dominant, high-payoff case for phone scans and is safe. Deliberately passed through to avoid corruption: DeviceCMYK (inverted-CMYK / Adobe APP14 trap), ICCBased, Indexed, Separation, Lab, images with `/Decode` arrays, stencil/color-key masks, bilevel CCITTFax/JBIG2 (JPEG would bloat and blur them), JPXDecode, and Flate raw-sample images. Broader coverage is deferred to v2 once v1 is proven.

### D5. Defaults: "Balanced"
**Decision:** `maxDimension = 2000` px (longest side), JPEG `quality = 72` with `mozjpeg`, only keep a re-encoded image if it is ≤ 95% of the original size. All tunable per call via `reduce(base64, options)`.
**Why:** ~2000px ≈ ~170 DPI on an A4/Letter page — a large size win while keeping text and scans visually clean. The "smaller-only" rule guarantees we never make an image (or the file) bigger.

### D6. Downsampling policy: max-dimension cap, no CTM/DPI computation in v1
**Decision:** Cap by absolute pixel dimensions rather than computing true on-page display DPI.
**Why:** Computing effective DPI requires tokenizing each page's content stream and tracking the graphics-state CTM — significant complexity and edge cases (Form XObject nesting, patterns). For phone scans (one near-full-page image per page) a max-dimension cap is within a few percent of a true DPI cap. A `targetDpi` mode is a clean v2 addition.

### D7. Never corrupt: guards and fail-safe
**Decision:** Return the **original** base64 unchanged whenever we cannot safely improve the file: on any thrown error; when the PDF is encrypted or digitally signed; when no image got smaller; or when the re-saved output is not smaller than the input. Each image is re-encoded inside its own try/catch so one bad image cannot abort the run.
**Why:** The overriding requirement is to never lose content or return a broken document. Encrypted PDFs can't be re-saved encrypted by pdf-lib (it would strip protection), and a full re-save invalidates digital signatures — so both are passed through untouched.

---

## 2026-07-08 — Step 2: I/O + guards skeleton

### D8. `reduce()` never throws; string-in / string-out
**Decision:** `reduce(base64Pdf, options)` is wrapped in a top-level try/catch that returns the original input on any failure. Non-string input is returned as-is. base64 decoding uses Node's lenient `Buffer.from(x, 'base64')`, so malformed input produces bytes that simply fail to parse as a PDF and are then passed through.
**Why:** Implements the "never return a broken document" contract (D7) at the boundary.

### D9. Encrypted detection via strict load; corrupt handled by the same path
**Decision:** Load with `PDFDocument.load(bytes, { updateMetadata: false })` **without** `ignoreEncryption`. `EncryptedPDFError` → return original. Any other load error (corrupt/non-PDF) → also return original.
**Why:** `/Encrypt` in the trailer makes pdf-lib throw `EncryptedPDFError`; using `ignoreEncryption` would decrypt and strip protection, which we must not do. `updateMetadata: false` avoids rewriting `/Info` ModDate.

### D10. Signature detection is conservative
**Decision:** `isSigned()` returns true on any of: `/Perms` in the catalog, AcroForm `SigFlags` bit 1, or a top-level field with `FT = /Sig`. If detection itself errors, treat as signed (pass through).
**Why:** Better to skip a possibly-signed document than to invalidate a real signature. This is a guard, not exhaustive signature parsing.

**Status:** skeleton implemented in `pdfSizeReducer.js`; the image pipeline is a no-op (`changedCount = 0`) so far. Tests in `test/guards.test.js` (5, all passing): image-free PDF round-trips byte-identical, corrupt/empty/non-string inputs return verbatim, and an encrypted fixture is passed through untouched.

---

## 2026-07-08 — Step 3: Enumeration + gating (read-only)

### D11. Enumerate images via `context.enumerateIndirectObjects()`; gate order matters
**Decision:** Collect image XObjects as top-level `PDFRawStream`s whose dict `Subtype === /Image`. The `canReencode` gate checks, in order: not `ImageMask` → no `/Decode` array → `Filter === /DCTDecode` (single name) → `ColorSpace ∈ {/DeviceRGB, /DeviceGray}` → has dimensions.
**Why:** Image streams are always top-level indirect objects (never nested in object streams), so enumeration reliably finds all of them, and replacing one at its ref keeps every content-stream `Do` reference valid. Added a read-only `inspectImages()` export for diagnostics/tests.

**Empirical findings (verified by tests, not assumptions):**
- pdf-lib's `embedJpg` adds an Adobe inversion `/Decode` array to **CMYK** JPEGs, so real-world CMYK scans are caught by the `/Decode` gate even before the colour-space gate — either way they are correctly skipped.
- pdf-lib **embeds images lazily** (only at `save()`), so an image object isn't in `doc.context` until the document has been saved once. (Affects how fixtures/mutations are built, and confirms that reading image bytes happens on a *loaded* doc.)

**Status:** `collectImageStreams`, `readImageParams`, `canReencode`, and `inspectImages` implemented; still no mutation of the document. Tests in `test/inspect.test.js` (7, all passing): RGB & Gray JPEGs eligible; CMYK, PNG/Flate, `/Decode`-tagged, and ImageMask images skipped; text-only PDF yields no images. Full suite: **12/12 passing**.

---

## 2026-07-08 — Step 4: DCTDecode re-encode + in-place replacement

### D12. Re-encode with sharp; replace in place at the same ref
**Decision:** For each eligible image: `sharp(bytes).resize({ width, height: maxDimension, fit:'inside', withoutEnlargement:true })`, `.grayscale()` when DeviceGray, `.jpeg({ quality, mozjpeg:true })`. Then update the dict (`Width/Height/BitsPerComponent=8/ColorSpace/Filter=DCTDecode`, delete `DecodeParms`) and `context.assign(ref, PDFRawStream.of(dict, newBytes))`. Keep the result only if `newBytes.length <= original.length * minSavingsRatio` (0.95). Each image is re-encoded inside its own try/catch.
**Why:** Reusing the ref keeps all content-stream `Do` references valid, so only image data changes. Confirmed empirically: pdf-lib recomputes `/Length` from the new contents at save time (we don't set it), and page **content-stream bytes are byte-identical** before/after (the preservation proof). No `.rotate()` — EXIF auto-rotate would desync pixels from the content-stream CTM.

### D13. Bug fix: typed `lookup(name, Type)` throws on missing key
**Decision:** Use `lookupMaybe(name, Type)` for all optional typed lookups (in `isSigned` and `numOf`).
**Why (root cause):** pdf-lib's typed `lookup(name, PDFDict)` *throws* when the key is absent rather than returning undefined. `isSigned()` therefore threw on every PDF without an `/AcroForm`; its conservative catch returned `true`, so `reduce()` treated every image PDF as "signed" and returned the original unchanged. This was a latent Step 2 defect that only surfaced once `reduce` actually processed images. `lookupMaybe` returns undefined on a missing/mismatched key.

**Status:** re-encode pipeline live in `reduce()`. Tests in `test/reduce.test.js` (4, all passing): a large RGB scan shrinks with page content streams byte-identical and page count preserved; a grayscale scan shrinks and stays DeviceGray; re-encoded images have consistent `/Length`, still decode as JPEG, and respect the dimension cap; an already-small image triggers the smaller-only rule and returns the original verbatim. Full suite: **16/16 passing**.