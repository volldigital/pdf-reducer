// pdfSizeReducer.ts
//
// Reduces the file size of phone-scanned PDFs by re-compressing their embedded
// raster images, while preserving everything else (text, AcroForm fields and
// values, the hidden OCR text layer, annotations, bookmarks, structure).
//
// Public API:
//   reduce(base64Pdf: string, options?: ReduceOptions): Promise<string>
//
// Guarantee: this function never throws and never returns a broken document.
// On any problem — invalid input, encrypted or signed PDF, or no achievable
// saving — it returns the ORIGINAL base64 string unchanged.
//
// See DECISIONS.md for the rationale behind the approach and its limits.

import { PDFDocument, EncryptedPDFError } from 'pdf-lib';
import { PdfReducerHelpers, DEFAULTS } from './helpers.ts';
import type { ReduceOptions, ImageInspection, Candidate } from './types.ts';

export type { ReduceOptions, ImageInspection } from './types.ts';
export { DEFAULTS } from './helpers.ts';

/**
 * Reduce the size of a base64-encoded PDF.
 * @param base64Pdf base64-encoded PDF
 * @param options see {@link DEFAULTS}
 * @returns base64-encoded PDF (may be the original, unchanged)
 */
export async function reduce(base64Pdf: string, options: ReduceOptions = {}): Promise<string> {
  // Contract is string-in/string-out. Anything else: hand it straight back.
  if (typeof base64Pdf !== 'string') return base64Pdf;

  const opts = PdfReducerHelpers.normalizeOptions(options);

  try {
    const bytes = PdfReducerHelpers.toBytes(base64Pdf);

    // Guard: encrypted PDFs. pdf-lib cannot re-save encrypted output, so a
    // "reduce" would silently strip protection. A strict load throws
    // EncryptedPDFError when an /Encrypt dict is present -> pass through.
    // A load failure for any other reason means the input is not a parseable
    // PDF (corrupt) -> also pass through untouched.
    let doc: PDFDocument;
    try {
      doc = await PDFDocument.load(bytes, { updateMetadata: false });
    } catch (err) {
      if (err instanceof EncryptedPDFError) return base64Pdf;
      return base64Pdf;
    }

    // Guard: digitally signed PDFs. A full re-serialize changes the byte
    // layout and invalidates any signature -> pass through untouched.
    if (PdfReducerHelpers.isSigned(doc)) return base64Pdf;

    // --- image re-compression pipeline ---
    // Collect eligible images first, then re-encode them with a bounded
    // concurrency pool (the expensive, native sharp work runs in parallel),
    // and finally apply the results sequentially (mutation stays simple and
    // deterministic).
    const candidates: Candidate[] = [];
    for (const { ref, stream, dict } of PdfReducerHelpers.collectImageStreams(doc.context)) {
      const params = PdfReducerHelpers.readImageParams(dict);
      if (!PdfReducerHelpers.canReencode(params).ok) continue;
      candidates.push({ ref, dict, params, original: stream.contents });
    }

    const reencoded = await PdfReducerHelpers.mapWithConcurrency(
      candidates,
      opts.concurrency,
      async (c) => {
        try {
          const result = await PdfReducerHelpers.reencodeJpeg(c.original, c.params, opts);
          if (!result) return null;
          // Keep the re-encoded image only if it is a real improvement.
          if (result.bytes.length > c.original.length * opts.minSavingsRatio) return null;
          return { ref: c.ref, dict: c.dict, result };
        } catch {
          // One bad image must not abort the run; leave it untouched.
          return null;
        }
      },
    );

    let changedCount = 0;
    for (const r of reencoded) {
      if (!r) continue;
      PdfReducerHelpers.applyReencoded(doc.context, r.ref, r.dict, r.result);
      changedCount++;
    }

    // Nothing changed: return the ORIGINAL string verbatim (don't re-save, so
    // byte-identical pass-through is guaranteed).
    if (changedCount === 0) return base64Pdf;

    const out = await doc.save({ useObjectStreams: opts.useObjectStreams });

    // Final guard: never hand back something at least as large as the input.
    if (out.length >= bytes.length) return base64Pdf;

    return PdfReducerHelpers.toBase64(out);
  } catch {
    // Never return a broken document.
    return base64Pdf;
  }
}

/**
 * Read-only inspection: list every image XObject in the PDF with the fields we
 * gate on and whether it is eligible for re-compression. Used for diagnostics
 * and tests; performs no mutation.
 */
export async function inspectImages(base64Pdf: string): Promise<ImageInspection[]> {
  const bytes = PdfReducerHelpers.toBytes(base64Pdf);
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return PdfReducerHelpers.collectImageStreams(doc.context).map(({ ref, dict }) => {
    const params = PdfReducerHelpers.readImageParams(dict);
    const gate = PdfReducerHelpers.canReencode(params);
    return {
      ref: ref.toString(),
      width: params.width,
      height: params.height,
      bitsPerComponent: params.bpc,
      filter: PdfReducerHelpers.label(params.filter),
      colorSpace: PdfReducerHelpers.label(params.colorSpace),
      hasDecode: params.hasDecode,
      isImageMask: params.isImageMask,
      hasSMask: params.hasSMask,
      eligible: gate.ok,
      skipReason: gate.reason,
    };
  });
}

export default { reduce, inspectImages, DEFAULTS };
