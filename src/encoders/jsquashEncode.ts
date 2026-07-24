// jsquashEncode.ts
//
// Shared, environment-agnostic JPEG re-encode logic backed by @jsquash (Squoosh
// codecs). It assumes the codecs' WebAssembly modules are already initialized —
// the Node and browser encoders (jsquashEncoder.{node,browser}.ts) own that
// init and then delegate here. Kept free of any Node- or DOM-specific globals
// so both entry points can reuse it verbatim.

import decode from '@jsquash/jpeg/decode.js';
import encode from '@jsquash/jpeg/encode.js';
import resize from '@jsquash/resize';
import type { EncodeOptions } from '@jsquash/jpeg/meta.js';
import type { EncodeRequest, EncodedImage } from '../pdfSizeReducer.js';

// MozJpegColorSpace is a `const enum` in @jsquash, so it cannot be imported as a
// value under isolatedModules/verbatimModuleSyntax. Its values are stable:
// GRAYSCALE = 1, RGB = 2, YCbCr = 3. Passing GRAYSCALE makes mozjpeg emit a
// genuine 1-component JPEG; YCbCr is the normal 3-component color path.
type MozJpegColorSpace = EncodeOptions['color_space'];
const GRAYSCALE = 1 as MozJpegColorSpace;
const YCBCR = 3 as MozJpegColorSpace;

/**
 * Downsample (fit inside `maxDimension`, never upscaling) and re-encode a JPEG
 * with mozjpeg. `wantGrayscale` selects a true 1-channel output; the returned
 * `isGray` reflects that actual output so the caller can set /ColorSpace safely.
 *
 * NOTE: no EXIF rotation — @jsquash's decode leaves pixels in file order unless
 * `preserveOrientation` is set (we never set it), matching the invariant that
 * pixels must stay aligned with the PDF content-stream CTM.
 */
export async function jsquashEncode(req: EncodeRequest): Promise<EncodedImage> {
  const { bytes, maxDimension, quality, wantGrayscale } = req;

  const decoded = await decode(toArrayBuffer(bytes));

  // Compute fit-inside dimensions; the `1` clamp gives sharp's withoutEnlargement.
  const scale = Math.min(maxDimension / decoded.width, maxDimension / decoded.height, 1);
  const image =
    scale === 1
      ? decoded
      : await resize(decoded, {
          width: Math.max(1, Math.round(decoded.width * scale)),
          height: Math.max(1, Math.round(decoded.height * scale)),
        });

  const options: Partial<EncodeOptions> = {
    quality,
    color_space: wantGrayscale ? GRAYSCALE : YCBCR,
  };
  const encoded = await encode(image, options);

  return {
    bytes: new Uint8Array(encoded),
    width: image.width,
    height: image.height,
    isGray: wantGrayscale,
  };
}

/** Copy a Uint8Array into a standalone ArrayBuffer for @jsquash decode (avoids
 * passing a partial view of a larger, shared buffer). */
function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(u8.byteLength);
  copy.set(u8);
  return copy.buffer;
}
