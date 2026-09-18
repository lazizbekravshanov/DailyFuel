// Writes the app icons into public/: favicon.svg, favicon.ico (16 and 32),
// apple-touch-icon.png (180), icon-192.png and icon-512.png.
//
// The design is the guide sign green square with a fuel pump knocked out of it
// in white, drawn for three sizes. The 180 and 32 carry the sign's thin white
// inset border. The 16 drops it on purpose, since one pixel of border at that
// size reads as a smudge. Every PNG is rendered here with resvg, so running
// this again gives the same bytes.
//
// usage: node scripts/make_app_icons.mjs

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const PUBLIC = resolve(fileURLToPath(new URL("../public/", import.meta.url)));
const GREEN = "#0a6640";
const WHITE = "#ffffff";

const PUMP_180 =
  "M85.7108 46C87.5413 46 89.2963 46.7277 90.5907 48.0221C91.8848 49.3164 92.6127 51.0716 92.6127 52.902V83.9608H101.24C105.005 83.9608 108.544 85.2386 111.155 87.8499C113.766 90.4611 115.044 94.0003 115.044 97.7647V115.02C115.044 116.431 115.492 117.206 115.9 117.615C116.309 118.023 117.084 118.471 118.495 118.471C119.907 118.471 120.682 118.023 121.09 117.615C121.498 117.206 121.946 116.431 121.946 115.02V72.3002L111.384 61.7384C109.363 59.717 109.363 56.4401 111.384 54.4185C113.406 52.397 116.683 52.397 118.704 54.4185L130.782 66.4969C131.753 67.4677 132.299 68.7842 132.299 70.1569V115.02C132.299 118.784 131.021 122.323 128.41 124.934C125.799 127.545 122.259 128.824 118.495 128.824C114.731 128.824 111.191 127.545 108.58 124.934C105.969 122.323 104.691 118.784 104.691 115.02V97.7647C104.691 96.3533 104.243 95.5782 103.835 95.1697C103.427 94.7614 102.652 94.3137 101.24 94.3137H92.6127V134H47.75V52.902C47.75 51.0716 48.478 49.3164 49.7721 48.0221C51.0664 46.7277 52.8214 46 54.652 46H85.7108ZM61.5539 56.3529C59.648 56.3529 58.1029 57.898 58.1029 59.8039V75.3333C58.1034 77.2389 59.6483 78.7843 61.5539 78.7843H78.8088C80.7145 78.7843 82.2593 77.2389 82.2598 75.3333V59.8039C82.2598 57.898 80.7147 56.3529 78.8088 56.3529H61.5539Z";

const PUMP_32 =
  "M15.1176 7.75C15.4609 7.75 15.7899 7.88644 16.0326 8.12914C16.2753 8.37182 16.4118 8.70093 16.4118 9.04412V14.8676H18.0294C18.7353 14.8676 19.3988 15.1072 19.8884 15.5969C20.378 16.0865 20.6176 16.7501 20.6176 17.4559V20.6912C20.6177 20.9558 20.7016 21.1012 20.7781 21.1777C20.8547 21.2543 21.0001 21.3382 21.2647 21.3382C21.5293 21.3382 21.6747 21.2543 21.7513 21.1777C21.8278 21.1012 21.9117 20.9558 21.9118 20.6912V12.6813L19.9314 10.7009C19.5524 10.3219 19.5524 9.70751 19.9314 9.32847C20.3104 8.94943 20.9248 8.94943 21.3039 9.32847L23.5686 11.5932C23.7506 11.7752 23.8529 12.022 23.8529 12.2794V20.6912C23.8529 21.397 23.6133 22.0606 23.1237 22.5502C22.6341 23.0398 21.9705 23.2794 21.2647 23.2794C20.5589 23.2794 19.8953 23.0398 19.4057 22.5502C18.9161 22.0606 18.6765 21.397 18.6765 20.6912V17.4559C18.6765 17.1912 18.5925 17.0459 18.516 16.9693C18.4394 16.8928 18.2941 16.8088 18.0294 16.8088H16.4118V24.25H8V9.04412C8 8.70093 8.13649 8.37182 8.37914 8.12914C8.62183 7.88644 8.9509 7.75 9.29412 7.75H15.1176ZM10.5882 9.69118C10.2309 9.69118 9.94118 9.98087 9.94118 10.3382V13.25C9.94126 13.6073 10.2309 13.8971 10.5882 13.8971H13.8235C14.1808 13.8971 14.4705 13.6073 14.4706 13.25V10.3382C14.4706 9.98087 14.1809 9.69118 13.8235 9.69118H10.5882Z";

const PUMP_16 =
  "M7.4951 2.5C7.72391 2.5 7.94329 2.59096 8.10509 2.75276C8.26685 2.91455 8.35784 3.13396 8.35784 3.36275V7.2451H9.43627C9.90685 7.2451 10.3492 7.40483 10.6756 7.73123C11.002 8.05764 11.1618 8.50004 11.1618 8.97059V11.1275C11.1618 11.3039 11.2177 11.4008 11.2688 11.4518C11.3198 11.5029 11.4167 11.5588 11.5931 11.5588C11.7696 11.5588 11.8665 11.5029 11.9175 11.4518C11.9685 11.4008 12.0245 11.3039 12.0245 11.1275V5.78753L10.7043 4.46729C10.4516 4.21462 10.4516 3.80501 10.7043 3.55231C10.957 3.29962 11.3666 3.29962 11.6193 3.55231L13.1291 5.06212C13.2504 5.18346 13.3186 5.34802 13.3186 5.51961V11.1275C13.3186 11.598 13.1589 12.0404 12.8325 12.3668C12.5061 12.6932 12.0637 12.8529 11.5931 12.8529C11.1226 12.8529 10.6802 12.6932 10.3538 12.3668C10.0274 12.0404 9.86767 11.598 9.86765 11.1275V8.97059C9.86765 8.79416 9.81168 8.69727 9.76065 8.64622C9.7096 8.59517 9.61276 8.53922 9.43627 8.53922H8.35784V13.5H2.75V3.36275C2.75 3.13396 2.84099 2.91455 3.00276 2.75276C3.16455 2.59096 3.38393 2.5 3.61275 2.5H7.4951ZM4.47549 3.79412C4.23725 3.79412 4.04412 3.98725 4.04412 4.22549V6.16667C4.04417 6.40486 4.23728 6.59804 4.47549 6.59804H6.63235C6.87056 6.59804 7.06367 6.40486 7.06373 6.16667V4.22549C7.06373 3.98725 6.87059 3.79412 6.63235 3.79412H4.47549Z";

/**
 * The icon at one of its three design sizes. `bleed` fills the corners too,
 * for iOS, which cuts its own rounded mask and paints anything transparent black.
 */
function icon(size, { bleed = false } = {}) {
  const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">\n${body}\n</svg>\n`;
  const bg = (rx) => `  <rect width="${size}" height="${size}"${bleed ? "" : ` rx="${rx}"`} fill="${GREEN}"/>`;
  const pump = (d) => `  <path fill="${WHITE}" fill-rule="evenodd" d="${d}"/>`;
  if (size === 16) return svg([bg(3.5), pump(PUMP_16)].join("\n"));
  if (size === 32) {
    return svg([
      bg(7),
      `  <rect x="2.5" y="2.5" width="27" height="27" rx="4.5" fill="none" stroke="${WHITE}"/>`,
      pump(PUMP_32),
    ].join("\n"));
  }
  if (size === 180) {
    return svg([
      bg(40),
      `  <rect x="10.5" y="10.5" width="159" height="159" rx="29.5" fill="none" stroke="${WHITE}" stroke-width="3"/>`,
      pump(PUMP_180),
    ].join("\n"));
  }
  throw new Error(`no design for ${size}`);
}

function png(svg, width) {
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
  "favicon.svg": icon(16),
  "favicon.ico": ico([
    { size: 16, data: png(icon(16), 16) },
    { size: 32, data: png(icon(32), 32) },
  ]),
  "apple-touch-icon.png": png(icon(180, { bleed: true }), 180),
  "icon-192.png": png(icon(180), 192),
  "icon-512.png": png(icon(180), 512),
};

for (const [name, data] of Object.entries(out)) {
  writeFileSync(resolve(PUBLIC, name), data);
  console.log(`public/${name}  ${data.length} bytes`);
}
