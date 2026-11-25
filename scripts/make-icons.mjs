// Scales the logo (square PNG with transparency) to the icon sizes and packs a Windows .ico. The logo is only
// resampled (area averaging in linear light with premultiplied alpha); it is never redrawn, cropped or recoloured.
// Input:  branding/source/logo-square.png      Output: branding/icons/icon-<size>.png and branding/icons/icon.ico
// Usage:  node scripts/make-icons.mjs
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync, inflateSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "branding", "source", "logo-square.png");
const outDir = join(root, "branding", "icons");
const pngSizes = [16, 24, 32, 48, 64, 128, 256, 512];
const icoSizes = [16, 24, 32, 48, 64, 128, 256];

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Decodes an 8-bit RGBA, non-interlaced PNG into { width, height, data (RGBA bytes) }. */
function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error("Not a PNG file.");
  let pos = 8;
  let header = null;
  const idat = [];
  while (pos < buf.length) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + length);
    if (type === "IHDR") {
      header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], colour: body[9], interlace: body[12] };
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    pos += 12 + length;
  }
  if (!header || header.depth !== 8 || header.colour !== 6 || header.interlace !== 0) {
    throw new Error("Only 8-bit RGBA PNG files without interlacing are supported.");
  }
  const { width, height } = header;
  const stride = width * 4;
  const raw = inflateSync(Buffer.concat(idat));
  const data = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? data[y * stride + x - 4] : 0;
      const b = y > 0 ? data[(y - 1) * stride + x] : 0;
      const c = x >= 4 && y > 0 ? data[(y - 1) * stride + x - 4] : 0;
      let predictor = 0;
      if (filter === 1) predictor = a;
      else if (filter === 2) predictor = b;
      else if (filter === 3) predictor = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error(`Unknown PNG filter ${filter}.`);
      data[y * stride + x] = (line[x] + predictor) & 0xff;
    }
  }
  return { width, height, data };
}

function chunk(type, body) {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, "ascii");
  body.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

/** Encodes RGBA bytes as an 8-bit RGBA PNG (filter 0 on every line). */
function encodePng(width, height, data) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

// sRGB <-> linear light lookup tables
const toLinear = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const s = i / 255;
  toLinear[i] = s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}
const toSrgb8 = (l) => {
  const s = l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(s * 255)));
};

/** Box-filter downscale with fractional pixel coverage, in linear light with premultiplied alpha. */
function resize({ width, height, data }, size) {
  const out = Buffer.alloc(size * size * 4);
  const scaleX = width / size, scaleY = height / size;
  for (let oy = 0; oy < size; oy++) {
    const y0 = oy * scaleY, y1 = y0 + scaleY;
    for (let ox = 0; ox < size; ox++) {
      const x0 = ox * scaleX, x1 = x0 + scaleX;
      let r = 0, g = 0, b = 0, a = 0, weight = 0;
      for (let y = Math.floor(y0); y < Math.min(height, Math.ceil(y1)); y++) {
        const wy = Math.min(y + 1, y1) - Math.max(y, y0);
        for (let x = Math.floor(x0); x < Math.min(width, Math.ceil(x1)); x++) {
          const w = wy * (Math.min(x + 1, x1) - Math.max(x, x0));
          const i = (y * width + x) * 4;
          const alpha = data[i + 3] / 255;
          r += toLinear[data[i]] * alpha * w;
          g += toLinear[data[i + 1]] * alpha * w;
          b += toLinear[data[i + 2]] * alpha * w;
          a += alpha * w;
          weight += w;
        }
      }
      const o = (oy * size + ox) * 4;
      const alpha = a / weight;
      if (alpha > 0) {
        out[o] = toSrgb8(r / weight / alpha);
        out[o + 1] = toSrgb8(g / weight / alpha);
        out[o + 2] = toSrgb8(b / weight / alpha);
      }
      out[o + 3] = Math.round(alpha * 255);
    }
  }
  return out;
}

/** Packs PNG images into an .ico container (PNG-compressed entries). */
function packIco(images) {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2); // type: icon
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ size, png }, i) => {
    const e = 6 + 16 * i;
    head[e] = size >= 256 ? 0 : size;
    head[e + 1] = size >= 256 ? 0 : size;
    head.writeUInt16LE(1, e + 4); // colour planes
    head.writeUInt16LE(32, e + 6); // bits per pixel
    head.writeUInt32LE(png.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([head, ...images.map((i) => i.png)]);
}

const logo = decodePng(readFileSync(source));
if (logo.width !== logo.height) throw new Error(`The logo must be square, got ${logo.width}x${logo.height}.`);
mkdirSync(outDir, { recursive: true });
const pngs = new Map();
for (const size of pngSizes) {
  const png = encodePng(size, size, resize(logo, size));
  pngs.set(size, png);
  writeFileSync(join(outDir, `icon-${size}.png`), png);
  console.log(`icon-${size}.png`);
}
writeFileSync(join(outDir, "icon.ico"), packIco(icoSizes.map((size) => ({ size, png: pngs.get(size) }))));
console.log(`icon.ico (${icoSizes.join(", ")})`);
