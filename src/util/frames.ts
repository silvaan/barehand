/**
 * Cheap frame comparison so the agent doesn't have to look at every frame.
 *
 * Frames are reduced to a small grayscale thumbnail and compared by mean
 * absolute difference (0 = identical, 1 = completely different). This is
 * enough to detect "the screen changed" (POST -> BIOS), "the screen settled"
 * (installer finished drawing) and to ignore a blinking cursor.
 */
import { PNG } from "pngjs";

export const THUMB_W = 64;
export const THUMB_H = 36;

export interface Thumb {
  w: number;
  h: number;
  /** grayscale 0..255, row-major */
  px: Uint8Array;
}

export function decodePng(png: Buffer): { width: number; height: number; data: Buffer } {
  const img = PNG.sync.read(png);
  return { width: img.width, height: img.height, data: img.data };
}

export function pngSize(png: Buffer): { width: number; height: number } {
  // IHDR is always the first chunk: width/height at byte offsets 16 and 20.
  if (png.length < 24 || png.readUInt32BE(12) !== 0x49484452) {
    throw new Error("Not a PNG");
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** Box-filter downscale of RGBA to a grayscale thumbnail. */
export function thumbnail(
  rgba: { width: number; height: number; data: Uint8Array },
  w = THUMB_W,
  h = THUMB_H,
): Thumb {
  const px = new Uint8Array(w * h);
  const { width, height, data } = rgba;
  for (let ty = 0; ty < h; ty++) {
    const y0 = Math.floor((ty * height) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * height) / h));
    for (let tx = 0; tx < w; tx++) {
      const x0 = Math.floor((tx * width) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * width) / w));
      let sum = 0;
      let n = 0;
      // Sample a sparse grid inside the box; full averaging isn't needed.
      const sy = Math.max(1, Math.floor((y1 - y0) / 4));
      const sx = Math.max(1, Math.floor((x1 - x0) / 4));
      for (let y = y0; y < y1; y += sy) {
        for (let x = x0; x < x1; x += sx) {
          const i = (y * width + x) * 4;
          sum += 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
          n++;
        }
      }
      px[ty * w + tx] = n ? Math.round(sum / n) : 0;
    }
  }
  return { w, h, px };
}

export function thumbOfPng(png: Buffer): Thumb {
  return thumbnail(decodePng(png));
}

/** Mean absolute difference between two thumbnails, normalized to 0..1. */
export function thumbDiff(a: Thumb, b: Thumb): number {
  if (a.w !== b.w || a.h !== b.h) throw new Error("Thumbnail size mismatch");
  let sum = 0;
  for (let i = 0; i < a.px.length; i++) sum += Math.abs(a.px[i]! - b.px[i]!);
  return sum / (a.px.length * 255);
}

/** Fraction of nearly-black pixels — "no signal" / powered-off detection. */
export function darkness(t: Thumb, threshold = 16): number {
  let dark = 0;
  for (const v of t.px) if (v < threshold) dark++;
  return dark / t.px.length;
}
