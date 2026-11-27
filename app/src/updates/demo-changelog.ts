import { branding } from "../branding.ts";
// DEV BUILDS ONLY (see demo-bridge.ts). A made-up customer changelog in the frame of the shipped channel files, with three entries
// newer than the running version, so the update window and "Was ist neu" have something to show.

/** The ids of the three demo entries, relative to the running version: the third segment (commit of the year) counts up. */
export function demoIds(installedId: string): { offer: string; middle: string; oldest: string; newer: string } {
  const m = /^v(\d+)\.(\d+)\.(\d+)\./.exec(installedId);
  const [year, month, n] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [2026, 11, 1];
  return {
    oldest: `v${year}.${month}.${n + 1}.1.1520`,
    middle: `v${year}.${month}.${n + 3}.3.2894`,
    offer: `v${year}.${month}.${n + 4}.4.4410`,
    newer: `v${year}.${month}.${n + 5}.5.4920`,
  };
}

/** The days the three demo versions came out (different days, so the dates in the dialogs read like a real changelog). */
export const DEMO_DATES = { offer: "2026-11-26", middle: "2026-11-24", oldest: "2026-11-19" } as const;

interface Line {
  area: readonly [string, string];
  category: readonly ["new" | "change" | "fix" | "security", string, string];
  de: string;
  en: string;
}

const AREA = {
  sketch: ["Skizze", "Sketch"],
  body: ["Körper", "Bodies"],
  view: ["Ansicht & Navigation", "View & navigation"],
  ui: ["Oberfläche & Einstellungen", "Interface & settings"],
  install: ["Installation & Updates", "Installation & updates"],
  general: ["Allgemein", "General"],
} as const satisfies Record<string, [string, string]>;

const CAT = {
  new: ["new", "✨", "Neu"],
  change: ["change", "🔄", "Geändert"],
  fix: ["fix", "🔧", "Behoben"],
  security: ["security", "🔒", "Sicherheit"],
} as const;
const CAT_EN = { new: "New", change: "Change", fix: "Fix", security: "Security" } as const;

function entryLines(): Record<"offer" | "middle" | "oldest", Line[]> {
  const l = (area: keyof typeof AREA, cat: keyof typeof CAT, de: string, en: string): Line => ({ area: AREA[area], category: CAT[cat], de, en });
  return {
    offer: [
      l("sketch", "new", "Kreise zeichnest du über drei Punkte.", "Draw a circle through three points."),
      l("sketch", "fix", "Maße springen nicht mehr, wenn du die Ansicht drehst.", "Dimensions no longer jump when you rotate the view."),
      l("body", "change", "Verrundungen zeigen schon beim Tippen des Radius eine Vorschau.", "Fillets show a preview while you type the radius."),
      l("install", "new", `${branding.name} sucht selbst nach Updates und installiert sie mit einem Klick.`, `${branding.name} checks for updates by itself and installs them with one click.`),
      l("install", "new", "Nach jedem Update zeigt „Was ist neu“, was dazugekommen ist.", "After every update “What’s new” shows what was added."),
      l("general", "fix", "Mehrere kleine Fehler behoben.", "Several small bugs fixed."),
    ],
    middle: [
      l("sketch", "new", "Ein Doppelklick auf eine Linie zeigt ihre Abhängigkeiten.", "Double-click a line to see its constraints."),
      l("view", "change", "Das Mausrad zoomt zum Mauszeiger statt zur Bildmitte.", "The mouse wheel zooms towards the pointer instead of the view centre."),
      l("ui", "new", "Neues Farbthema „Dämmerung“ für lange Abende.", "New colour theme “Dämmerung” for long evenings."),
      l("ui", "fix", "Die Einstellungen öffnen nach F5 wieder auf dem zuletzt gewählten Reiter.", "Settings reopen on the last chosen tab after F5."),
      l("general", "security", "Sicherheitsupdates der verwendeten Komponenten.", "Security updates of the components used."),
    ],
    oldest: [
      l("body", "new", "Bohrungen legst du mit Durchmesser und Tiefe an.", "Create holes with a diameter and a depth."),
      l("body", "fix", "Verrundungen an sehr kurzen Kanten schlagen nicht mehr fehl.", "Fillets on very short edges no longer fail."),
      l("view", "change", "Die Rasterlinien bleiben beim Herauszoomen gleichmäßig sichtbar.", "Grid lines stay evenly visible when you zoom out."),
      l("general", "change", "Technische Grundlage aktualisiert.", "Technical foundation updated."),
    ],
  };
}

function section(language: "de" | "en", id: string, date: string, lines: Line[]): string {
  const out: string[] = [`## ${id} (α) · ${date}`, ""];
  const areas = [...new Set(lines.map((x) => x.area[0]))];
  for (const area of areas) {
    const inArea = lines.filter((x) => x.area[0] === area);
    out.push(`### ${language === "de" ? inArea[0]?.area[0] : inArea[0]?.area[1]}`);
    for (const x of inArea) {
      const general = x.area[0] === AREA.general[0];
      const [key, emoji] = x.category;
      const label = language === "de" ? x.category[2] : CAT_EN[key];
      out.push(general ? `- ${emoji} ${language === "de" ? x.de : x.en}` : `- ${emoji} **${label}:** ${language === "de" ? x.de : x.en}`);
    }
    out.push("");
  }
  return out.join("\n");
}

/** The demo changelog in the frame of a channel file: English section first, then German, newest entry on top. */
export function demoChangelogMarkdown(installedId: string): string {
  const ids = demoIds(installedId);
  const entries = entryLines();
  const part = (language: "de" | "en") =>
    [section(language, ids.offer, DEMO_DATES.offer, entries.offer), section(language, ids.middle, DEMO_DATES.middle, entries.middle), section(language, ids.oldest, DEMO_DATES.oldest, entries.oldest)].join("\n");
  return ["# Changelog", "", "**[English](#english) · [Deutsch](#deutsch)**", "", '<a name="english"></a>', "## English", "", part("en"), '<a name="deutsch"></a>', "## Deutsch", "", part("de")].join("\n");
}
