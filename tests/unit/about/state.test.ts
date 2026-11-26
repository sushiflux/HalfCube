import { describe, expect, it } from "vitest";
import { aboutFromUrl, aboutToPatch, createAboutStore, type AboutState } from "../../../app/src/about/state.ts";
import { applyUrlPatch, parseUrlState } from "../../../app/src/screens/main/url-state.ts";

describe("the address of the About view", () => {
  it("reads the open tab and the chosen component", () => {
    expect(parseUrlState("?about=licenses&item=occt")).toEqual({ about: "licenses", item: "occt" });
    expect(parseUrlState("?about=info")).toEqual({ about: "info" });
  });

  it("ignores an unknown tab, and an item on the Info tab or one that is no plain id", () => {
    expect(parseUrlState("?about=history")).toEqual({});
    expect(parseUrlState("?about=info&item=occt")).toEqual({ about: "info" });
    expect(parseUrlState("?about=licenses&item=../x")).toEqual({ about: "licenses" });
    expect(parseUrlState("?about=licenses&item=OCCT")).toEqual({ about: "licenses" });
    expect(parseUrlState("?item=occt")).toEqual({});
  });

  it("turns into a state and back, and closing removes both keys", () => {
    expect(aboutFromUrl(parseUrlState("?about=licenses&item=occt"))).toEqual({ tab: "licenses", item: "occt" });
    expect(aboutFromUrl(parseUrlState("?about=info"))).toEqual({ tab: "info", item: null });
    expect(aboutFromUrl(parseUrlState("?screen=main"))).toBeNull();
    const open = applyUrlPatch("?screen=main&lang=en", aboutToPatch({ tab: "licenses", item: "occt" }));
    expect(open).toBe("?screen=main&lang=en&about=licenses&item=occt");
    expect(applyUrlPatch(open, aboutToPatch(null))).toBe("?screen=main&lang=en");
    expect(applyUrlPatch(open, aboutToPatch({ tab: "info", item: null }))).toBe("?screen=main&lang=en&about=info");
  });
});

describe("the About store", () => {
  const make = (initial: AboutState | null = null) => {
    const saved: (AboutState | null)[] = [];
    const store = createAboutStore(initial, (s) => saved.push(s));
    return { store, saved };
  };

  it("opens on the Info tab by default and on the Lizenzen tab with a component when asked", () => {
    const { store, saved } = make();
    expect(store.get()).toBeNull();
    store.open();
    expect(store.get()).toEqual({ tab: "info", item: null });
    store.open({ tab: "licenses", item: "partcraft" });
    expect(store.get()).toEqual({ tab: "licenses", item: "partcraft" });
    expect(saved).toHaveLength(2);
  });

  it("never carries a component on the Info tab", () => {
    const { store } = make();
    store.open({ tab: "info", item: "occt" });
    expect(store.get()).toEqual({ tab: "info", item: null });
    store.open({ tab: "licenses", item: "occt" });
    store.setTab("info");
    expect(store.get()).toEqual({ tab: "info", item: null });
  });

  it("opens a component's page and goes back to the list", () => {
    const { store } = make({ tab: "licenses", item: null });
    store.setItem("occt");
    expect(store.get()).toEqual({ tab: "licenses", item: "occt" });
    store.setItem(null);
    expect(store.get()).toEqual({ tab: "licenses", item: null });
  });

  it("ignores tab and item changes while closed", () => {
    const { store, saved } = make();
    store.setTab("licenses");
    store.setItem("occt");
    expect(store.get()).toBeNull();
    expect(saved).toEqual([]);
  });

  it("remembers the last open state for the closing animation and tells listeners", () => {
    const { store } = make();
    let calls = 0;
    const off = store.subscribe(() => (calls += 1));
    store.open({ tab: "licenses", item: "occt" });
    store.close();
    expect(store.get()).toBeNull();
    expect(store.lastOpen()).toEqual({ tab: "licenses", item: "occt" });
    off();
    store.open();
    expect(calls).toBe(2);
  });

  it("starts open when the address said so (a reload keeps the view)", () => {
    expect(make(aboutFromUrl(parseUrlState("?about=licenses&item=occt"))).store.get()).toEqual({ tab: "licenses", item: "occt" });
  });
});
