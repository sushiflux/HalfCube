// The steps the update views trigger. One overlay at a time, as in the mockup: opening the update window, "Was ist neu" or the
// settings from "Über HalfCube" closes that view first, and closing the new one leaves the work area, not the old view.
import { aboutStore } from "../about/state.ts";
import type { SettingsTab } from "../screens/main/url-state.ts";
import { updates } from "./controller.ts";
import { updateUi } from "./ui-state.ts";
import { restartNeedsWarning, workStore } from "./work.ts";
import { branding } from "../branding.ts";

/** The main window listens for this: a tab opens its settings dialog on that tab, null closes it (the dialog's state lives there). */
export const OPEN_SETTINGS_EVENT = `${branding.slug}:open-settings`;

function settingsView(tab: SettingsTab | null): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent<SettingsTab | null>(OPEN_SETTINGS_EVENT, { detail: tab }));
}

/** One overlay at a time: the view that is open (the info view, the settings) gives way. */
function clearOverlays(): void {
  aboutStore.close();
  settingsView(null);
}

export function openUpdateWindow(): void {
  clearOverlays();
  updateUi.openWindow();
}

export function openUpdateError(): void {
  clearOverlays();
  updateUi.openError();
}

export function openNews(): void {
  clearOverlays();
  updateUi.openNews();
}

/** "Über HalfCube" on the Info tab, where the update slot is (the update window itself opens only from there). */
export function openAboutInfo(): void {
  settingsView(null);
  updateUi.closeView();
  aboutStore.open({ tab: "info" });
}

export function openSettings(tab: SettingsTab): void {
  aboutStore.close();
  settingsView(tab);
}

/**
 * "Jetzt neu starten": the warning comes only after this click and only when the open design has something that would be lost
 * (HalfCube cannot save yet); otherwise the update installs at once.
 */
export function requestRestart(): void {
  clearOverlays();
  if (restartNeedsWarning(workStore.get())) {
    updateUi.openRestart();
    return;
  }
  updateUi.closeView();
  void updates.restart();
}

/** "Verwerfen und neu starten". */
export function confirmRestart(): void {
  updateUi.closeView();
  void updates.restart();
}

/** "Beim Beenden installieren". */
export function installOnExit(): void {
  updateUi.closeView();
  void updates.setInstallOnExit(true);
}

export function cancelInstallOnExit(): void {
  void updates.setInstallOnExit(false);
}

export function startDownload(): void {
  void updates.download();
}
