// Writes the app icons into public/: favicon.svg, favicon.ico (16 and 32),
// apple-touch-icon.png (180), icon-192.png and icon-512.png.
//
// The design is the paper terminal's mark, the one the design mockup carries
// in its head: a near black square with three white rules, a price sheet at
// a glance. One drawing in a 16 unit box serves every size, since it is
// nothing but rectangles, so a scaled render stays crisp. The square has no
// rounded corners: the site draws no curves, and iOS and Android cut their
// own masks. Every PNG is rendered here with resvg, so running this again
// gives the same bytes.
//
// usage: node scripts/make_app_icons.mjs

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const PUBLIC = resolve(fileURLToPath(new URL("../public/", import.meta.url)));
const INK = "#111111";
const PAPER = "#ffffff";

/** Three rules on ink: two full lines and a short one, as the mockup draws them. */
const RULES = "M3 4h10v1.6H3zM3 7.2h10v1.6H3zM3 10.4h6v1.6H3z";

const svg =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">\n` +
  `  <rect width="16" height="16" fill="${INK}"/>\n` +
  `  <path d="${RULES}" fill="${PAPER}"/>\n` +
  `</svg>\n`;

function png(width) {
  return new Resvg(svg, { fitTo: { mode: "width", value: width } }).render().asPng();
}

/** A .ico holding PNG images, which every current browser reads. */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 is an icon
  header.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = header.length + dir.length;
  images.forEach(({ size, data }, i) => {
    const at = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, at); // width, 0 means 256
    dir.writeUInt8(size >= 256 ? 0 : size, at + 1); // height
    dir.writeUInt8(0, at + 2); // no palette
    dir.writeUInt8(0, at + 3); // reserved
    dir.writeUInt16LE(1, at + 4); // color planes
    dir.writeUInt16LE(32, at + 6); // bits per pixel
    dir.writeUInt32LE(data.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([header, dir, ...images.map((i) => i.data)]);
}

const out = {
  "favicon.svg": svg,
  "favicon.ico": ico([
    { size: 16, data: png(16) },
    { size: 32, data: png(32) },
  ]),
  "apple-touch-icon.png": png(180),
  "icon-192.png": png(192),
  "icon-512.png": png(512),
};

for (const [name, data] of Object.entries(out)) {
  writeFileSync(resolve(PUBLIC, name), data);
  console.log(`public/${name}  ${data.length} bytes`);
}
