// pdfSizeReducer.js
//
// Reduces the file size of phone-scanned PDFs by re-compressing their embedded
// raster images, while preserving everything else (text, AcroForm fields and
// values, the hidden OCR text layer, annotations, bookmarks, structure).
//
// Public API:
//   reduce(base64Pdf: string, options?): Promise<string>
//
// Guarantee: this function never throws and never returns a broken document.
// On any problem — invalid input, encrypted or signed PDF, or no achievable
// saving — it returns the ORIGINAL base64 string unchanged.
//
// See DECISIONS.md for the rationale behind the approach and its limits.

import sharp from 'sharp';
import {
  PDFDocument,
  PDFName,
  PDFDict,
  PDFArray,
  PDFNumber,
  PDFBool,
  PDFRawStream,
  EncryptedPDFError,
} from 'pdf-lib';

// Interned PDFName singletons — pdf-lib caches these, so identity (===)
// comparison against parsed values is valid.
const N_SUBTYPE = PDFName.of('Subtype');
const N_IMAGE = PDFName.of('Image');
const N_FILTER = PDFName.of('Filter');
const N_COLORSPACE = PDFName.of('ColorSpace');
const N_WIDTH = PDFName.of('Width');
const N_HEIGHT = PDFName.of('Height');
const N_BPC = PDFName.of('BitsPerComponent');
const N_DECODE = PDFName.of('Decode');
const N_DECODEPARMS = PDFName.of('DecodeParms');
const N_IMAGEMASK = PDFName.of('ImageMask');
const N_SMASK = PDFName.of('SMask');
const N_MASK = PDFName.of('Mask');
const N_MATTE = PDFName.of('Matte');
const N_DCTDECODE = PDFName.of('DCTDecode');
const N_DEVICERGB = PDFName.of('DeviceRGB');
const N_DEVICEGRAY = PDFName.of('DeviceGray');

/** Default tuning ("Balanced" profile — see DECISIONS.md D5). */
export const DEFAULTS = Object.freeze({
  maxDimension: 2000, // cap on the longest side, in pixels
  quality: 72, // JPEG quality (mozjpeg)
  minSavingsRatio: 0.95, // keep a re-encoded image only if <= 95% of the original
  useObjectStreams: true, // pdf-lib save option (lossless)
});

/**
 * Reduce the size of a base64-encoded PDF.
 * @param {string} base64Pdf base64-encoded PDF
 * @param {object} [options] see DEFAULTS
 * @returns {Promise<string>} base64-encoded PDF (may be the original, unchanged)
 */
export async function reduce(base64Pdf, options = {}) {
  // Contract is string-in/string-out. Anything else: hand it straight back.
  if (typeof base64Pdf !== 'string') return base64Pdf;

  const opts = { ...DEFAULTS, ...options };

  try {
    const bytes = toBytes(base64Pdf);

    // Guard: encrypted PDFs. pdf-lib cannot re-save encrypted output, so a
    // "reduce" would silently strip protection. A strict load throws
    // EncryptedPDFError when an /Encrypt dict is present -> pass through.
    // A load failure for any other reason means the input is not a parseable
    // PDF (corrupt) -> also pass through untouched.
    let doc;
    try {
      doc = await PDFDocument.load(bytes, { updateMetadata: false });
    } catch (err) {
      if (err instanceof EncryptedPDFError) return base64Pdf;
      return base64Pdf;
    }

    // Guard: digitally signed PDFs. A full re-serialize changes the byte
    // layout and invalidates any signature -> pass through untouched.
    if (isSigned(doc)) return base64Pdf;

    // --- image re-compression pipeline ---
    let changedCount = 0;
    for (const { ref, stream, dict } of collectImageStreams(doc.context)) {
      const params = readImageParams(dict);
      if (!canReencode(params).ok) continue;

      try {
        const original = stream.contents; // for DCTDecode these bytes are a JPEG
        const result = await reencodeJpeg(original, params, opts);
        if (!result) continue;

        // Keep the re-encoded image only if it is a real improvement.
        if (result.bytes.length > original.length * opts.minSavingsRatio) continue;

        applyReencoded(doc.context, ref, dict, result);
        changedCount++;
      } catch {
        // One bad image must not abort the run; leave it untouched.
      }
    }

    // Nothing changed: return the ORIGINAL string verbatim (don't re-save, so
    // byte-identical pass-through is guaranteed).
    if (changedCount === 0) return base64Pdf;

    const out = await doc.save({ useObjectStreams: opts.useObjectStreams });

    // Final guard: never hand back something at least as large as the input.
    if (out.length >= bytes.length) return base64Pdf;

    return toBase64(out);
  } catch {
    // Never return a broken document.
    return base64Pdf;
  }
}

/**
 * Read-only inspection: list every image XObject in the PDF with the fields we
 * gate on and whether it is eligible for re-compression. Used for diagnostics
 * and tests; performs no mutation.
 * @param {string} base64Pdf
 * @returns {Promise<Array<object>>}
 */
export async function inspectImages(base64Pdf) {
  const bytes = toBytes(base64Pdf);
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return collectImageStreams(doc.context).map(({ ref, dict }) => {
    const params = readImageParams(dict);
    const gate = canReencode(params);
    return {
      ref: ref.toString(),
      width: params.width,
      height: params.height,
      bitsPerComponent: params.bpc,
      filter: label(params.filter),
      colorSpace: label(params.colorSpace),
      hasDecode: params.hasDecode,
      isImageMask: params.isImageMask,
      hasSMask: params.hasSMask,
      eligible: gate.ok,
      skipReason: gate.reason,
    };
  });
}

export default { reduce, inspectImages, DEFAULTS };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Collect every image XObject in the document as indirect objects.
 * Image streams are always top-level indirect objects (never inside object
 * streams), so enumerateIndirectObjects() reliably surfaces all of them.
 * @returns {Array<{ref: import('pdf-lib').PDFRef, stream: PDFRawStream, dict: PDFDict}>}
 */
function collectImageStreams(context) {
  const out = [];
  for (const [ref, obj] of context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    if (obj.dict.lookup(N_SUBTYPE) !== N_IMAGE) continue;
    out.push({ ref, stream: obj, dict: obj.dict });
  }
  return out;
}

/** Extract the fields the gate depends on from an image XObject dict. */
function readImageParams(dict) {
  const imageMask = dict.lookup(N_IMAGEMASK);
  const decode = dict.lookup(N_DECODE);
  return {
    filter: dict.lookup(N_FILTER),
    colorSpace: dict.lookup(N_COLORSPACE),
    width: numOf(dict, N_WIDTH),
    height: numOf(dict, N_HEIGHT),
    bpc: numOf(dict, N_BPC),
    hasDecode: decode instanceof PDFArray,
    isImageMask: imageMask === PDFBool.True,
    hasSMask: dict.get(N_SMASK) !== undefined,
    hasMask: dict.get(N_MASK) !== undefined,
    hasMatte: dict.get(N_MATTE) !== undefined,
  };
}

/**
 * Downsample + re-encode a JPEG image with sharp.
 * @param {Uint8Array} bytes the original JPEG (a DCTDecode stream's contents)
 * @param {object} params from readImageParams (drives grayscale handling)
 * @param {object} opts maxDimension / quality
 * @returns {Promise<{bytes: Uint8Array, width: number, height: number, isGray: boolean} | null>}
 */
async function reencodeJpeg(bytes, params, opts) {
  const isGray = params.colorSpace === N_DEVICEGRAY;

  let pipeline = sharp(Buffer.from(bytes)).resize({
    width: opts.maxDimension,
    height: opts.maxDimension,
    fit: 'inside',
    withoutEnlargement: true, // never upscale
  });
  // NOTE: deliberately no .rotate() — EXIF auto-rotation would desync the
  // pixels from the PDF content-stream CTM (see DECISIONS.md).
  if (isGray) pipeline = pipeline.grayscale();

  const { data, info } = await pipeline
    .jpeg({ quality: opts.quality, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });

  return { bytes: data, width: info.width, height: info.height, isGray };
}

/**
 * Replace an image XObject's stream in place, reusing its ref so every
 * content-stream `Do` reference to it stays valid. pdf-lib recomputes /Length
 * from the new contents at save time, so we don't set it here.
 */
function applyReencoded(context, ref, dict, result) {
  dict.set(N_WIDTH, PDFNumber.of(result.width));
  dict.set(N_HEIGHT, PDFNumber.of(result.height));
  dict.set(N_BPC, PDFNumber.of(8)); // JPEG is always 8-bit
  dict.set(N_COLORSPACE, result.isGray ? N_DEVICEGRAY : N_DEVICERGB);
  dict.set(N_FILTER, N_DCTDECODE);
  dict.delete(N_DECODEPARMS); // plain DCTDecode has no decode parameters
  context.assign(ref, PDFRawStream.of(dict, result.bytes));
}

/**
 * The v1 gate (see DECISIONS.md D4): re-compress only single-filter DCTDecode
 * (JPEG) images in DeviceRGB/DeviceGray, with no /Decode array and not an
 * image mask. Everything else is passed through untouched.
 * @returns {{ok: boolean, reason: string|null}}
 */
function canReencode(p) {
  if (p.isImageMask) return skip('image mask');
  if (p.hasDecode) return skip('has /Decode array');
  // /Mask (color-key ranges or a stencil mask): re-encoding shifts the exact
  // sample values the mask keys on. /Matte: samples are pre-blended against a
  // matte colour. Both are unsafe to re-encode -> pass through.
  if (p.hasMask) return skip('has /Mask');
  if (p.hasMatte) return skip('has /Matte');
  if (p.filter !== N_DCTDECODE) return skip('filter is not a single DCTDecode');
  if (p.colorSpace !== N_DEVICERGB && p.colorSpace !== N_DEVICEGRAY) {
    return skip('unsupported color space');
  }
  if (!p.width || !p.height) return skip('missing dimensions');
  return { ok: true, reason: null };
}

const skip = (reason) => ({ ok: false, reason });

/** Read a numeric dict entry as a JS number, or undefined if absent.
 * Uses lookupMaybe because typed lookup() throws on a missing key. */
function numOf(dict, name) {
  const v = dict.lookupMaybe(name, PDFNumber);
  return v ? v.asNumber() : undefined;
}

/** Human-readable label for a PDF object, for diagnostics. */
function label(v) {
  if (v == null) return null;
  if (v instanceof PDFName || v instanceof PDFArray) return v.toString();
  return v.constructor?.name ?? String(v);
}

/** Decode a base64 string to bytes. Lenient: invalid input yields garbage
 * bytes that later fail to parse as a PDF (and are then passed through). */
function toBytes(base64) {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

/** Encode bytes to a base64 string. */
function toBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

/**
 * Detect whether a loaded document carries a digital signature. Conservative:
 * any positive signal returns true so we pass the document through untouched.
 */
function isSigned(doc) {
  try {
    const catalog = doc.catalog;

    // /Perms (usage-rights / DocMDP) implies a document-level signature.
    if (catalog.lookup(PDFName.of('Perms'))) return true;

    // NOTE: pdf-lib's typed lookup(name, Type) THROWS when the key is absent,
    // so all optional lookups must use lookupMaybe (returns undefined instead).
    const acroForm = catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
    if (!acroForm) return false;

    // SigFlags bit 1 (SignaturesExist).
    const sigFlags = acroForm.lookupMaybe(PDFName.of('SigFlags'), PDFNumber);
    if (sigFlags && (sigFlags.asNumber() & 1) === 1) return true;

    // A top-level field of type /Sig.
    const fields = acroForm.lookupMaybe(PDFName.of('Fields'), PDFArray);
    if (fields) {
      for (let i = 0; i < fields.size(); i++) {
        const field = doc.context.lookup(fields.get(i), PDFDict);
        if (field && field.lookup(PDFName.of('FT')) === PDFName.of('Sig')) {
          return true;
        }
      }
    }

    return false;
  } catch {
    // If we can't tell, err on the side of not touching the document.
    return true;
  }
}