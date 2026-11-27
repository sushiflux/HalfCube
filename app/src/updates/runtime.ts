// Where the update views get their facts from in the running page: the updater bridge of the desktop program (or, in a dev build with
// `?updates-demo=...`, the made-up one) and the source of "Was ist neu". The browser version has neither: there is no updater and
// no update view appears.
import { getDesktopBridge } from "../platform.ts";
import { preferences } from "../prefs/preferences.ts";
import { currentVersion } from "../version.ts";
import { bundledChangelog } from "./build.ts";
import type { NewsSource } from "./news-logic.ts";
import type { UpdatesBridge } from "./types.ts";

/**
 * True only in the dev channel: Vite replaces it by a literal in every build (vite.config.ts), so in a nightly, beta or release
 * bundle the branch below is dead code and the demo module is not part of the bundle. It has to stand where the import is: a
 * constant exported from another module would not be folded.
 */
declare const __HC_UPDATES_DEMO__: boolean | undefined;

/** The id of the version whose changelog entries the user has seen last. Absent on a first installation. */
export const lastShownPreferenceKey = "updates.lastShownId";

function realNewsSource(): NewsSource {
  const version = currentVersion();
  return {
    currentId: version.id,
    channel: version.channel,
    // A dev build never opens the window by itself; the link in "Über HalfCube" still works.
    autoAllowed: version.channel !== "dev",
    lastShownId: () => preferences.get(lastShownPreferenceKey) ?? null,
    remember: (id) => preferences.set(lastShownPreferenceKey, id),
    markdown: bundledChangelog,
  };
}

/** The source of "Was ist neu"; a dev build with the demo parameter swaps it for the demo's. */
export const newsSourceRef: { current: NewsSource } = { current: realNewsSource() };

/** The updater the page talks to, or undefined (the browser version). */
export async function pickUpdatesBridge(): Promise<UpdatesBridge | undefined> {
  // The constant is a literal false in nightly, beta and release bundles, so this branch and the demo module are dropped there.
  if (typeof __HC_UPDATES_DEMO__ !== "undefined" && __HC_UPDATES_DEMO__ && typeof location !== "undefined") {
    const demo = await import("./demo-bridge.ts");
    const options = demo.parseDemoOptions(location.search);
    if (options) {
      newsSourceRef.current = demo.createDemoNewsSource(options);
      // The browser demo has no updater: the page behaves as the browser version does.
      return options.browser ? undefined : demo.createDemoBridge(options);
    }
  }
  return getDesktopBridge()?.updates;
}
