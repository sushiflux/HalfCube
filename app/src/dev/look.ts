// DEV BUILDS ONLY: `?updates-look=windows` makes a dev page look like the installed Windows program on the Nightly channel, for the figures
// of the manual: the version reads "(α)" instead of the dev mark and the error notice names the desktop program as its environment.
// Vite replaces __HC_UPDATES_DEMO__ by a literal (false outside the dev channel), so in a nightly, beta or release bundle the body below
// is dead code and neither the parameter name nor the branch is part of it. It must stay free of imports (version.ts uses it).

declare const __HC_UPDATES_DEMO__: boolean | undefined;

/** True when the dev page was opened with `?updates-look=windows`. */
export function windowsLook(): boolean {
  if (typeof __HC_UPDATES_DEMO__ !== "undefined" && __HC_UPDATES_DEMO__ && typeof location !== "undefined") {
    return new URLSearchParams(location.search).get("updates-look") === "windows";
  }
  return false;
}
