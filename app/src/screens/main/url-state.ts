// What the URL remembers, so a reload (F5) keeps the user exactly where they were: past the welcome screen (`screen=main`),
// the open sketch (`sketch=f1`), the open settings dialog with its tab (`settings=display|sketch`) and the open "About
// HalfCube" view with its tab and chosen component (`about=info|licenses`, `item=occt`), the update views (`update=window|restart|error`)
// "Was ist neu" (`news=1`) and "Alle Änderungen" (`changes=app|update`). The dev-only
// parameters (theme, mode, lang, demo ...) are left untouched. Parsing and building are pure functions; only patchUrl
// touches the address bar, with replaceState, so the back button does not collect a step for every click.

export const settingsTabs = ["display", "sketch", "updates"] as const;
export type SettingsTab = (typeof settingsTabs)[number];

export const aboutTabs = ["info", "licenses"] as const;
export type AboutTab = (typeof aboutTabs)[number];

/** The dialog "Alle Änderungen": from the changelog shipped with the app, or from the release notes of the offered update. */
export const changesSources = ["app", "update"] as const;
export type ChangesSource = (typeof changesSources)[number];

export function isChangesSource(value: unknown): value is ChangesSource {
  return typeof value === "string" && (changesSources as readonly string[]).includes(value);
}

/** The one update view that can be open: the update window, the restart warning or the error of a failed check. */
export const updateViews = ["window", "restart", "error"] as const;
export type UpdateView = (typeof updateViews)[number];

export function isUpdateView(value: unknown): value is UpdateView {
  return typeof value === "string" && (updateViews as readonly string[]).includes(value);
}

export interface UrlState {
  /** Set once the welcome screen was dealt with (any way); the main window is then shown at once. */
  screen?: "main";
  /** Id of the sketch step being edited. */
  sketch?: string;
  settings?: SettingsTab;
  /** The "About HalfCube" view is open on this tab. */
  about?: AboutTab;
  /** Id of the component whose licence is shown; only meaningful together with about=licenses. */
  item?: string;
  /** Which update view is open (the update window, the restart warning, the error of a failed check). */
  update?: UpdateView;
  /** "Was ist neu" is open. */
  news?: "1";
  /** "Alle Änderungen" is open, with the source of its entries. */
  changes?: ChangesSource;
}

export type UrlPatch = { [K in keyof UrlState]?: UrlState[K] | null };

const sketchIdPattern = /^f[1-9]\d*$/;
const itemIdPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function isAboutTab(value: unknown): value is AboutTab {
  return typeof value === "string" && (aboutTabs as readonly string[]).includes(value);
}

export function isSettingsTab(value: unknown): value is SettingsTab {
  return typeof value === "string" && (settingsTabs as readonly string[]).includes(value);
}

export function parseUrlState(search: string): UrlState {
  const q = new URLSearchParams(search);
  const out: UrlState = {};
  if (q.get("screen") === "main") out.screen = "main";
  const sketch = q.get("sketch");
  if (sketch !== null && sketchIdPattern.test(sketch)) out.sketch = sketch;
  const settings = q.get("settings");
  if (isSettingsTab(settings)) out.settings = settings;
  const about = q.get("about");
  if (isAboutTab(about)) {
    out.about = about;
    const item = q.get("item");
    if (about === "licenses" && item !== null && itemIdPattern.test(item)) out.item = item;
  }
  const update = q.get("update");
  if (isUpdateView(update)) out.update = update;
  if (q.get("news") === "1") out.news = "1";
  const changes = q.get("changes");
  if (isChangesSource(changes)) out.changes = changes;
  return out;
}

/** The query string after applying the patch: null removes a key, undefined leaves it, everything else is kept. */
export function applyUrlPatch(search: string, patch: UrlPatch): string {
  const q = new URLSearchParams(search);
  for (const key of ["screen", "sketch", "settings", "about", "item", "update", "news", "changes"] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value === null) q.delete(key);
    else q.set(key, value);
  }
  const text = q.toString();
  return text === "" ? "" : `?${text}`;
}

export function readUrlState(): UrlState {
  return typeof location === "undefined" ? {} : parseUrlState(location.search);
}

export function patchUrl(patch: UrlPatch): void {
  if (typeof location === "undefined" || typeof history === "undefined") return;
  const search = applyUrlPatch(location.search, patch);
  if (search === location.search) return;
  try {
    history.replaceState(history.state, "", `${location.pathname}${search}${location.hash}`);
  } catch {
    // A page that may not change its address (sandboxed frame) simply does not remember; nothing else depends on it.
  }
}
