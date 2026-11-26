import { describe, expect, it } from "vitest";
import { createEmptyDocument, serializeDocument, type Dimension } from "../../../app/src/document/index.ts";
import { legacySessionDocumentKey, loadSessionDocument, saveSessionDocument, sessionDocumentKey, type SessionStorageLike } from "../../../app/src/screens/main/autosave.ts";
import { document } from "../../fixtures/engine/cases.ts";

function memoryStorage(initial: Record<string, string> = {}): SessionStorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

const doc = () => createEmptyDocument({ rootName: "Teil", documentId: "11111111-1111-4111-8111-111111111111" });

describe("session autosave", () => {
  it("brings back what was saved", () => {
    const store = memoryStorage();
    saveSessionDocument(doc(), store);
    expect(loadSessionDocument(store)).toEqual(doc());
  });

  it("returns nothing when nothing was saved", () => {
    expect(loadSessionDocument(memoryStorage())).toBeUndefined();
    expect(loadSessionDocument(undefined)).toBeUndefined();
  });

  it("drops a stored document that is damaged or does not match the schema", () => {
    const broken = memoryStorage({ [sessionDocumentKey]: "{not json" });
    expect(loadSessionDocument(broken)).toBeUndefined();
    expect(broken.data.has(sessionDocumentKey)).toBe(false);

    const wrong = memoryStorage({ [sessionDocumentKey]: JSON.stringify({ format: 99 }) });
    expect(loadSessionDocument(wrong)).toBeUndefined();
    expect(wrong.data.has(sessionDocumentKey)).toBe(false);
  });

  describe("a document of the older working format (absolute dimension labels)", () => {
    const sketch = {
      points: [
        { id: "p1", x: 0, y: 0 },
        { id: "p2", x: 60, y: 0 },
      ],
      lines: [{ id: "l1", p1: "p1", p2: "p2", construction: false }],
      circles: [],
      constraints: [{ id: "d1", kind: "distance" as const, refs: ["l1"], value: { value: 60, unit: "mm" as const }, driving: true, label: { x: 45, y: -8 } }],
    };
    const labelOf = (d: ReturnType<typeof document> | undefined) => {
      const f = d?.timeline[0];
      return f && f.type === "sketch" ? (f.sketch.constraints[0] as Dimension).label : undefined;
    };

    it("is converted once: the labels become relative and the document moves to the new key", () => {
      const store = memoryStorage({ [legacySessionDocumentKey]: serializeDocument(document(sketch)) });
      const loaded = loadSessionDocument(store);
      expect(labelOf(loaded)).toEqual({ x: 0.25, y: -8 });
      expect(store.data.has(legacySessionDocumentKey)).toBe(false);
      // The next start reads the new key and does not convert again.
      expect(labelOf(loadSessionDocument(store))).toEqual({ x: 0.25, y: -8 });
      expect(store.data.has(sessionDocumentKey)).toBe(true);
    });

    it("the new key wins over an old document that is still there", () => {
      const store = memoryStorage({ [legacySessionDocumentKey]: serializeDocument(document(sketch)) });
      saveSessionDocument(doc(), store);
      expect(loadSessionDocument(store)).toEqual(doc());
    });

    it("a damaged or invalid old document is dropped without an error", () => {
      const damaged = memoryStorage({ [legacySessionDocumentKey]: "{not json" });
      expect(loadSessionDocument(damaged)).toBeUndefined();
      expect(damaged.data.has(legacySessionDocumentKey)).toBe(false);
      const invalid = memoryStorage({ [legacySessionDocumentKey]: JSON.stringify({ format: 1 }) });
      expect(loadSessionDocument(invalid)).toBeUndefined();
      expect(invalid.data.has(legacySessionDocumentKey)).toBe(false);
    });
  });

  it("survives a storage that refuses to write", () => {
    const refusing: SessionStorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => undefined,
    };
    expect(() => saveSessionDocument(doc(), refusing)).not.toThrow();
  });
});
