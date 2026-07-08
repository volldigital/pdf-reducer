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

import {
  PDFDocument,
  PDFName,
  PDFDict,
  PDFArray,
  PDFNumber,
  EncryptedPDFError,
} from 'pdf-lib';

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

    // --- image re-compression pipeline (Steps 3–6) ---
    // Not yet implemented: this skeleton changes nothing.
    const changedCount = 0;

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

export default { reduce, DEFAULTS };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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

    const acroForm = catalog.lookup(PDFName.of('AcroForm'), PDFDict);
    if (!acroForm) return false;

    // SigFlags bit 1 (SignaturesExist).
    const sigFlags = acroForm.lookup(PDFName.of('SigFlags'), PDFNumber);
    if (sigFlags && (sigFlags.asNumber() & 1) === 1) return true;

    // A top-level field of type /Sig.
    const fields = acroForm.lookup(PDFName.of('Fields'), PDFArray);
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