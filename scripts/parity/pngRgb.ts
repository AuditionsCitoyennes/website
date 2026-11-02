// The tests' one PNG reader, for the DEM tiles only (8-bit truecolour RGB,
// filter 0 on every row): what the API's png.ts and the web's demRaster.ts
// write. Anything else throws. node:zlib's inflate also checks the Adler-32.

import { inflateSync } from "node:zlib";

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export function decodeRgbPng(buf: Uint8Array): { w: number; h: number; rgb: Uint8Array } {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (!SIGNATURE.every((v, i) => b[i] === v)) throw new Error("not a PNG");
  let w = 0;
  let h = 0;
  const idat: Buffer[] = [];
  for (let o = 8; o < b.length;) {
    const len = b.readUInt32BE(o);
    const type = b.toString("ascii", o + 4, o + 8);
    const data = b.subarray(o + 8, o + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 2 || data[12] !== 0) throw new Error("not 8-bit RGB");
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * 3;
  if (raw.length !== h * (stride + 1)) throw new Error(`IDAT holds ${raw.length} bytes`);
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    if (raw[y * (stride + 1)] !== 0) throw new Error(`row ${y}: filter ${raw[y * (stride + 1)]}`);
    rgb.set(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), y * stride);
  }
  return { w, h, rgb };
}
