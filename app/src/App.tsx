import logoUrl from "../../branding/icons/icon-256.png";
import { branding } from "./branding.ts";
import { detectPlatform } from "./platform.ts";
import { currentVersion } from "./version.ts";

// Placeholder for the visible texts until the translation layer exists.
const strings = {
  status: "Early development. Nothing usable yet.",
  versionLabel: "Version",
  platformDesktop: "Desktop program",
  platformBrowser: "Browser version",
};

export function App() {
  const version = currentVersion();
  const platform = detectPlatform();

  return (
    <main className="flex h-full flex-col items-center justify-center gap-4 bg-white text-slate-900">
      <img src={logoUrl} alt="" width={96} height={96} />
      <h1 className="text-3xl font-semibold tracking-tight">{branding.name}</h1>
      <p className="text-slate-600">{strings.status}</p>
      <p className="font-mono text-sm text-slate-500" data-testid="version">
        {strings.versionLabel} {version.display}
      </p>
      <p className="text-xs text-slate-400" data-testid="platform" data-platform={platform}>
        {platform === "desktop" ? strings.platformDesktop : strings.platformBrowser}
      </p>
    </main>
  );
}
