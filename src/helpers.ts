import sharp from 'sharp';
import {
  PDFDocument,
  PDFName,
  PDFDict,
  PDFArray,
  PDFNumber,
  PDFBool,
  PDFRawStream,
} from 'pdf-lib';
import type { PDFRef, PDFContext, PDFObject } from 'pdf-lib';
import type {
  ReduceOptions,
  NormalizedOptions,
  ImageParams,
  ReencodeResult,
  GateResult,
} from './types.ts';

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
export const DEFAULTS: NormalizedOptions = Object.freeze({
  maxDimension: 2000, // cap on the longest side, in pixels
  quality: 72, // JPEG quality (mozjpeg)
  minSavingsRatio: 0.95, // keep a re-encoded image only if <= 95% of the original
  useObjectStreams: true, // pdf-lib save option (lossless)
  concurrency: 4, // max images re-encoded in parallel (bounds memory)
});

export class PdfReducerHelpers {
  /**
   * Collect every image XObject in the document as indirect objects.
   * Image streams are always top-level indirect objects (never inside object
   * streams), so enumerateIndirectObjects() reliably surfaces all of them.
   */
  static collectImageStreams(
    context: PDFContext,
  ): Array<{ ref: PDFRef; stream: PDFRawStream; dict: PDFDict }> {
    const out: Array<{ ref: PDFRef; stream: PDFRawStream; dict: PDFDict }> = [];
    for (const [ref, obj] of context.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFRawStream)) continue;
      if (obj.dict.lookup(N_SUBTYPE) !== N_IMAGE) continue;
      out.push({ ref, stream: obj, dict: obj.dict });
    }
    return out;
  }

  /** Extract the fields the gate depends on from an image XObject dict. */
  static readImageParams(dict: PDFDict): ImageParams {
    const imageMask = dict.lookup(N_IMAGEMASK);
    const decode = dict.lookup(N_DECODE);
    return {
      filter: dict.lookup(N_FILTER),
      colorSpace: dict.lookup(N_COLORSPACE),
      width: PdfReducerHelpers.numOf(dict, N_WIDTH),
      height: PdfReducerHelpers.numOf(dict, N_HEIGHT),
      bpc: PdfReducerHelpers.numOf(dict, N_BPC),
      hasDecode: decode instanceof PDFArray,
      isImageMask: imageMask === PDFBool.True,
      hasSMask: dict.get(N_SMASK) !== undefined,
      hasMask: dict.get(N_MASK) !== undefined,
      hasMatte: dict.get(N_MATTE) !== undefined,
    };
  }

  /**
   * Downsample + re-encode a JPEG image with sharp.
   * @param bytes the original JPEG (a DCTDecode stream's contents)
   * @param params from readImageParams (drives grayscale handling)
   * @param opts maxDimension / quality
   */
  static async reencodeJpeg(
    bytes: Uint8Array,
    params: ImageParams,
    opts: NormalizedOptions,
  ): Promise<ReencodeResult> {
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
  static applyReencoded(
    context: PDFContext,
    ref: PDFRef,
    dict: PDFDict,
    result: ReencodeResult,
  ): void {
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
   */
  static canReencode(p: ImageParams): GateResult {
    if (p.isImageMask) return PdfReducerHelpers.skip('image mask');
    if (p.hasDecode) return PdfReducerHelpers.skip('has /Decode array');
    // /Mask (color-key ranges or a stencil mask): re-encoding shifts the exact
    // sample values the mask keys on. /Matte: samples are pre-blended against a
    // matte colour. Both are unsafe to re-encode -> pass through.
    if (p.hasMask) return PdfReducerHelpers.skip('has /Mask');
    if (p.hasMatte) return PdfReducerHelpers.skip('has /Matte');
    if (p.filter !== N_DCTDECODE) return PdfReducerHelpers.skip('filter is not a single DCTDecode');
    if (p.colorSpace !== N_DEVICERGB && p.colorSpace !== N_DEVICEGRAY) {
      return PdfReducerHelpers.skip('unsupported color space');
    }
    if (!p.width || !p.height) return PdfReducerHelpers.skip('missing dimensions');
    return { ok: true, reason: null };
  }

  private static skip(reason: string): GateResult {
    return { ok: false, reason };
  }

  /** Read a numeric dict entry as a JS number, or undefined if absent.
   * Uses lookupMaybe because typed lookup() throws on a missing key. */
  static numOf(dict: PDFDict, name: PDFName): number | undefined {
    const v = dict.lookupMaybe(name, PDFNumber);
    return v ? v.asNumber() : undefined;
  }

  /** Human-readable label for a PDF object, for diagnostics. */
  static label(v: PDFObject | null | undefined): string | null {
    if (v == null) return null;
    if (v instanceof PDFName || v instanceof PDFArray) return v.toString();
    return v.constructor?.name ?? String(v);
  }

  /** Validate and clamp caller options against DEFAULTS. Never throws: unknown
   * or out-of-range values fall back to sane bounds so reduce() stays robust. */
  static normalizeOptions(options: ReduceOptions): NormalizedOptions {
    const o: ReduceOptions = options && typeof options === 'object' ? options : {};
    const num = (v: unknown, def: number): number =>
      typeof v === 'number' && Number.isFinite(v) ? v : def;
    return {
      maxDimension: Math.max(16, Math.round(num(o.maxDimension, DEFAULTS.maxDimension))),
      quality: Math.min(100, Math.max(1, Math.round(num(o.quality, DEFAULTS.quality)))),
      minSavingsRatio: Math.min(1, Math.max(0, num(o.minSavingsRatio, DEFAULTS.minSavingsRatio))),
      useObjectStreams:
        typeof o.useObjectStreams === 'boolean' ? o.useObjectStreams : DEFAULTS.useObjectStreams,
      concurrency: Math.max(1, Math.round(num(o.concurrency, DEFAULTS.concurrency))),
    };
  }

  /** Run `fn` over `items` with at most `limit` in flight at once, preserving
   * input order in the returned results array. */
  static async mapWithConcurrency<T, R>(
    items: T[],
    limit: number,
    fn: (item: T, idx: number) => Promise<R>,
  ): Promise<R[]> {
    const results: R[] = new Array<R>(items.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < items.length) {
        const idx = next++;
        results[idx] = await fn(items[idx]!, idx);
      }
    };
    const size = Math.min(limit, items.length);
    await Promise.all(Array.from({ length: size }, worker));
    return results;
  }

  /** Decode a base64 string to bytes. Lenient: invalid input yields garbage
   * bytes that later fail to parse as a PDF (and are then passed through). */
  static toBytes(base64: string): Uint8Array {
    return new Uint8Array(Buffer.from(base64, 'base64'));
  }

  /** Encode bytes to a base64 string. */
  static toBase64(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('base64');
  }

  /**
   * Detect whether a loaded document carries a digital signature. Conservative:
   * any positive signal returns true so we pass the document through untouched.
   */
  static isSigned(doc: PDFDocument): boolean {
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
}

