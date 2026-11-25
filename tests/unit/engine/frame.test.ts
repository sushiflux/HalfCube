import { describe, expect, it } from "vitest";
import { encodeFrame, FrameDecoder } from "../../../app/src/engine/frame.ts";
import { FRAME_MAGIC, FRAME_PREFIX_BYTES, MAX_HEADER_BYTES } from "../../../app/src/engine/generated/protocol.ts";

describe("frame encoding", () => {
  it("writes the 16-byte prefix with magic PCE1, lengths and a zero reserved word", () => {
    const frame = encodeFrame('{"a":1}', new Uint8Array([1, 2, 3]));
    const view = new DataView(frame.buffer);
    expect(frame.byteLength).toBe(FRAME_PREFIX_BYTES + 7 + 3);
    expect(Array.from(frame.subarray(0, 4))).toEqual([0x50, 0x43, 0x45, 0x31]);
    expect(view.getUint32(0, true)).toBe(FRAME_MAGIC);
    expect(view.getUint32(4, true)).toBe(7);
    expect(view.getUint32(8, true)).toBe(3);
    expect(view.getUint32(12, true)).toBe(0);
  });

  it("round-trips header and payload, also when the stream arrives in single bytes", () => {
    const payload = new Uint8Array(100).map((_, i) => i);
    const bytes = new Uint8Array([...encodeFrame('{"x":"ä"}', payload), ...encodeFrame("{}")]);
    const decoder = new FrameDecoder();
    const frames = [];
    for (const b of bytes) frames.push(...decoder.push(new Uint8Array([b])));
    expect(frames).toHaveLength(2);
    expect(frames[0]!.header).toBe('{"x":"ä"}');
    expect(Array.from(new Uint8Array(frames[0]!.payload!))).toEqual(Array.from(payload));
    expect(frames[1]!.payload).toBeNull();
  });

  it("returns several frames from one chunk and keeps a partial one for the next", () => {
    const a = encodeFrame('{"n":1}');
    const b = encodeFrame('{"n":2}');
    const decoder = new FrameDecoder();
    const first = decoder.push(new Uint8Array([...a, ...b.subarray(0, 10)]));
    expect(first.map((f) => f.header)).toEqual(['{"n":1}']);
    const second = decoder.push(b.subarray(10));
    expect(second.map((f) => f.header)).toEqual(['{"n":2}']);
  });

  it("names the broken magic bytes", () => {
    const bad = new Uint8Array(16);
    bad.set([0x50, 0x43, 0x45, 0x30]);
    expect(() => new FrameDecoder().push(bad)).toThrow(/expected the magic bytes 50 43 45 31.*got 50 43 45 30/);
  });

  it("refuses an oversized header announcement and an oversized header to encode", () => {
    const frame = encodeFrame("{}");
    new DataView(frame.buffer).setUint32(4, MAX_HEADER_BYTES + 1, true);
    expect(() => new FrameDecoder().push(frame)).toThrow(/header; the limit is/);
    expect(() => encodeFrame("x".repeat(MAX_HEADER_BYTES + 1))).toThrow(/header is too large/);
  });

  it("refuses a header that is not UTF-8", () => {
    const frame = encodeFrame("abc");
    frame[FRAME_PREFIX_BYTES] = 0xff;
    expect(() => new FrameDecoder().push(frame)).toThrow(/not valid/);
  });
});
