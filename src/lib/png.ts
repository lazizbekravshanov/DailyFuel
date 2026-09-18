// A small PNG writer for the share cards. resvg hands back RGBA, but a card is
// flat color with no transparency and well under 256 colors, so an indexed PNG
// holds exactly the same pixels in about 40 percent of the bytes. Build time
// only; nothing here reaches the browser.

import { crc32, deflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)) >>> 0, 8 + data.length);
  return out;
}

/**
 * An indexed PNG with exactly the pixels given (RGBA, row by row), or null
 * when any pixel is see through or there are more than 256 colors, so the
 * caller keeps its full color PNG.
 */
export function palettePng(width: number, height: number, rgba: Uint8Array): Buffer | null {
  if (rgba.length !== width * height * 4) throw new RangeError(`expected ${width * height * 4} bytes, got ${rgba.length}`);
  const index = new Map<number, number>();
  const stride = width + 1;
  const rows = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    // each row starts with its filter byte: 0, none, which suits palette images best
    rows[y * stride] = 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (rgba[i + 3] !== 255) return null;
      const color = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2];
      let n = index.get(color);
      if (n === undefined) {
        if (index.size === 256) return null;
        n = index.size;
        index.set(color, n);
      }
      rows[y * stride + 1 + x] = n;
    }
  }
  const palette = Buffer.alloc(index.size * 3);
  for (const [color, n] of index) {
    palette[n * 3] = color >> 16;
    palette[n * 3 + 1] = (color >> 8) & 255;
    palette[n * 3 + 2] = color & 255;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bits per palette index
  header[9] = 3; // color type: indexed
  // compression, filter method and interlace stay 0
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk("PLTE", palette),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
