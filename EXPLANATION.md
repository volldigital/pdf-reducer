# How `pdfSizeReducer.js` Works — and Enough PDF Internals to Follow It

This document explains what `pdfSizeReducer.js` does and *why*, by teaching just
enough about the internal structure of a PDF to make the code readable.

It is written to be read **top-down and stopped at any point**. Each section is
more specific than the last:

1. [The one-paragraph version](#1-the-one-paragraph-version) — the whole idea.
2. [What a PDF actually is](#2-what-a-pdf-actually-is) — the mental model you need.
3. [The pipeline, end to end](#3-the-pipeline-end-to-end) — how `reduce()` is shaped.
4. [Reading the PDF's object graph](#4-reading-the-pdfs-object-graph) — finding the images.
5. [The eligibility gate](#5-the-eligibility-gate-canreencode) — the safety rules, one by one.
6. [Re-encoding and in-place replacement](#6-re-encoding-and-in-place-replacement) — the actual size win.
7. [The guards: never return a broken document](#7-the-guards-never-return-a-broken-document) — encryption & signatures.
8. [Appendix: spec & library links](#8-appendix-specifications-and-library-references) — for a deep dive.

Stop whenever you have what you came for. Sections 1–3 give you the whole shape;
4–7 are the details behind each part.

---

## 1. The one-paragraph version

A phone "scan" PDF is mostly one big JPEG photo per page (plus, often, an
invisible text layer from OCR). The photos are far larger than they need to be.
`reduce()` opens the PDF, finds each embedded JPEG, shrinks and re-compresses it
with an image library, and **writes the smaller JPEG back into the exact same
slot** it came from. Everything that is *not* a re-compressible photo — text,
form fields and their values, the OCR layer, annotations, bookmarks — is left
completely alone. If anything looks risky or the result isn't actually smaller,
it hands you back the original bytes unchanged. That "surgical, or nothing"
stance is the whole design.

---

## 2. What a PDF actually is

> Your mental model — "a glorified ZIP of images and fonts" — is a good instinct
> for *what's inside*, but the *container* is different, and that difference is
> exactly what this code exploits. Let's fix the model.

A PDF is **not** a ZIP. A ZIP is a flat list of named, independently-compressed
files. A PDF is a **graph of objects** with cross-references between them — much
closer to a small on-disk database or a serialized object heap than to an
archive. The format is defined by the ISO 32000 standard (see the
[appendix](#8-appendix-specifications-and-library-references) for the free PDF of
the spec).

### 2.1 The eight object types (the "COS" layer)

At the bottom, a PDF is built from a handful of primitive object types. The
`pdf-lib` library gives each one a class, and you'll see them imported at the top
of the module (`pdfSizeReducer.js:17-26`):

| PDF object | What it is | `pdf-lib` class |
|---|---|---|
| Boolean | `true` / `false` | `PDFBool` |
| Number | `42`, `3.14` | `PDFNumber` |
| Name | `/Image`, `/DCTDecode` — an identifier, always starts with `/` | `PDFName` |
| String | `(text)` or `<hex>` | (various) |
| Array | `[ 1 2 3 ]` | `PDFArray` |
| Dictionary | `<< /Key value ... >>` — a key→value map | `PDFDict` |
| Stream | a dictionary **plus** a blob of raw bytes | `PDFRawStream` |
| Null | `null` | — |

The two that matter most here are the **dictionary** and the **stream**.

- A **dictionary** is a map from Name keys to values. It's how a PDF describes
  *properties* of a thing.
- A **stream** is a dictionary followed by an arbitrary byte payload. It's how a
  PDF stores *bulk data*: the pixels of an image, the drawing commands of a page,
  the glyph outlines of a font. The dictionary describes the bytes (how long,
  how compressed, what they mean); the bytes are the actual content.

**An embedded image is a stream.** Its dictionary says "I'm an image, I'm 3000×4000
pixels, my bytes are JPEG-compressed, my colours are RGB"; its byte payload *is*
the JPEG. That single fact is what makes this whole tool possible — see §6.

### 2.2 Indirect objects and references (the "graph" part)

Any object can be given a number and declared a top-level **indirect object**:

```
12 0 obj
<< /Type /XObject /Subtype /Image ... >>
stream
...JPEG bytes...
endstream
endobj
```

Here `12 0` is the object's identity ("object 12, generation 0"). Other objects
refer to it by writing `12 0 R` (an **indirect reference**). This is the "graph":
objects point at each other by reference number, and the same object can be
pointed to from many places (e.g. one logo image reused on every page).

This is the single most important structural fact for understanding the code:

> Because an image lives at a stable reference like `12 0`, we can **replace the
> bytes at that reference** with a smaller JPEG, and every page that said "draw
> object 12 here" automatically draws the new, smaller image. Nothing else has to
> change. The code leans on this in `applyReencoded` (`pdfSizeReducer.js:237-245`).

### 2.3 How the objects hang together (the document tree)

Objects reference each other into a tree rooted at the **Catalog**:

```
Trailer  ──▶  Catalog (/Root)
                 └─▶ Page Tree (/Pages)
                       └─▶ Page ──▶ /Contents  (a content stream: the drawing commands)
                                └─▶ /Resources ──▶ /XObject ──▶ /Im0 = 12 0 R  (our image!)
```

- The **trailer** at the end of the file points to the Catalog and to the
  cross-reference table (the index of where every object lives in the file).
- A **content stream** (a Page's `/Contents`) is a little program of drawing
  operators: move here, set this font, show this text, and crucially
  **`/Im0 Do`** — "paint the XObject named `/Im0`". `/Im0` resolves through the
  page's `/Resources` to `12 0 R`, our image stream.

The reason the tool can keep text and the OCR layer perfectly intact is that the
text lives in these **content streams** as operators (e.g. a `Tj`
"show text" operator with the string bytes), completely separate from the image
streams. We never touch content streams, so the text rides through untouched.
`DECISIONS.md` D18 records the end-to-end proof that page content streams come
out **byte-identical**.

### 2.4 Object streams — and why images are never in them

Modern PDFs can pack many small objects (dictionaries, etc.) into a compressed
**object stream** to save space. This matters here for one reason: **image data
streams are never stored inside object streams** — a stream object is always a
top-level indirect object. That's what lets the code find every image with a
single flat enumeration and no recursion (§4, and `DECISIONS.md` D11).

---

## 3. The pipeline, end to end

With the model in place, the whole of `reduce()` (`pdfSizeReducer.js:62-134`)
reads as a short pipeline. Here is the shape, with the guarantees called out:

```
reduce(base64Pdf)
  ├─ not a string?            → return input as-is            (line 64)
  ├─ base64 → bytes                                            (line 69)
  ├─ load with pdf-lib (strict)                                (line 78)
  │     ├─ encrypted?         → return ORIGINAL                (line 80)
  │     └─ corrupt/not a PDF? → return ORIGINAL                (line 81)
  ├─ digitally signed?        → return ORIGINAL                (line 86)
  ├─ collect eligible images                                   (lines 93-98)
  ├─ re-encode them in parallel, keep only the smaller ones    (lines 100-111)
  ├─ apply the survivors in place                              (lines 113-118)
  ├─ nothing changed?         → return ORIGINAL verbatim       (line 122)
  ├─ save                                                       (line 124)
  ├─ output not smaller?      → return ORIGINAL                (line 127)
  └─ return smaller PDF (base64)                               (line 129)
```

Notice how many branches return the **original** input. That is the design
philosophy stated in the file header (`pdfSizeReducer.js:10-13`): the function
*never throws and never returns a broken document*. Every uncertain path falls
back to "hand back exactly what you were given." The whole body is wrapped in a
`try/catch` (`pdfSizeReducer.js:68,130-133`) so even an unforeseen failure
degrades to a safe pass-through.

The next four sections zoom into the four substantive steps: **find** (§4),
**gate** (§5), **re-encode + replace** (§6), and the **guards** that bracket them
(§7).

---

## 4. Reading the PDF's object graph

### 4.1 Finding every image

```js
// pdfSizeReducer.js:177-185
function collectImageStreams(context) {
  const out = [];
  for (const [ref, obj] of context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    if (obj.dict.lookup(N_SUBTYPE) !== N_IMAGE) continue;
    out.push({ ref, stream: obj, dict: obj.dict });
  }
  return out;
}
```

This walks **every top-level indirect object** in the document (`context` is
`pdf-lib`'s object table) and keeps only those that are (a) streams
(`PDFRawStream`) and (b) whose dictionary declares `/Subtype /Image`. That maps
directly to what an image XObject looks like in the raw file:

```
<< /Type /XObject  /Subtype /Image  /Width 3000 /Height 4000
   /ColorSpace /DeviceRGB  /BitsPerComponent 8  /Filter /DCTDecode >>
stream …JPEG bytes… endstream
```

The flat enumeration is correct precisely because of §2.4: image streams are
never hidden inside object streams, so there is nothing to recurse into.

The `ref` we keep for each image is the key to lossless replacement later — it's
the `12 0` identity from §2.2.

> **Performance detail — interned names.** The comparison `=== N_IMAGE`
> (`pdfSizeReducer.js:181`) is a pointer comparison, not a string compare.
> `pdf-lib` *interns* `PDFName` values: `PDFName.of('Image')` always returns the
> same object, so a parsed `/Image` name is literally the same object as our
> `N_IMAGE` singleton (`pdfSizeReducer.js:30-45`). The comment at
> `pdfSizeReducer.js:28-29` notes exactly this.

### 4.2 Reading the properties the decision depends on

```js
// pdfSizeReducer.js:188-203  (abridged)
function readImageParams(dict) {
  return {
    filter: dict.lookup(N_FILTER),        // /DCTDecode, /FlateDecode, [chain], …
    colorSpace: dict.lookup(N_COLORSPACE),// /DeviceRGB, /DeviceGray, /ICCBased, …
    width:  numOf(dict, N_WIDTH),
    height: numOf(dict, N_HEIGHT),
    bpc:    numOf(dict, N_BPC),           // BitsPerComponent
    hasDecode:   decode instanceof PDFArray,     // a /Decode remap array
    isImageMask: imageMask === PDFBool.True,     // /ImageMask true
    hasSMask: dict.get(N_SMASK) !== undefined,   // soft (alpha) mask
    hasMask:  dict.get(N_MASK)  !== undefined,   // stencil / colour-key mask
    hasMatte: dict.get(N_MATTE) !== undefined,   // pre-blended matte
  };
}
```

Each field here is a real entry from the **image dictionary** as defined in the
PDF spec (Table 89, "Additional entries specific to an image dictionary"). This
function is deliberately a *pure read* — it just surfaces the handful of
dictionary entries the safety gate needs. The rest of what these entries mean is
the subject of §5.

> **`pdf-lib` sharp edge, learned the hard way.** `numOf`
> (`pdfSizeReducer.js:273-276`) uses `lookupMaybe`, not `lookup`, because
> `pdf-lib`'s *typed* `lookup(name, Type)` **throws** when the key is absent
> instead of returning `undefined`. `DECISIONS.md` D13 tells the story: this
> exact trap once made `isSigned()` throw on every ordinary PDF, causing the tool
> to treat everything as "signed" and reduce nothing.

---

## 5. The eligibility gate: `canReencode`

This is the safety core of the tool. Re-compressing an image means *changing its
pixel values*. That is only safe for images whose bytes stand alone as an
ordinary photo. Many PDF image features make an image's exact samples
*load-bearing* for something else — a mask, a blend, a remap — and re-encoding
would quietly corrupt them. The gate refuses every such case.

```js
// pdfSizeReducer.js:253-267
function canReencode(p) {
  if (p.isImageMask) return skip('image mask');
  if (p.hasDecode)   return skip('has /Decode array');
  if (p.hasMask)     return skip('has /Mask');
  if (p.hasMatte)    return skip('has /Matte');
  if (p.filter !== N_DCTDECODE) return skip('filter is not a single DCTDecode');
  if (p.colorSpace !== N_DEVICERGB && p.colorSpace !== N_DEVICEGRAY) {
    return skip('unsupported color space');
  }
  if (!p.width || !p.height) return skip('missing dimensions');
  return { ok: true, reason: null };
}
```

Read it as a series of "only if truly safe" rules. Each `skip` reason maps to a
concrete PDF feature:

- **`/Filter` must be a single `/DCTDecode`.** A filter is the *compression* applied
  to a stream's bytes. `/DCTDecode` is JPEG — meaning **the stream's raw bytes
  already are a complete JPEG file**. That's why no PDF-specific image decoder is
  needed: we can feed those bytes straight to a normal image library (§6, and
  `DECISIONS.md` D3). Other filters — `/FlateDecode` (raw zlib'd samples),
  `/CCITTFaxDecode` and `/JBIG2Decode` (bilevel fax/scan formats), `/JPXDecode`
  (JPEG 2000) — are *not* JPEG; a filter **chain** like `[/FlateDecode /DCTDecode]`
  is also rejected because the payload isn't a bare JPEG. (JPEG spec references and
  the list of standard filters are in the [appendix](#8-appendix-specifications-and-library-references).)

- **`/ColorSpace` must be `/DeviceRGB` or `/DeviceGray`.** These are the plain
  "these numbers are RGB / these numbers are grey" colour models that a JPEG
  encoder understands directly. `/DeviceCMYK` JPEGs carry an Adobe APP14 inversion
  trap; `/ICCBased`, `/Indexed`, `/Separation`, `/Lab` all give the samples
  meaning through an external profile or palette that a re-encode would not
  preserve. All are passed through (`DECISIONS.md` D4).

- **No `/Decode` array.** `/Decode` linearly remaps sample values on the way in
  (e.g. invert). If present, the *exact* sample values matter; re-encoding
  perturbs them. Skip.

- **Not an `/ImageMask`.** An image mask is a 1-bit **stencil** — it doesn't carry
  colour, it decides where paint lands. JPEG-compressing a stencil is both
  meaningless and destructive.

- **No `/Mask` or `/Matte`.** `/Mask` masks the image by *exact* colour-key sample
  ranges or a stencil; `/Matte` means the samples are **pre-blended** against a
  matte colour for a soft mask. In both cases the precise sample values are
  load-bearing, so lossy re-encoding would break the masking/blend
  (`DECISIONS.md` D15).

> **What about `/SMask` (a soft/alpha mask)?** Notice the gate does *not* reject
> `hasSMask`. That's deliberate and rather elegant: a soft mask is itself a
> **separate** grayscale image object with its own reference. So it gets
> enumerated and gated like any other image — if it's a DeviceGray JPEG it's
> re-encoded on its own; otherwise it's passed through. Because we replace each
> object *in place at its own ref*, the base image's `/SMask` pointer keeps
> pointing at the (now smaller) mask automatically. No special-case code needed
> (`DECISIONS.md` D14).

The **order** of the checks is intentional (`DECISIONS.md` D11): cheap,
disqualifying structural flags first, then filter, then colour space, then
dimensions.

This same gate powers the read-only `inspectImages()` export
(`pdfSizeReducer.js:143-163`), which lists every image and *why* it was or wasn't
eligible — useful for understanding a specific document without changing it.

---

## 6. Re-encoding and in-place replacement

This is where the bytes actually shrink. Two functions: one makes a smaller
JPEG, the other swaps it into the graph.

### 6.1 Making a smaller JPEG

```js
// pdfSizeReducer.js:212-230  (abridged)
async function reencodeJpeg(bytes, params, opts) {
  const isGray = params.colorSpace === N_DEVICEGRAY;

  let pipeline = sharp(Buffer.from(bytes)).resize({
    width: opts.maxDimension,
    height: opts.maxDimension,
    fit: 'inside',
    withoutEnlargement: true,      // never upscale
  });
  if (isGray) pipeline = pipeline.grayscale();

  const { data, info } = await pipeline
    .jpeg({ quality: opts.quality, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });

  return { bytes: data, width: info.width, height: info.height, isGray };
}
```

`bytes` here is literally the `/DCTDecode` stream's payload from §5 — a valid
JPEG — so it feeds straight into [sharp](https://sharp.pixelplumbing.com/). Two
size levers are pulled:

1. **Downsample** — cap the longest side to `maxDimension` (default 2000 px ≈
   ~170 DPI on A4; `DECISIONS.md` D5, D6). `fit: 'inside'` preserves aspect ratio;
   `withoutEnlargement` guarantees we never make a small image bigger.
2. **Re-compress** — encode at `quality` (default 72) using **mozjpeg**, a JPEG
   encoder tuned for smaller files at equal visual quality.

> **The subtle bug that *isn't* here:** there is deliberately **no `.rotate()`**
> (`pdfSizeReducer.js:221-222`). sharp can auto-rotate from EXIF orientation, but
> the PDF's content stream already positions the image via its transformation
> matrix (CTM). Auto-rotating the pixels would desync them from that matrix and
> turn the page sideways. Leaving orientation alone keeps pixels and placement in
> agreement (`DECISIONS.md` D12).

The re-encode work runs through `mapWithConcurrency` (`pdfSizeReducer.js:302-314`),
a tiny worker-pool that keeps at most `concurrency` (default 4) images in flight.
The expensive native image work parallelizes for throughput, while memory stays
bounded to a few decoded images at a time (`DECISIONS.md` D17).

And the **smaller-only rule** (`pdfSizeReducer.js:104-106`): a re-encoded image is
kept only if it is `≤ 95%` of the original. A photo that's already well-compressed
is left exactly as it was.

### 6.2 Swapping it into the graph

```js
// pdfSizeReducer.js:237-245
function applyReencoded(context, ref, dict, result) {
  dict.set(N_WIDTH,  PDFNumber.of(result.width));
  dict.set(N_HEIGHT, PDFNumber.of(result.height));
  dict.set(N_BPC,    PDFNumber.of(8));            // JPEG is always 8-bit
  dict.set(N_COLORSPACE, result.isGray ? N_DEVICEGRAY : N_DEVICERGB);
  dict.set(N_FILTER, N_DCTDECODE);
  dict.delete(N_DECODEPARMS);                     // plain DCTDecode has none
  context.assign(ref, PDFRawStream.of(dict, result.bytes));
}
```

This is the payoff of everything in §2. Because the image lives at a stable
reference (`ref`), we:

1. Update the **dictionary** to describe the new bytes — new `/Width`/`/Height`
   (it's now smaller), `/BitsPerComponent 8`, the right colour space, `/Filter
   /DCTDecode`. We *don't* set `/Length`; `pdf-lib` recomputes it from the actual
   bytes at save time.
2. `context.assign(ref, …)` — **overwrite the object at the same reference** with
   a new stream carrying the smaller JPEG.

Every `/Im0 Do` in every page's content stream still resolves to that same
reference (§2.3), so all of them now paint the smaller image. Nothing else in the
file needed editing. `DECISIONS.md` D12 records the empirical proof: page content
streams are **byte-identical** before and after — the guarantee that text, the
OCR layer, and annotations survive.

Finally the document is re-serialized with `doc.save(...)` (`pdfSizeReducer.js:124`)
and, if it genuinely came out smaller, base64-encoded and returned.

---

## 7. The guards: never return a broken document

Two categories of PDF must be passed through untouched even though we *could*
technically open them. Both guards sit before the pipeline.

### 7.1 Encrypted PDFs

```js
// pdfSizeReducer.js:76-82
try {
  doc = await PDFDocument.load(bytes, { updateMetadata: false });
} catch (err) {
  if (err instanceof EncryptedPDFError) return base64Pdf;
  return base64Pdf;
}
```

An encrypted PDF has an `/Encrypt` entry in its trailer. `pdf-lib` throws
`EncryptedPDFError` on a **strict** load (we deliberately do *not* pass
`ignoreEncryption`). If we forced it open and re-saved, `pdf-lib` would write the
output *unencrypted* — silently stripping the document's protection. So encrypted
→ return the original. A load failure for *any other* reason means the input
isn't a parseable PDF (corrupt, or not a PDF at all) → also return the original.
`updateMetadata: false` keeps `pdf-lib` from rewriting the `/Info` ModDate on the
way in (`DECISIONS.md` D9).

### 7.2 Digitally signed PDFs

```js
// pdfSizeReducer.js:331-363  (abridged)
function isSigned(doc) {
  try {
    const catalog = doc.catalog;
    if (catalog.lookup(PDFName.of('Perms'))) return true;         // usage-rights / DocMDP

    const acroForm = catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
    if (!acroForm) return false;

    const sigFlags = acroForm.lookupMaybe(PDFName.of('SigFlags'), PDFNumber);
    if (sigFlags && (sigFlags.asNumber() & 1) === 1) return true; // SignaturesExist

    const fields = acroForm.lookupMaybe(PDFName.of('Fields'), PDFArray);
    // …a field with /FT /Sig → return true…
    return false;
  } catch {
    return true;                                                  // can't tell → assume signed
  }
}
```

A digital signature covers an exact byte range of the file. Any full
re-serialization changes the byte layout and **invalidates the signature** — so a
signed PDF must be passed through. Signatures are added via **incremental
updates** (bytes appended after the signed range) precisely so the signed range
stays untouched; a `pdf-lib` full re-save doesn't preserve that.

`isSigned()` is intentionally **conservative** (`DECISIONS.md` D10): it returns
`true` on any positive signal — a `/Perms` dictionary, the AcroForm `SigFlags`
"signatures exist" bit, or a signature form field (`/FT /Sig`) — and, crucially,
*also* returns `true` if the detection itself throws. When unsure whether a
document is signed, the safe choice is to not touch it. This is a guard, not a
full signature parser.

> Both guards are instances of the same rule that shows up all over `reduce()`:
> **when in doubt, return the original.** See the many pass-through branches in
> the §3 diagram, and `DECISIONS.md` D7/D8.

---

## 8. Appendix: specifications and library references

### The PDF format
- **ISO 32000-1:2008 (PDF 1.7)** — the core spec this tool targets. Adobe
  publishes a free copy:
  <https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/PDF32000_2008.pdf>
  Most relevant sections: **§7.3** (object types), **§7.5** (file structure:
  header, body, xref, trailer), **§7.6** (encryption, `/Encrypt`), **§8.9.5**
  (image dictionaries — `/Width`, `/ColorSpace`, `/Decode`, `/SMask`, `/Mask`,
  `/Matte`, `/ImageMask`), **§7.4** (standard filters: `DCTDecode`, `FlateDecode`,
  `CCITTFaxDecode`, `JBIG2Decode`, `JPXDecode`), **§12.7** (interactive forms /
  AcroForm), and **§12.8** (digital signatures, `/Perms`, `SigFlags`).
- **PDF 2.0 (ISO 32000-2)** — the current revision, hosted free by the PDF
  Association: <https://pdfa.org/sponsored-standards/>
- A gentle narrative introduction to the file structure:
  <https://web.archive.org/web/2021*/https://blog.idrsolutions.com/2010/09/grow-your-own-pdf-file-part-1-basic-structure/>
  (or search "PDF file structure basic" — many good primers exist).

### JPEG / DCTDecode
- **DCTDecode** is baseline JPEG (ISO/IEC 10918-1, ITU-T T.81):
  <https://www.w3.org/Graphics/JPEG/itu-t81.pdf>

### Libraries used here
- **pdf-lib** (MIT) — parses the PDF and lets us rewrite streams in place.
  Docs: <https://pdf-lib.js.org/> · Source: <https://github.com/Hopding/pdf-lib>
- **sharp** (Apache-2.0) — resize + JPEG re-encode. Docs:
  <https://sharp.pixelplumbing.com/> · JPEG options:
  <https://sharp.pixelplumbing.com/api-output#jpeg>
- **libvips** (LGPL) — the native engine sharp wraps: <https://www.libvips.org/>
- **mozjpeg** — the size-optimizing JPEG encoder used via
  `.jpeg({ mozjpeg: true })`: <https://github.com/mozilla/mozjpeg>

### This project's own docs
- `DECISIONS.md` — the full, dated rationale and audit trail for every choice
  referenced above (D1–D19).
- `README.md` — usage of the module, the `main.js` CLI, and the `analyze.js`
  diagnostic.
- `analyze.js` — attributes every byte of a PDF to a role (image, content stream,
  font, metadata…), which is the practical way to see *why* a given document
  will or won't shrink.
