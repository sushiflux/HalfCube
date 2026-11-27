// Dev-only demo scenes for the loading screen and the loading panel. They play back a made-up sequence on a timer so
// the screens can be looked at before the engine client exists; real data comes from the engine client later.
// Sizes, file names and times are example values.
import { catalogues } from "../i18n/core.ts";
import type { Language } from "../i18n/types.ts";
import type { LoadingError, LoadingProgress, LoadingStep } from "../ui/loading/types.ts";
import { branding } from "../branding.ts";

export interface ScenarioStep {
  id: string;
  /** Label while waiting or running. */
  active: string;
  /** Label once finished. */
  done: string;
  /** Detail text as a function of the step's fraction (1 = finished). */
  detail?: (fraction: number) => string;
  /** The fraction is a real measured quantity (bytes, faces, timeline steps); otherwise the step counts when finished. */
  measured?: boolean;
  weight: number;
  durationMs: number;
  warning?: boolean;
}

export interface Scenario {
  steps: readonly ScenarioStep[];
  title?: string;
  subtitle?: string;
  note?: string;
  cancellable?: boolean;
  /** Where the sequence breaks. */
  fail?: { step: number; fraction: number; detail?: string; error: LoadingError };
  /** Play again from the start when finished (in-app panels). */
  loop?: boolean;
}

export const demoNames = [
  "start",
  "start-error",
  "panel-open",
  "panel-open-error",
  "panel-step",
  "panel-restart",
  "welcome",
  "gallery",
  "crash",
] as const;

const number = (lang: Language, n: number, digits = 1): string =>
  n.toLocaleString(lang === "de" ? "de-DE" : "en-GB", { minimumFractionDigits: digits, maximumFractionDigits: digits });

export function buildScenario(name: string, lang: Language): Scenario | undefined {
  const L = (de: string, en: string) => (lang === "de" ? de : en);
  const of = (a: string, b: string, unit: string) => (lang === "de" ? `${a} von ${b} ${unit}` : `${a} of ${b} ${unit}`);

  // The real startup steps; their texts live in the catalogue (the engine session drives them in the app).
  const start = catalogues[lang].loading.start;
  const desktopStart: ScenarioStep[] = [
    { id: "engine", active: start.engineActive, done: start.engineDone, detail: () => L("Prozess 14208", "process 14208"), weight: 1, durationMs: 420 },
    { id: "kernel", active: start.kernelActive, done: start.kernelDone, detail: () => "OCCT 8.0.2", weight: 1, durationMs: 520 },
    { id: "solver", active: start.solverActive, done: start.solverDone, detail: () => "planegcs", weight: 1, durationMs: 260 },
  ];

  const engineMissing = (): LoadingError => ({
    headline: L("Engine konnte nicht gestartet werden: halfcube-engine.exe fehlt", "The engine could not be started: halfcube-engine.exe is missing"),
    code: "HC-ENGINE-001",
    details: [
      { kind: "text", text: L(`${branding.name} startet die Engine als eigenen Prozess, damit ein Absturz der Geometrieberechnung nie die Oberfläche mitreißt. Die Programmdatei der Engine wurde nicht gefunden:`, `${branding.name} runs the engine as a separate process so a crash in the geometry never takes the interface down with it. The engine program file was not found:`) },
      { kind: "code", text: `%LOCALAPPDATA%\\${branding.name}\\current\\resources\\engine\\halfcube-engine.exe` },
      { kind: "text", text: L(`Häufige Ursache: Ein Virenschutz hat die Datei in die Quarantäne verschoben. Stelle sie dort wieder her oder installiere ${branding.name} neu – deine Projekte und Einstellungen bleiben dabei erhalten.`, `Common cause: a virus scanner moved the file to quarantine. Restore it there or reinstall ${branding.name} – your projects and settings are kept.`) },
      { kind: "code", text: "Windows 11" },
    ],
    actions: [
      { id: "retry", label: L("Erneut versuchen", "Try again"), primary: true },
      { id: "quit", label: L("Beenden", "Quit") },
    ],
  });

  switch (name) {
    case "start":
      return { steps: desktopStart };
    case "start-error":
      return { steps: desktopStart, fail: { step: 0, fraction: 0, detail: "halfcube-engine.exe", error: engineMissing() } };
    case "panel-open":
      return {
        title: L("Gehäuse.hcube wird geöffnet", "Opening Gehäuse.hcube"),
        subtitle: L(`Dokumente\\${branding.name}\\Gehäuse.hcube · 112,6 MB`, `Documents\\${branding.name}\\Gehäuse.hcube · 112.6 MB`),
        note: L("Abbrechen lässt alles, wie es war.", "Cancel leaves everything as it was."),
        cancellable: true,
        loop: true,
        steps: [
          { id: "read", active: L("Datei wird gelesen", "Reading the file"), done: L("Datei gelesen", "File read"), measured: true, detail: (f) => (f >= 1 ? `${number(lang, 112.6)} MB` : of(number(lang, 112.6 * f), number(lang, 112.6), "MB")), weight: 35, durationMs: 1800 },
          { id: "format", active: L("Format wird geprüft", "Checking the format"), done: L("Format geprüft", "Format checked"), detail: () => L("Formatversion 1", "format version 1"), weight: 5, durationMs: 300 },
          { id: "timeline", active: L("Zeitleiste wird berechnet", "Computing the timeline"), done: L("Zeitleiste berechnet", "Timeline computed"), measured: true, detail: (f) => (f >= 1 ? L("16 Schritte", "16 steps") : `${L("Schritt", "Step")} ${of(String(Math.max(1, Math.ceil(f * 16))), "16", "").trim()}`), weight: 50, durationMs: 3200 },
          { id: "view", active: L("Ansicht wird aufgebaut", "Building the view"), done: L("Ansicht bereit", "View ready"), weight: 10, durationMs: 500 },
        ],
      };
    case "panel-open-error":
      return {
        ...(buildScenario("panel-open", lang) as Scenario),
        loop: false,
        fail: {
          step: 1,
          fraction: 0,
          error: {
            headline: L(`Gehäuse.hcube konnte nicht geöffnet werden: keine ${branding.name}-Datei`, `Gehäuse.hcube could not be opened: not a ${branding.name} file`),
            code: "HC-FILE-003",
            details: [
              { kind: "text", text: L(`In der Datei fehlt manifest.json. ${branding.name} erkennt Projekte an ihrem Inhalt, nicht an der Endung; diese Datei ist beschädigt oder ein anderes ZIP-Archiv mit der Endung .hcube.`, `The file has no manifest.json. ${branding.name} recognises projects by their content, not by the extension; this file is damaged or another ZIP archive named .hcube.`) },
              { kind: "code", text: L(`Dokumente\\${branding.name}\\Gehäuse.hcube`, `Documents\\${branding.name}\\Gehäuse.hcube`) },
              { kind: "text", text: L("Es wurde nichts verändert; geöffnete Projekte bleiben, wie sie waren.", "Nothing was changed; open projects stay as they were.") },
            ],
            actions: [
              { id: "other", label: L("Andere Datei öffnen …", "Open another file …"), primary: true },
              { id: "close", label: L("Schließen", "Close") },
            ],
          },
        },
      };
    case "panel-step":
      return {
        title: L("Halterung_v3.step wird importiert", "Importing Halterung_v3.step"),
        subtitle: L("Downloads\\Halterung_v3.step · 9,8 MB", "Downloads\\Halterung_v3.step · 9.8 MB"),
        note: L("Abbrechen lässt das Projekt unverändert.", "Cancel leaves the project unchanged."),
        cancellable: true,
        loop: true,
        steps: [
          { id: "read", active: L("Datei wird gelesen", "Reading the file"), done: L("Datei gelesen", "File read"), measured: true, detail: (f) => (f >= 1 ? `${number(lang, 9.8)} MB` : of(number(lang, 9.8 * f), number(lang, 9.8), "MB")), weight: 25, durationMs: 1200 },
          { id: "transfer", active: L("Geometrie wird übertragen", "Transferring the geometry"), done: L("Geometrie übertragen", "Geometry transferred"), measured: true, detail: (f) => (f >= 1 ? L("486 Flächen · 2 Körper", "486 faces · 2 bodies") : of(String(Math.round(486 * f)), "486", L("Flächen", "faces"))), weight: 50, durationMs: 2600 },
          { id: "check", active: L("Geometrie wird geprüft", "Checking the geometry"), done: L("Geometrie geprüft", "Geometry checked"), detail: () => L("2 Körper gültig", "2 bodies valid"), weight: 15, durationMs: 700 },
          { id: "view", active: L("Ansicht wird aufgebaut", "Building the view"), done: L("Ansicht bereit", "View ready"), weight: 10, durationMs: 400 },
        ],
      };
    case "panel-restart":
      return {
        title: L("Engine wird neu gestartet", "Restarting the engine"),
        subtitle: L("Modell wird wiederhergestellt · Gehäuse.hcube", "Restoring the model · Gehäuse.hcube"),
        note: L("Deine Änderungen bleiben erhalten; die Zeitleiste wird neu berechnet.", "Your changes are kept; the timeline is computed again."),
        loop: true,
        steps: [
          { id: "crash", active: L("Engine wurde unerwartet beendet", "The engine stopped unexpectedly"), done: L("Engine wurde unerwartet beendet", "The engine stopped unexpectedly"), warning: true, detail: () => L("Exit-Code 0xC0000005", "exit code 0xC0000005"), weight: 0, durationMs: 0 },
          { id: "restart", active: L("Engine wird neu gestartet", "Restarting the engine"), done: L("Engine neu gestartet", "Engine restarted"), detail: () => L("Prozess 15312", "process 15312"), weight: 15, durationMs: 600 },
          { id: "restore", active: L("Modell wird wiederhergestellt", "Restoring the model"), done: L("Modell wiederhergestellt", "Model restored"), measured: true, detail: (f) => (f >= 1 ? L("16 Schritte", "16 steps") : `${L("Schritt", "Step")} ${Math.max(1, Math.ceil(f * 16))} / 16`), weight: 70, durationMs: 3000 },
          { id: "view", active: L("Ansicht wird aufgebaut", "Building the view"), done: L("Ansicht bereit", "View ready"), weight: 15, durationMs: 400 },
        ],
      };
    default:
      return undefined;
  }
}

/** The state of the scenario `elapsedMs` after it started. Pure. */
export function progressAt(scenario: Scenario, elapsedMs: number): LoadingProgress {
  const steps: LoadingStep[] = [];
  let clock = 0;
  let broken = false;
  scenario.steps.forEach((s, index) => {
    const failing = scenario.fail?.step === index;
    const start = clock;
    clock += s.durationMs;
    const base = { id: s.id, weight: s.weight } as const;
    if (broken) {
      steps.push({ ...base, label: s.active, state: "pending" });
      return;
    }
    if (failing && elapsedMs >= start) {
      const reached = Math.min(1, (elapsedMs - start) / Math.max(1, s.durationMs));
      const fraction = Math.min(reached, scenario.fail?.fraction ?? 0);
      // The failure happens once the failing step's own time has run up to the failing point.
      if (reached >= (scenario.fail?.fraction ?? 0)) {
        broken = true;
        steps.push({
          ...base,
          label: s.active,
          state: "failed",
          detail: scenario.fail?.detail ?? (s.measured ? s.detail?.(fraction) ?? "" : ""),
          ...(s.measured ? { fraction } : {}),
        });
        return;
      }
    }
    if (elapsedMs >= clock) {
      steps.push({ ...base, label: s.done, state: s.warning ? "warning" : "done", detail: s.detail?.(1) ?? "" });
    } else if (elapsedMs >= start) {
      const fraction = (elapsedMs - start) / Math.max(1, s.durationMs);
      steps.push({
        ...base,
        label: s.active,
        state: "active",
        detail: s.measured ? (s.detail?.(fraction) ?? "") : "",
        ...(s.measured ? { fraction } : {}),
      });
    } else {
      steps.push({ ...base, label: s.active, state: "pending" });
    }
  });
  const progress: LoadingProgress = { steps };
  if (scenario.title) progress.title = scenario.title;
  if (scenario.subtitle) progress.subtitle = scenario.subtitle;
  if (scenario.note) progress.note = scenario.note;
  if (broken && scenario.fail) progress.error = scenario.fail.error;
  return progress;
}

/** Time until the scenario is finished (or has failed). */
export function scenarioDuration(scenario: Scenario): number {
  return scenario.steps.reduce((sum, s) => sum + s.durationMs, 0);
}
