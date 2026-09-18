import { crc32, inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { palettePng } from "./png.ts";

/** Reads back an indexed PNG from palettePng as RGBA, checking every chunk's CRC. */
function decode(png: Buffer): { width: number; height: number; rgba: Buffer } {
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  let at = 8;
  let width = 0;
  let height = 0;
  let palette = Buffer.alloc(0);
  const idat: Buffer[] = [];
  while (at < png.length) {
    const len = png.readUInt32BE(at);
    const type = png.toString("ascii", at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + len);
    expect(png.readUInt32BE(at + 8 + len)).toBe(crc32(png.subarray(at + 4, at + 8 + len)) >>> 0);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      expect([data[8], data[9], data[10], data[11], data[12]]).toEqual([8, 3, 0, 0, 0]);
    }
    if (type === "PLTE") palette = Buffer.from(data);
    if (type === "IDAT") idat.push(Buffer.from(data));
    at += 12 + len;
  }
  const rows = inflateSync(Buffer.concat(idat));
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    expect(rows[y * (width + 1)]).toBe(0);
    for (let x = 0; x < width; x++) {
      const n = rows[y * (width + 1) + 1 + x];
      palette.copy(rgba, (y * width + x) * 4, n * 3, n * 3 + 3);
      rgba[(y * width + x) * 4 + 3] = 255;
    }
  }
  return { width, height, rgba };
}

function image(width: number, height: number, color: (x: number, y: number) => [number, number, number, number]): Buffer {
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) out.set(color(x, y), (y * width + x) * 4);
  }
  return out;
}

describe("palette PNG for share cards", () => {
  it("keeps every pixel exactly", () => {
    const px = image(23, 9, (x, y) => [(x * 7) % 256, (y * 23) % 256, (x + y) % 5 === 0 ? 255 : 10, 255]);
    const png = palettePng(23, 9, px)!;
    expect(png).not.toBeNull();
    const back = decode(png);
    expect(back.width).toBe(23);
    expect(back.height).toBe(9);
    expect(back.rgba.equals(px)).toBe(true);
  });

  it("is smaller than the raw pixels for a flat card", () => {
    const px = image(1200, 630, (x, y) => (x > 84 && x < 1116 && y > 84 && y < 546 ? [10, 102, 64, 255] : [252, 252, 251, 255]));
    const png = palettePng(1200, 630, px)!;
    expect(png.length).toBeLessThan(5000);
    expect(decode(png).rgba.equals(px)).toBe(true);
  });

  it("gives up on transparency or more than 256 colors", () => {
    expect(palettePng(2, 1, image(2, 1, (x) => [0, 0, 0, x === 0 ? 255 : 128]))).toBeNull();
    expect(palettePng(300, 1, image(300, 1, (x) => [x % 256, x >> 8, 0, 255]))).toBeNull();
    expect(palettePng(256, 1, image(256, 1, (x) => [x, 0, 0, 255]))).not.toBeNull();
  });

  it("refuses a buffer of the wrong size", () => {
    expect(() => palettePng(2, 2, Buffer.alloc(3))).toThrow(RangeError);
  });
});
