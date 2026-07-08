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