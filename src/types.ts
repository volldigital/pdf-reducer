import type { PDFRef, PDFDict, PDFObject } from 'pdf-lib';

/** Caller-tunable options for {@link reduce}. All fields are optional; unset or
 * out-of-range values fall back to (and are clamped against) {@link DEFAULTS}. */
export interface ReduceOptions {
  /** Cap on the longest side, in pixels. */
  maxDimension?: number;
  /** JPEG quality (mozjpeg), 1–100. */
  quality?: number;
  /** Keep a re-encoded image only if it is <= this fraction of the original. */
  minSavingsRatio?: number;
  /** pdf-lib save option (lossless). */
  useObjectStreams?: boolean;
  /** Max images re-encoded in parallel (bounds memory). */
  concurrency?: number;
}

/** Fully-resolved options after validation/clamping — every field present. */
export type NormalizedOptions = Required<ReduceOptions>;

/** One row of {@link inspectImages}: an image XObject and the gate's verdict. */
export interface ImageInspection {
  ref: string;
  width: number | undefined;
  height: number | undefined;
  bitsPerComponent: number | undefined;
  filter: string | null;
  colorSpace: string | null;
  hasDecode: boolean;
  isImageMask: boolean;
  hasSMask: boolean;
  eligible: boolean;
  skipReason: string | null;
}

/** An image XObject that passed the gate and is queued for re-encoding. */
export interface Candidate {
  ref: PDFRef;
  dict: PDFDict;
  params: ImageParams;
  original: Uint8Array;
}

/** The image-XObject fields the gate depends on. */
export interface ImageParams {
  filter: PDFObject | undefined;
  colorSpace: PDFObject | undefined;
  width: number | undefined;
  height: number | undefined;
  bpc: number | undefined;
  hasDecode: boolean;
  isImageMask: boolean;
  hasSMask: boolean;
  hasMask: boolean;
  hasMatte: boolean;
}

/** Result of a successful sharp re-encode. */
export interface ReencodeResult {
  bytes: Uint8Array;
  width: number;
  height: number;
  isGray: boolean;
}

/** The gate's verdict for one image. */
export interface GateResult {
  ok: boolean;
  reason: string | null;
}
