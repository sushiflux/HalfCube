// Stdio framing of the native transport (layout in protocol.hpp). Plain Uint8Array code, no Node APIs.
import { FRAME_MAGIC, FRAME_PREFIX_BYTES, MAX_HEADER_BYTES, MAX_PAYLOAD_BYTES } from "./protocol.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function encodeFrame(header: string, payload?: ArrayBuffer | Uint8Array | null): Uint8Array {
  const h = encoder.encode(header);
  const p = payload ? (payload instanceof Uint8Array ? payload : new Uint8Array(payload)) : new Uint8Array(0);
  if (h.byteLength > MAX_HEADER_BYTES) throw new Error(`header too large: ${h.byteLength} bytes`);
  if (p.byteLength > MAX_PAYLOAD_BYTES) throw new Error(`payload too large: ${p.byteLength} bytes`);
  const out = new Uint8Array(FRAME_PREFIX_BYTES + h.byteLength + p.byteLength);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, FRAME_MAGIC, true);
  dv.setUint32(4, h.byteLength, true);
  dv.setUint32(8, p.byteLength, true);
  dv.setUint32(12, 0, true);
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
 * Incremental decoder for a byte stream of frames. push() returns every frame completed by the chunk.
 * Throws on a broken stream (bad magic, oversized lengths); the stream cannot be resynchronised after that.
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
      const dv = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength);
      const magic = dv.getUint32(0, true);
      if (magic !== FRAME_MAGIC) {
        const hex = Array.from(prefix.subarray(0, 4), (b) => b.toString(16).padStart(2, "0")).join(" ");
        throw new Error(`frame stream broken: expected magic "PCE0", got bytes ${hex}`);
      }
      const hLen = dv.getUint32(4, true);
      const pLen = dv.getUint32(8, true);
      if (hLen > MAX_HEADER_BYTES) throw new Error(`frame header length ${hLen} exceeds ${MAX_HEADER_BYTES}`);
      if (pLen > MAX_PAYLOAD_BYTES) throw new Error(`frame payload length ${pLen} exceeds ${MAX_PAYLOAD_BYTES}`);
      const total = FRAME_PREFIX_BYTES + hLen + pLen;
      if (this.buffered < total) break;
      const frame = this.take(total);
      const header = decoder.decode(frame.subarray(FRAME_PREFIX_BYTES, FRAME_PREFIX_BYTES + hLen));
      let payload: ArrayBuffer | null = null;
      if (pLen > 0) {
        // One copy into an own, aligned ArrayBuffer so the payload can be transferred and viewed as typed arrays.
        const p = new Uint8Array(pLen);
        p.set(frame.subarray(FRAME_PREFIX_BYTES + hLen, total));
        payload = p.buffer;
      }
      out.push({ header, payload });
    }
    return out;
  }

  private peek(n: number): Uint8Array {
    const first = this.chunks[0]!;
    if (first.byteLength >= n) return first.subarray(0, n);
    const tmp = new Uint8Array(n);
    let o = 0;
    for (const c of this.chunks) {
      const k = Math.min(c.byteLength, n - o);
      tmp.set(c.subarray(0, k), o);
      o += k;
      if (o === n) break;
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
    let o = 0;
    while (o < n) {
      const c = this.chunks[0]!;
      const k = Math.min(c.byteLength, n - o);
      out.set(c.subarray(0, k), o);
      o += k;
      if (k === c.byteLength) this.chunks.shift();
      else this.chunks[0] = c.subarray(k);
    }
    this.buffered -= n;
    return out;
  }
}
