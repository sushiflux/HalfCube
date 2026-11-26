// A small PNG reader for the suite's pixel checks (screenshots from Playwright: 8 bits per channel, RGB or RGBA, not
// interlaced), so a test can look at what the 3D view really drew without an image library.
import { inflateSync } from "node:zlib";

export interface Image {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, row by row from the top. */
  data: Uint8Array;
}

export type Rgb = readonly [number, number, number];

export function decodePng(png: Buffer): Image {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!signature.every((b, i) => png[i] === b)) throw new Error("Not a PNG file.");
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const parts: Buffer[] = [];
  for (let at = 8; at + 8 <= png.length;) {
    const length = png.readUInt32BE(at);
    const type = png.toString("latin1", at + 4, at + 8);
    const body = png.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8]!;
      colorType = body[9]!;
      interlace = body[12]!;
    } else if (type === "IDAT") {
      parts.push(body);
    } else if (type === "IEND") {
      break;
    }
    at += 12 + length;
  }
  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`Unsupported PNG (bit depth ${bitDepth}, colour type ${colorType}, interlace ${interlace}).`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(parts));
  const out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = new Uint8Array(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels]! : 0;
      const b = prev[i]!;
      const c = i >= channels ? prev[i - channels]! : 0;
      let predictor = 0;
      if (filter === 1) predictor = a;
      else if (filter === 2) predictor = b;
      else if (filter === 3) predictor = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[i] = (line[i]! + predictor) & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      out[o] = line[x * channels]!;
      out[o + 1] = line[x * channels + 1]!;
      out[o + 2] = line[x * channels + 2]!;
      out[o + 3] = channels === 4 ? line[x * channels + 3]! : 255;
    }
    prev = line;
  }
  return { width, height, data: out };
}

export function pixelAt(img: Image, x: number, y: number): Rgb {
  const o = (Math.min(img.height - 1, Math.max(0, Math.round(y))) * img.width + Math.min(img.width - 1, Math.max(0, Math.round(x)))) * 4;
  return [img.data[o]!, img.data[o + 1]!, img.data[o + 2]!];
}

export const colourDistance = (a: Rgb, b: Rgb): number => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));

/** "#rrggbb" to numbers. */
export function hexToRgb(hex: string): Rgb {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as unknown as Rgb;
}

/** Mean colour of a square region around a point. */
export function meanColour(img: Image, cx: number, cy: number, half: number): Rgb {
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = Math.round(cy - half); y <= Math.round(cy + half); y++) {
    for (let x = Math.round(cx - half); x <= Math.round(cx + half); x++) {
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      const p = pixelAt(img, x, y);
      r += p[0]; g += p[1]; b += p[2]; n++;
    }
  }
  return n === 0 ? [0, 0, 0] : [r / n, g / n, b / n];
}

/** How many pixels of the image differ from a flat colour by more than the tolerance (a blank canvas has none). */
export function countDifferent(img: Image, from: Rgb, tolerance: number): number {
  let n = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    if (Math.max(Math.abs(img.data[i]! - from[0]), Math.abs(img.data[i + 1]! - from[1]), Math.abs(img.data[i + 2]! - from[2])) > tolerance) n++;
  }
  return n;
}

/** Like countDifferent, but only inside the rectangle from (x0, y0) up to (x1, y1), in the image's pixels. */
export function countDifferentIn(img: Image, rect: { x0: number; y0: number; x1: number; y1: number }, from: Rgb, tolerance: number): number {
  let n = 0;
  for (let y = Math.max(0, Math.floor(rect.y0)); y < Math.min(img.height, Math.ceil(rect.y1)); y++) {
    for (let x = Math.max(0, Math.floor(rect.x0)); x < Math.min(img.width, Math.ceil(rect.x1)); x++) {
      const o = (y * img.width + x) * 4;
      if (Math.max(Math.abs(img.data[o]! - from[0]), Math.abs(img.data[o + 1]! - from[1]), Math.abs(img.data[o + 2]! - from[2])) > tolerance) n++;
    }
  }
  return n;
}

/** Number of distinct colours in the image (quantised to 5 bits per channel). */
export function distinctColours(img: Image): number {
  const seen = new Set<number>();
  for (let i = 0; i < img.data.length; i += 4) seen.add(((img.data[i]! >> 3) << 10) | ((img.data[i + 1]! >> 3) << 5) | (img.data[i + 2]! >> 3));
  return seen.size;
}

/** The most frequent colour of the image: the background of a view that is mostly empty. */
export function dominantColour(img: Image): Rgb {
  const counts = new Map<number, number>();
  for (let i = 0; i < img.data.length; i += 4) {
    const key = (img.data[i]! << 16) | (img.data[i + 1]! << 8) | img.data[i + 2]!;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best = 0, bestCount = -1;
  for (const [key, n] of counts) if (n > bestCount) { best = key; bestCount = n; }
  return [(best >> 16) & 255, (best >> 8) & 255, best & 255];
}
