import { describe, expect, it } from "vitest";
import { createEmptyDocument } from "../../../app/src/document/index.ts";
import type { HalfCubeDocument, SketchFeature } from "../../../app/src/document/types.ts";
import { makeState } from "../../../app/src/i18n/core.ts";
import { failureText } from "../../../app/src/screens/main/extrude-messages.ts";
import type { CommandFailure } from "../../../app/src/screens/main/extrude-command.ts";

const problem = { code: "result_implausible" as const, message: "Volume 1 does not match 2.", values: { volume: 1, expectedVolume: 2 } };

describe("the words of a failure in the extrude dialog", () => {
  const t = makeState("de").t;
  const te = makeState("en").t;

  it("a refused preview says what failed and why, with the engine's own line for the copy button", () => {
    const text = failureText(t, { kind: "preview", problem });
    expect(text.title).toContain("Vorschau nicht möglich: Das Ergebnis dieses Schritts passt nicht zur Skizze (Volumen 1 mm³ statt 2 mm³)");
    expect(text.code).toBe("HC-EXTRUDE-RESULT_IMPLAUSIBLE");
    expect(text.blocks.at(-1)).toEqual({ kind: "code", text: "Engine: Volume 1 does not match 2." });
  });

  it("a refused OK names the document as unchanged", () => {
    const text = failureText(t, { kind: "rejected", problem });
    expect(text.title.startsWith("Extrusion nicht übernommen: ")).toBe(true);
    expect(text.blocks[0]?.text).toContain("das Dokument bleibt unverändert");
  });

  it("an engine that did not answer says the values are kept and carries the error for the copy button", () => {
    const text = failureText(te, { kind: "engine", error: new Error("The engine worker was terminated") });
    expect(text.code).toBe("HC-EXTRUDE-ENGINE");
    expect(text.blocks[0]?.text).toContain("Your input is kept");
    expect(text.blocks[1]?.text).toBe("Error: The engine worker was terminated");
  });

  it("every failure has a headline, a code and technical details, in both languages", () => {
    const failures: CommandFailure[] = [
      { kind: "preview", problem },
      { kind: "rejected", problem },
      { kind: "engine", error: new Error("x") },
      { kind: "invalid", message: "Choose a profile to extrude first." },
    ];
    for (const tr of [t, te]) {
      for (const f of failures) {
        const text = failureText(tr, f);
        expect(text.title).not.toBe("");
        expect(text.code).toMatch(/^HC-EXTRUDE-/);
        expect(text.blocks.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("a failure names the steps and shapes of the document, not their ids", () => {
  const sketch: SketchFeature = {
    id: "f1",
    type: "sketch",
    name: "Skizze1",
    component: "root",
    visible: true,
    plane: { kind: "originPlane", plane: "xy" },
    sketch: {
      points: [],
      lines: [{ id: "l2", p1: "p1", p2: "p2", construction: false }],
      circles: [{ id: "c3", center: "p9", radius: 4, construction: false }],
      constraints: [],
      steps: [
        { id: "s5", kind: "rectangle", number: 1, members: ["p1", "p2", "l2"] },
        { id: "s6", kind: "circle", number: 2, members: ["p9", "c3"] },
      ],
    },
  };
  const doc: HalfCubeDocument = { ...createEmptyDocument({ rootName: "Teil" }), timeline: [sketch] };
  const ID = /\b[plckfs]\d+\b/;
  const crossing = { code: "profile_intersecting" as const, message: "Curves l2 and c3 cross.", refs: ["l2", "c3"] };
  const upstream = { code: "upstream_failed" as const, message: "Step f1 failed.", refs: ["f1"] };

  it("German and English: Rechteck 1, Kreis 2 and Skizze1 in the headline and in the engine's line", () => {
    const de = failureText(makeState("de").t, { kind: "preview", problem: crossing }, { doc, decimalComma: true });
    expect(de.title).toContain("(Rechteck 1, Kreis 2)");
    expect(de.blocks.at(-1)).toEqual({ kind: "code", text: "Engine: Curves Rechteck 1 and Kreis 2 cross." });
    const en = failureText(makeState("en").t, { kind: "rejected", problem: crossing }, { doc, decimalComma: false });
    expect(en.title).toContain("(Rectangle 1, Circle 2)");
    const up = failureText(makeState("de").t, { kind: "preview", problem: upstream }, { doc, decimalComma: true });
    expect(up.title).toContain("(Skizze1)");
    expect(up.blocks.at(-1)).toEqual({ kind: "code", text: "Engine: Step Skizze1 failed." });
    for (const text of [de, en, up]) expect(JSON.stringify(text)).not.toMatch(ID);
  });

  it("without a document the kind words stand in, still no id", () => {
    const text = failureText(makeState("de").t, { kind: "preview", problem: crossing });
    expect(text.title).toContain("(Linie, Kreis)");
    expect(JSON.stringify(text.title)).not.toMatch(ID);
  });
});
