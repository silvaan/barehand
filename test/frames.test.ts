import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import { PngStreamSplitter } from "../src/util/pngstream.js";
import { darkness, pngSize, ppmToPng, thumbDiff, thumbOfPng } from "../src/util/frames.js";

function solidPng(w: number, h: number, rgb: [number, number, number], box?: { x: number; y: number; w: number; h: number; rgb: [number, number, number] }) {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inBox = box && x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h;
      const c = inBox ? box.rgb : rgb;
      const i = (y * w + x) * 4;
      png.data[i] = c[0];
      png.data[i + 1] = c[1];
      png.data[i + 2] = c[2];
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

describe("frames", () => {
  it("reads PNG size from the header", () => {
    expect(pngSize(solidPng(320, 200, [0, 0, 0]))).toEqual({ width: 320, height: 200 });
  });

  it("measures difference and darkness", () => {
    const black = thumbOfPng(solidPng(320, 180, [0, 0, 0]));
    const blue = thumbOfPng(solidPng(320, 180, [0, 0, 170])); // classic BIOS blue
    const cursor = thumbOfPng(solidPng(320, 180, [0, 0, 0], { x: 10, y: 10, w: 4, h: 8, rgb: [255, 255, 255] }));
    expect(thumbDiff(black, black)).toBe(0);
    expect(thumbDiff(black, blue)).toBeGreaterThan(0.05);
    expect(thumbDiff(black, cursor)).toBeLessThan(0.02); // a blinking cursor is not a screen change
    expect(darkness(black)).toBe(1);
    expect(darkness(blue)).toBeLessThan(1);
  });
});

describe("PngStreamSplitter", () => {
  it("splits concatenated PNGs delivered in arbitrary chunks", () => {
    const a = solidPng(16, 16, [255, 0, 0]);
    const b = solidPng(32, 8, [0, 255, 0]);
    const stream = Buffer.concat([Buffer.from("junk"), a, b]);
    const frames: Buffer[] = [];
    const s = new PngStreamSplitter((f) => frames.push(f));
    for (let i = 0; i < stream.length; i += 7) s.push(stream.subarray(i, i + 7));
    expect(frames.map(pngSize)).toEqual([
      { width: 16, height: 16 },
      { width: 32, height: 8 },
    ]);
    expect(frames[0]!.equals(a)).toBe(true);
  });
});

describe("ppmToPng", () => {
  it("converts binary PPM (QEMU < 7.1 screendump) with comments", () => {
    const header = Buffer.from("P6\n# qemu\n2 1\n255\n", "latin1");
    const ppm = Buffer.concat([header, Buffer.from([255, 0, 0, 0, 0, 255])]);
    const png = ppmToPng(ppm);
    expect(pngSize(png)).toEqual({ width: 2, height: 1 });
    const img = PNG.sync.read(png);
    expect([...img.data]).toEqual([255, 0, 0, 255, 0, 0, 255, 255]);
  });

  it("rejects truncated data", () => {
    expect(() => ppmToPng(Buffer.from("P6 4 4 255\n\x00\x00", "latin1"))).toThrow(/Truncated/);
  });
});
