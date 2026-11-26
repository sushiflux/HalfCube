import { describe, expect, it } from "vitest";
import { defaultView, HALF_PI, viewFromAxis, type ViewState } from "../../../app/src/viewport/camera.ts";
import { discColours, endLabel, navigatorEnds, navigatorMetrics } from "../../../app/src/viewport/navigator-model.ts";
import { contrastRatio } from "../../../app/src/theme/contrast.ts";
import { getTheme, modes, themeKeys } from "../../../app/src/theme/themes.ts";
import { catalogues } from "../../../app/src/i18n/core.ts";

const front: ViewState = { target: [0, 0, 0], azimuth: 0, elevation: 0, distance: 100 };
const size = 128;

describe("navigator layout", () => {
  it("in the front view +X is right of the centre, +Z above it, and the +Y end is behind the centre", () => {
    const ends = navigatorEnds(front, size);
    const byKey = Object.fromEntries(ends.map((e) => [e.key, e]));
    const m = navigatorMetrics(size);
    expect(byKey["+x"]!.x).toBeCloseTo(size / 2 + m.reach, 9);
    expect(byKey["+x"]!.y).toBeCloseTo(size / 2, 9);
    expect(byKey["-x"]!.x).toBeCloseTo(size / 2 - m.reach, 9);
    expect(byKey["+z"]!.y).toBeCloseTo(size / 2 - m.reach, 9);
    expect(byKey["+y"]!.x).toBeCloseTo(size / 2, 9);
    expect(byKey["+y"]!.y).toBeCloseTo(size / 2, 9);
    // the -Y end (front) is towards the viewer, +Y (back) away
    expect(byKey["-y"]!.depth).toBeGreaterThan(byKey["+y"]!.depth);
  });

  it("in the top view +Y is up on the screen and +Z points at the viewer", () => {
    const ends = navigatorEnds(viewFromAxis(front, "+z"), size);
    const byKey = Object.fromEntries(ends.map((e) => [e.key, e]));
    expect(byKey["+y"]!.y).toBeLessThan(size / 2);
    expect(byKey["+z"]!.depth).toBeCloseTo(1, 9);
    expect(ends[ends.length - 1]!.key).toBe("+z");
  });

  it("is sorted farthest first, so the nearest end is drawn on top", () => {
    const ends = navigatorEnds(defaultView(), size);
    for (let i = 1; i < ends.length; i++) expect(ends[i]!.depth).toBeGreaterThanOrEqual(ends[i - 1]!.depth);
  });

  it("positive and negative ends of an axis are mirrored through the centre", () => {
    const ends = navigatorEnds({ ...defaultView(), elevation: 0.4, azimuth: 1.1 }, size);
    for (const axis of ["x", "y", "z"]) {
      const p = ends.find((e) => e.key === `+${axis}`)!, n = ends.find((e) => e.key === `-${axis}`)!;
      expect(p.x + n.x).toBeCloseTo(size, 9);
      expect(p.y + n.y).toBeCloseTo(size, 9);
    }
  });

  it("scales with the size", () => {
    expect(navigatorMetrics(256).reach).toBeCloseTo(navigatorMetrics(128).reach * 2, 9);
    expect(HALF_PI).toBeGreaterThan(1);
  });
});

describe("navigator letters", () => {
  const initials = (lang: "de" | "en") => {
    const i = catalogues[lang].viewport.initials;
    return { top: i.top, bottom: i.bottom, front: i.front, back: i.back, right: i.right, left: i.left };
  };

  it("German: the discs carry O, H, R; the rings are empty at rest and show U, V, L under the pointer", () => {
    const de = initials("de");
    expect(["+z", "+y", "+x"].map((k) => endLabel(k as "+z", "views", de, false))).toEqual(["O", "H", "R"]);
    expect(["-z", "-y", "-x"].map((k) => endLabel(k as "-z", "views", de, false))).toEqual(["", "", ""]);
    expect(["-z", "-y", "-x"].map((k) => endLabel(k as "-z", "views", de, true))).toEqual(["U", "V", "L"]);
  });

  it("English: the discs carry T, Bk, R; the rings show Bm, F, L under the pointer", () => {
    const en = initials("en");
    expect(["+z", "+y", "+x"].map((k) => endLabel(k as "+z", "views", en, false))).toEqual(["T", "Bk", "R"]);
    expect(["-z", "-y", "-x"].map((k) => endLabel(k as "-z", "views", en, true))).toEqual(["Bm", "F", "L"]);
  });

  it("the setting X, Y, Z labels the discs X, Y, Z and the rings -X, -Y, -Z under the pointer only", () => {
    const de = initials("de");
    expect(["+x", "+y", "+z"].map((k) => endLabel(k as "+x", "xyz", de, false))).toEqual(["X", "Y", "Z"]);
    expect(endLabel("-x", "xyz", de, false)).toBe("");
    expect(["-x", "-y", "-z"].map((k) => endLabel(k as "-x", "xyz", de, true))).toEqual(["−X", "−Y", "−Z"]);
  });

  it("the texts exist in both languages, including the full view names for the tooltip", () => {
    for (const lang of ["de", "en"] as const) {
      const v = catalogues[lang].viewport;
      expect(Object.values(v.views).every((s) => s.length > 0)).toBe(true);
      expect(v.again).toContain("{name}");
    }
    expect(catalogues.de.viewport.views.top).toBe("Oben");
    expect(catalogues.en.viewport.views.top).toBe("Top");
  });
});

describe("disc colours", () => {
  it("the letter reaches 4.5:1 on the disc (7:1 in the high-contrast theme) in every theme and mode, for all three axes", () => {
    for (const key of themeKeys) {
      const theme = getTheme(key);
      for (const mode of modes) {
        const t = theme.tokens[mode];
        for (const axis of [t.axisX, t.axisY, t.axisZ]) {
          const d = discColours(axis, t.surface, t.text, theme.highContrast);
          expect(contrastRatio(d.letter, d.fill), `${key}/${mode}/${axis}`).toBeGreaterThanOrEqual((theme.highContrast ? 7 : 4.5) - 0.01);
        }
      }
    }
  });

  it("keeps the axis colour when it already has enough contrast", () => {
    expect(discColours("#000000", "#ffffff", "#000000").fill).toBe("#000000");
  });
});
