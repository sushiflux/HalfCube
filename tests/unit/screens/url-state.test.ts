import { describe, expect, it } from "vitest";
import { applyUrlPatch, parseUrlState } from "../../../app/src/screens/main/url-state.ts";

describe("parseUrlState", () => {
  it("reads the screen, the open sketch and the settings tab", () => {
    expect(parseUrlState("?screen=main&sketch=f12&settings=sketch")).toEqual({ screen: "main", sketch: "f12", settings: "sketch" });
  });

  it("ignores anything that is not exactly one of the known values", () => {
    expect(parseUrlState("?screen=other&sketch=f0&settings=colours")).toEqual({});
    expect(parseUrlState("?sketch=f1;drop&settings=")).toEqual({});
    expect(parseUrlState("?sketch=../x")).toEqual({});
    expect(parseUrlState("")).toEqual({});
  });

  it("is not confused by the dev parameters", () => {
    expect(parseUrlState("?theme=graphit&mode=dark&lang=en&demo=welcome&settings=display")).toEqual({ settings: "display" });
  });
});

describe("applyUrlPatch", () => {
  it("adds, changes and removes only its own keys and keeps the rest", () => {
    expect(applyUrlPatch("?lang=en&theme=graphit", { screen: "main" })).toBe("?lang=en&theme=graphit&screen=main");
    expect(applyUrlPatch("?screen=main&sketch=f1", { sketch: "f3" })).toBe("?screen=main&sketch=f3");
    expect(applyUrlPatch("?screen=main&sketch=f1&lang=de", { sketch: null })).toBe("?screen=main&lang=de");
    expect(applyUrlPatch("?settings=display", { settings: null })).toBe("");
  });

  it("leaves a key alone when the patch does not mention it", () => {
    expect(applyUrlPatch("?screen=main&sketch=f1", { settings: "display" })).toBe("?screen=main&sketch=f1&settings=display");
  });

  it("round-trips through the parser", () => {
    const search = applyUrlPatch(applyUrlPatch("", { screen: "main" }), { sketch: "f7", settings: "sketch" });
    expect(parseUrlState(search)).toEqual({ screen: "main", sketch: "f7", settings: "sketch" });
  });
});
