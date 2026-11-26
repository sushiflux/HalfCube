// Document store, value reader and schema check.
import { describe, expect, it } from "vitest";
import { createEmptyDocument } from "../../../app/src/document/create.ts";
import { formatQuantity, parseQuantity } from "../../../app/src/document/quantity.ts";
import { DocumentStore } from "../../../app/src/document/store.ts";
import type { HalfCubeDocument } from "../../../app/src/document/types.ts";
import { canonicalDocument, documentProblems, serializeDocument } from "../../../app/src/document/validate.ts";
import { document, rectangle } from "../../fixtures/engine/cases.ts";

const empty = () => createEmptyDocument({ rootName: "Teil", documentId: "doc-1" });

describe("DocumentStore", () => {
  it("commits, undoes and redoes whole document states and notifies on every change", () => {
    const store = new DocumentStore(empty());
    let calls = 0;
    store.subscribe(() => calls++);
    const first = store.getSnapshot();
    const second = store.commit((d) => ({ ...d, components: [{ ...d.components[0]!, name: "Halter" }] }));
    expect(store.getSnapshot()).toBe(second);
    expect(store.canUndo).toBe(true);
    expect(store.undo()).toBe(true);
    expect(store.getSnapshot()).toBe(first);
    expect(store.canRedo).toBe(true);
    expect(store.redo()).toBe(true);
    expect(store.getSnapshot()).toBe(second);
    expect(calls).toBe(3);
    expect(store.getSnapshot()).toBe(store.getSnapshot()); // stable for useSyncExternalStore
  });

  it("never reuses an id: the counter stays up after undo and the next commit writes it", () => {
    const store = new DocumentStore(empty());
    expect(store.newId("l")).toBe("l1");
    store.commit((d) => ({ ...d, components: [{ ...d.components[0]!, name: "A" }] }));
    expect(store.getSnapshot().nextId).toBe(2);
    store.undo();
    expect(store.getSnapshot().nextId).toBe(1);
    expect(store.newId("p")).toBe("p2");
    const next = store.commit((d) => ({ ...d, components: [{ ...d.components[0]!, name: "B" }] }));
    expect(next.nextId).toBe(3);
    expect(store.canRedo).toBe(false);
  });

  it("refuses an invalid document with the path of the problem", () => {
    const store = new DocumentStore(empty());
    expect(() => store.commit((d) => ({ ...d, settings: { lengthUnit: "in" } }) as unknown as HalfCubeDocument)).toThrow(
      /document\.settings\.lengthUnit must be "mm"/,
    );
    expect(store.canUndo).toBe(false);
  });

  it("keeps at most maxUndo steps", () => {
    const store = new DocumentStore(empty(), { maxUndo: 2 });
    for (const name of ["a", "b", "c"]) store.commit((d) => ({ ...d, components: [{ ...d.components[0]!, name }] }));
    expect(store.undo() && store.undo()).toBe(true);
    expect(store.undo()).toBe(false);
  });
});

describe("DocumentStore undo groups", () => {
  const rename = (name: string) => (d: HalfCubeDocument): HalfCubeDocument => ({ ...d, components: [{ ...d.components[0]!, name }] });

  it("commits inside a group are one undo step; one undo and one redo take and bring back all of them", () => {
    const store = new DocumentStore(empty());
    const start = store.getSnapshot();
    const group = store.beginGroup();
    store.commit(rename("a"));
    store.commit(rename("b"));
    const last = store.commit(rename("c"));
    group.close();
    expect(store.getSnapshot().components[0]!.name).toBe("c");
    expect(store.undo()).toBe(true);
    expect(store.getSnapshot()).toBe(start);
    expect(store.canUndo).toBe(false);
    expect(store.redo()).toBe(true);
    expect(store.getSnapshot()).toBe(last);
    expect(store.redo()).toBe(false);
  });

  it("tells the listeners every change and names a joined commit", () => {
    const store = new DocumentStore(empty());
    const kinds: string[] = [];
    store.subscribe(() => kinds.push(store.lastChange));
    store.group(() => {
      store.commit(rename("a"));
      store.commit(rename("b"));
    });
    store.undo();
    store.redo();
    expect(kinds).toEqual(["commit", "join", "undo", "redo"]);
    expect(store.changeCount).toBe(4);
  });

  it("the commit after a group is a step of its own", () => {
    const store = new DocumentStore(empty());
    store.group(() => {
      store.commit(rename("a"));
      store.commit(rename("b"));
    });
    store.commit(rename("c"));
    expect(store.undo()).toBe(true);
    expect(store.getSnapshot().components[0]!.name).toBe("b");
    expect(store.undo()).toBe(true);
    expect(store.canUndo).toBe(false);
  });

  it("a group without a commit leaves no step, and a no-op commit does not start one", () => {
    const store = new DocumentStore(empty());
    store.group(() => store.commit(store.getSnapshot()));
    expect(store.canUndo).toBe(false);
    expect(store.grouping).toBe(false);
  });

  it("a refused (invalid) commit inside a group changes nothing; the group goes on", () => {
    const store = new DocumentStore(empty());
    const group = store.beginGroup();
    store.commit(rename("a"));
    expect(() => store.commit((d) => ({ ...d, settings: { lengthUnit: "in" } }) as unknown as HalfCubeDocument)).toThrow(/lengthUnit/);
    store.commit(rename("b"));
    group.close();
    expect(store.getSnapshot().components[0]!.name).toBe("b");
    store.undo();
    expect(store.canUndo).toBe(false);
  });

  it("groups do not nest; a failed second begin leaves the first one open", () => {
    const store = new DocumentStore(empty());
    const first = store.beginGroup();
    expect(() => store.beginGroup()).toThrow(/already open; groups cannot be nested/);
    expect(() => store.group(() => 1)).toThrow(/cannot be nested/);
    expect(first.open).toBe(true);
    expect(store.grouping).toBe(true);
    first.close();
    expect(first.open).toBe(false);
    expect(store.group(() => 7)).toBe(7);
  });

  it("closing twice is harmless and a stale handle cannot close a newer group", () => {
    const store = new DocumentStore(empty());
    const first = store.beginGroup();
    first.close();
    const second = store.beginGroup();
    first.close();
    expect(second.open).toBe(true);
    expect(store.grouping).toBe(true);
    second.close();
  });

  it("undo, redo and load end the open group; the next commit is a step of its own", () => {
    const store = new DocumentStore(empty());
    store.commit(rename("x"));
    const group = store.beginGroup();
    store.commit(rename("a"));
    store.commit(rename("b"));
    expect(store.undo()).toBe(true); // takes a and b together
    expect(group.open).toBe(false);
    expect(store.getSnapshot().components[0]!.name).toBe("x");
    store.commit(rename("c"));
    expect(store.undo()).toBe(true);
    expect(store.getSnapshot().components[0]!.name).toBe("x");
    const again = store.beginGroup();
    store.load(empty());
    expect(again.open).toBe(false);
  });

  it("a group works with a small undo depth: the joined commits are one step of that depth", () => {
    const store = new DocumentStore(empty(), { maxUndo: 1 });
    const group = store.beginGroup();
    store.commit(rename("a"));
    store.commit(rename("b")); // joins
    expect(store.canUndo).toBe(true);
    group.close();
    // Depth 1: one step holds both commits.
    expect(store.undo()).toBe(true);
    expect(store.getSnapshot().components[0]!.name).toBe("Teil");
    expect(store.canUndo).toBe(false);
  });

  it("an async group stays open until the action settles and closes on a throw", async () => {
    const store = new DocumentStore(empty());
    await store.groupAsync(async () => {
      store.commit(rename("a"));
      await Promise.resolve();
      expect(store.grouping).toBe(true);
      store.commit(rename("b"));
    });
    expect(store.grouping).toBe(false);
    await expect(
      store.groupAsync(async () => {
        store.commit(rename("c"));
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");
    expect(store.grouping).toBe(false);
    store.undo();
    expect(store.getSnapshot().components[0]!.name).toBe("b");
    store.undo();
    expect(store.canUndo).toBe(false);
  });
});

describe("parseQuantity", () => {
  const len = (s: string) => parseQuantity(s, "length");
  const ang = (s: string) => parseQuantity(s, "angle");
  it("reads lengths in mm, cm, m and inches, with a German decimal comma", () => {
    expect(len("40")).toEqual({ ok: true, value: { value: 40, unit: "mm" } });
    expect(len("40 mm")).toEqual({ ok: true, value: { value: 40, unit: "mm" } });
    expect(len(" 4 cm ")).toEqual({ ok: true, value: { value: 40, unit: "mm" } });
    expect(len("1.5 in")).toEqual({ ok: true, value: { value: 38.1, unit: "mm" } });
    expect(len("12,5")).toEqual({ ok: true, value: { value: 12.5, unit: "mm" } });
    expect(len("0,5m")).toEqual({ ok: true, value: { value: 500, unit: "mm" } });
    expect(len("-10")).toEqual({ ok: true, value: { value: -10, unit: "mm" } });
    expect(len(".5")).toEqual({ ok: true, value: { value: 0.5, unit: "mm" } });
  });
  it("reads angles in degrees", () => {
    expect(ang("30°")).toEqual({ ok: true, value: { value: 30, unit: "deg" } });
    expect(ang("30 deg")).toEqual({ ok: true, value: { value: 30, unit: "deg" } });
    expect(ang("45")).toEqual({ ok: true, value: { value: 45, unit: "deg" } });
    expect(ang(`${Math.PI / 2} rad`)).toEqual({ ok: true, value: { value: 90, unit: "deg" } });
  });
  it("names what is wrong", () => {
    expect(len("")).toMatchObject({ ok: false, error: "empty" });
    expect(len("abc")).toMatchObject({ ok: false, error: "notANumber" });
    expect(len("1.2.3")).toMatchObject({ ok: false, error: "notANumber" });
    expect(len("40 yd")).toMatchObject({ ok: false, error: "unknownUnit", unit: "yd" });
    expect(len("30°")).toMatchObject({ ok: false, error: "wrongUnit", unit: "°" });
    expect(ang("30 mm")).toMatchObject({ ok: false, error: "wrongUnit", unit: "mm" });
    expect(parseQuantity("0", "length", { sign: "positive" })).toMatchObject({ ok: false, error: "notPositive" });
    expect(parseQuantity("-3", "length", { sign: "positive" })).toMatchObject({ ok: false, error: "notPositive" });
    expect(parseQuantity("0", "length", { sign: "nonZero" })).toMatchObject({ ok: false, error: "zero" });
    expect(len("200 m")).toMatchObject({ ok: false, error: "tooLarge" });
  });
  it("formats values for an input field", () => {
    expect(formatQuantity({ value: 12.5, unit: "mm" })).toBe("12.5 mm");
    expect(formatQuantity({ value: 12.5, unit: "mm" }, true)).toBe("12,5 mm");
    expect(formatQuantity({ value: 30, unit: "deg" })).toBe("30°");
    expect(formatQuantity({ value: 1 / 3, unit: "mm" })).toBe("0.333333 mm");
  });
});

describe("document schema", () => {
  it("accepts a valid document and names every problem with its path", () => {
    expect(documentProblems(document(rectangle(3)))).toEqual([]);
    expect(documentProblems(empty())).toEqual([]);
    const bad = document(rectangle(3)) as unknown as { timeline: { distance?: { value: unknown } }[]; extra?: number };
    bad.timeline[1]!.distance!.value = "10";
    bad.extra = 1;
    const problems = documentProblems(bad);
    expect(problems).toContain('document.timeline[1].distance.value must be of type number, got "10".');
    expect(problems).toContain("document.extra is not a field of this object.");
  });

  it("writes keys in the fixed order of the type description, whatever order the object was built in", () => {
    const doc = document(rectangle(1));
    const reverse = (v: unknown): unknown =>
      Array.isArray(v) ? v.map(reverse) : v !== null && typeof v === "object" ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverse(x)])) : v;
    const reordered = reverse(doc) as HalfCubeDocument;
    expect(Object.keys(reordered)[0]).toBe("timeline");
    expect(serializeDocument(reordered)).toBe(serializeDocument(doc));
    expect(Object.keys(canonicalDocument(reordered))).toEqual(["format", "documentId", "settings", "nextId", "parameters", "components", "timeline"]);
    expect(Object.keys(canonicalDocument(reordered).timeline[1]!)).toEqual([
      "id", "type", "name", "component", "profile", "extent", "distance", "operation", "body",
    ]);
  });
});
