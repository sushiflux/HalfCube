// Stdio framing of the native engine (layout in engine-protocol.json, constants frameMagic and framePrefixBytes):
// u32 magic, u32 header bytes, u32 payload bytes, u32 reserved, all little-endian, then the header and the payload.
// Plain Uint8Array code without Node APIs, so it runs in the Electron main process and in tests alike.
import { FRAME_MAGIC, FRAME_PREFIX_BYTES, MAX_HEADER_BYTES, MAX_PAYLOAD_BYTES } from "./generated/protocol.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function encodeFrame(header: string, payload?: ArrayBuffer | Uint8Array | null): Uint8Array {
  const h = encoder.encode(header);
  const p = payload ? (payload instanceof Uint8Array ? payload : new Uint8Array(payload)) : new Uint8Array(0);
  if (h.byteLength > MAX_HEADER_BYTES) {
    throw new Error(`The message header is too large: ${h.byteLength} bytes, the limit is ${MAX_HEADER_BYTES}.`);
  }
  if (p.byteLength > MAX_PAYLOAD_BYTES) {
    throw new Error(`The message payload is too large: ${p.byteLength} bytes, the limit is ${MAX_PAYLOAD_BYTES}.`);
  }
  const out = new Uint8Array(FRAME_PREFIX_BYTES + h.byteLength + p.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, FRAME_MAGIC, true);
  view.setUint32(4, h.byteLength, true);
  view.setUint32(8, p.byteLength, true);
  view.setUint32(12, 0, true);
  out.set(h, FRAME_PREFIX_BYTES);
  out.set(p, FRAME_PREFIX_BYTES + h.byteLength);
  return out;
}

export interface DecodedFrame {
  header: string;
  /** A fresh ArrayBuffer holding only the payload (transferable), or null when the payload is empty. */
  payload: ArrayBuffer | null;
}

/**
 * Incremental decoder for a byte stream of frames. push() returns every frame the chunk completes.
 * Throws on a broken stream (bad magic, oversized lengths, header that is not UTF-8); the stream cannot be
 * resynchronised after that, the connection must be dropped.
 */
export class FrameDecoder {
  private chunks: Uint8Array[] = [];
  private buffered = 0;

  push(chunk: Uint8Array): DecodedFrame[] {
    this.chunks.push(chunk);
    this.buffered += chunk.byteLength;
    const out: DecodedFrame[] = [];
    for (;;) {
      if (this.buffered < FRAME_PREFIX_BYTES) break;
      const prefix = this.peek(FRAME_PREFIX_BYTES);
      const view = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength);
      const magic = view.getUint32(0, true);
      if (magic !== FRAME_MAGIC) {
        const bytes = Array.from(prefix.subarray(0, 4), (b) => b.toString(16).padStart(2, "0")).join(" ");
        throw new Error(`The frame stream is broken: expected the magic bytes 50 43 45 31 ("PCE1"), got ${bytes}.`);
      }
      const headerBytes = view.getUint32(4, true);
      const payloadBytes = view.getUint32(8, true);
      if (headerBytes > MAX_HEADER_BYTES) {
        throw new Error(`A frame announces a ${headerBytes} byte header; the limit is ${MAX_HEADER_BYTES}.`);
      }
      if (payloadBytes > MAX_PAYLOAD_BYTES) {
        throw new Error(`A frame announces a ${payloadBytes} byte payload; the limit is ${MAX_PAYLOAD_BYTES}.`);
      }
      const total = FRAME_PREFIX_BYTES + headerBytes + payloadBytes;
      if (this.buffered < total) break;
      const frame = this.take(total);
      const header = decoder.decode(frame.subarray(FRAME_PREFIX_BYTES, FRAME_PREFIX_BYTES + headerBytes));
      let payload: ArrayBuffer | null = null;
      if (payloadBytes > 0) {
        // One copy into an own ArrayBuffer so the payload can be transferred and viewed as typed arrays.
        const copy = new Uint8Array(payloadBytes);
        copy.set(frame.subarray(FRAME_PREFIX_BYTES + headerBytes, total));
        payload = copy.buffer;
      }
      out.push({ header, payload });
    }
    return out;
  }

  private peek(n: number): Uint8Array {
    const first = this.chunks[0]!;
    if (first.byteLength >= n) return first.subarray(0, n);
    const tmp = new Uint8Array(n);
    let offset = 0;
    for (const c of this.chunks) {
      const k = Math.min(c.byteLength, n - offset);
      tmp.set(c.subarray(0, k), offset);
      offset += k;
      if (offset === n) break;
    }
    return tmp;
  }

  private take(n: number): Uint8Array {
    const first = this.chunks[0]!;
    if (first.byteLength >= n) {
      const r = first.subarray(0, n);
      if (first.byteLength === n) this.chunks.shift();
      else this.chunks[0] = first.subarray(n);
      this.buffered -= n;
      return r;
    }
    const out = new Uint8Array(n);
    let offset = 0;
    while (offset < n) {
      const c = this.chunks[0]!;
      const k = Math.min(c.byteLength, n - offset);
      out.set(c.subarray(0, k), offset);
      if (k === c.byteLength) this.chunks.shift();
      else this.chunks[0] = c.subarray(k);
      offset += k;
    }
    this.buffered -= n;
    return out;
  }
}
