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
> Licensing was researched from model knowledge (web verification tooling was down at research time). **Verified on-disk at Step 7** against the actually-installed packages: `pdf-lib` = MIT, `sharp` = Apache-2.0, `@img/sharp-libvips-linux-x64` (bundled libvips) = LGPL-3.0-or-later — a separate prebuilt shared library loaded at runtime (dynamic linking, replaceable), which satisfies LGPL for closed-source commercial use. The `npm run licenses:check` gate confirms no AGPL/GPL in the production tree.

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

---

## 2026-07-08 — Step 5: SMask handling + finalized pass-throughs

### D14. SMask images are handled by the existing pipeline; no special case needed
**Decision:** A soft mask (`/SMask`) is a *separate* DeviceGray image XObject, so it is enumerated and gated like any other image: if it is DCTDecode DeviceGray it is re-encoded as grayscale; otherwise (typically FlateDecode) it is passed through. Replacing it in place at its own ref keeps the base image's `/SMask` link valid automatically. A base image's own re-encode is independent of its SMask (JPEG has no alpha), so the two can be downsampled independently — the PDF maps both to the unit square, so differing result dimensions are spec-valid.
**Why:** No bespoke SMask code is required; the surgical in-place model already does the right thing. Verified by test: base RGB + a DeviceGray DCT SMask → both downsampled, `/SMask` link preserved, mask still DeviceGray.

### D15. Also pass through images carrying `/Mask` or `/Matte`
**Decision:** Extend the gate to skip any image with a `/Mask` (color-key ranges or stencil-mask stream) or `/Matte` (pre-blended soft-mask matte).
**Why:** Color-key masking keys on exact sample values, and matte samples are pre-blended against a matte colour — re-encoding (quality change + downsample) shifts those values and would break the masking/blend. Safe pass-through, consistent with D4/D7.

**Status:** gate extended (`hasMask`/`hasMatte`); SMask handling confirmed. Tests in `test/masks.test.js` (4, all passing): grayscale DCT SMask re-encoded with link preserved; `/Mask` image skipped and returned verbatim; mixed RGB+CMYK doc shrinks the RGB while the CMYK bytes stay byte-identical and content streams are unchanged; an image shared across two pages is re-encoded exactly once. Full suite: **20/20 passing**.

---

## 2026-07-08 — Step 6: Options + hardening

### D16. Options are validated and clamped, never trusted blindly
**Decision:** `normalizeOptions()` coerces caller input: `maxDimension ≥ 16`, `quality ∈ [1,100]`, `minSavingsRatio ∈ [0,1]`, `concurrency ≥ 1`, `useObjectStreams` boolean. Non-object `options` (null, string, …) are ignored and DEFAULTS used.
**Why:** Keeps the "never throw" contract even with bad input, and makes the knobs safe to expose to callers. `minSavingsRatio = 0` is a valid way to force a no-op (nothing is ever "small enough").

### D17. Bounded-concurrency re-encode; mutation applied sequentially
**Decision:** Collect eligible images, re-encode them through a `mapWithConcurrency` pool (default 4 in flight), then apply the kept results to the pdf-lib context sequentially.
**Why:** The expensive native sharp work runs in parallel (throughput) while memory stays bounded to ~`concurrency` decoded images. Applying mutations sequentially keeps document mutation simple and order-deterministic — verified that `concurrency: 1` and `concurrency: 8` produce byte-identical output.

**Status:** implemented `normalizeOptions` + `mapWithConcurrency`; `concurrency` added to DEFAULTS. Tests in `test/options.test.js` (7, all passing): `maxDimension` caps resolution and a smaller cap yields a smaller file; out-of-range options are clamped (no throw, valid PDF); non-object options fall back to defaults; `minSavingsRatio = 0` returns the original verbatim; a 5-image PDF is fully re-encoded under the pool with content streams preserved; concurrency 1 vs 8 are identical. Full suite: **27/27 passing**.

---

## 2026-07-08 — Step 7: Full suite, e2e fixtures, license gate, docs

### D18. Preservation proven end-to-end on a realistic document
**Decision:** Add `test/e2e.test.js` exercising a scan-like PDF (large image + invisible opacity-0 OCR text + a filled AcroForm text field with a widget annotation).
**Why:** Directly proves the headline requirement. After `reduce()`: the file shrinks; the form field's value reads back identical; annotation count per page is unchanged; page content streams are byte-identical (so the invisible OCR text — stored as a `<hex> Tj` literal — survives verbatim); the image is downsampled. Also proven: a second `reduce()` pass is a no-op (stable), and filter-chain `[FlateDecode DCTDecode]` and `CCITTFaxDecode` images are skipped.

### D19. License gate verified; licenses confirmed on-disk
**Decision:** `npm run licenses:check` fails on AGPL/GPL; run in CI. Licenses verified against installed packages (see D2 note).
**Why:** Enforces the commercial licensing constraint automatically going forward.

### Docs
`CLAUDE.md` "Tooling status" replaced with real **Architecture**, **Commands** (`npm test`, `npm run licenses[:check]`), and **Usage** sections.

**Final status:** implementation complete. Full suite **31/31 passing** across `test/{guards,inspect,reduce,masks,options,e2e}.test.js`. License gate: **no AGPL/GPL** in the production tree.

---

## 2026-07-09 — Open-sourcing the repository

The project is being open-sourced on GitHub (`volldigital/pdf-reducer`) and published to npm for reuse, using trunk-based development. The decisions below were made with the user; the driving brief is `OPEN_SOURCE_TASK.md`.

### D20. License: `0BSD` (BSD Zero Clause)
**Decision:** Release the project's own code under **0BSD**.
**Why:** The brief asked for "the most permissive license possible, given the current dependencies." The production tree is entirely permissive (MIT / Apache-2.0 / ISC / 0BSD / MIT-AND-Zlib) plus a single **dynamically-linked** LGPL-3.0-or-later library (bundled libvips via `sharp`), which does not impose copyleft on a caller — so any permissive license was available. 0BSD is the literal maximum: public-domain-equivalent, OSI-approved, a valid SPDX id, and — unlike MIT — it imposes **no attribution or notice-retention obligation** on consumers. Precedent: `tslib`, already in this project's dependency tree, is 0BSD, so scanners recognise it. Trade-off accepted: no explicit patent grant (neither has MIT) and it is less ubiquitous than MIT. Copyright line: `Copyright (C) 2026 disphere interactive GmbH`.

### D21. Artifact host: npm public registry
**Decision:** Publish to the public npm registry (`registry.npmjs.org`), not GitHub Packages.
**Why:** For a reusable open-source library the consumer experience dominates. npm public means `npm install pdf-reducer` with zero config and no authentication. GitHub Packages would force every consumer — even for a public package — into a scoped name, an `.npmrc`, and an auth token, which is an adoption barrier that defeats the point of open-sourcing. GitHub Packages' only edge (publish via the built-in `GITHUB_TOKEN`) does not outweigh that consumer friction. The name `pdf-reducer` was verified **available** (registry 404) so no scope is needed.

### D22. Publish trigger: manual `workflow_dispatch`, not on-push
**Decision:** Releases are triggered manually via a `workflow_dispatch` "Release" workflow with a version input; pushes to `main`/`feature/*` and PRs run **build + test only**.
**Why:** The brief floated "publish on push to `main`," but npm rejects republishing an existing version, so on-every-push publishing fails on the first push after any release unless a version is auto-bumped first — extra machinery and misfire risk. Manual dispatch keeps the maintainer as the version authority with a one-button release (`patch`/`minor`/`major` or explicit semver → bump, tag, publish), while still satisfying the "build/test on push" requirement for feature branches.

### D23. Publish auth: npm Trusted Publishing (OIDC) — required
**Decision:** Authentication for publishing uses **npm Trusted Publishing (OIDC)**; no long-lived `NPM_TOKEN` is stored in the repository.
**Why:** OIDC removes the stored-secret attack surface and token-rotation chore, and attaches build **provenance** automatically. Bootstrap constraint documented for execution: npm can only attach a trusted publisher to a package that **already exists**, so the first publish creates the package name once (locally, with 2FA), after which every automated release runs through the workflow via OIDC. Requires npm ≥ 11.5.1 in the release job.

### D24. Scaffolding scope: essentials now, community docs deferred
**Decision:** This pass adds only `LICENSE`, CI workflows, `package.json` publish-metadata fixes, and `README`/`CLAUDE` doc fixes. `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, and issue/PR templates are deferred.
**Why:** Ship the legally- and technically-necessary changes to publish now; add community-health files when the first external contributor makes them worthwhile, avoiding speculative ceremony for a small utility library.

### D25. Pre-flight facts (recorded for auditability)
- **Copyright holder:** `disphere interactive GmbH`, year `2026`.
- **npm name:** `pdf-reducer` — available (unscoped).
- **GitHub repo:** `https://github.com/volldigital/pdf-reducer` (no git remote configured yet at time of writing).
- **History audit:** no `examples/` or `*.pdf` were ever committed; no credential/private-key patterns found in history. Note: a stray internal planning file (`.claude/plans/crystalline-scribbling-sloth.md`) exists in git history (not in the current tree) and would be visible once public — not sensitive; history rewrite is optional.