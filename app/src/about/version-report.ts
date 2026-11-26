// The text "Copy version" puts on the clipboard: product, version with channel symbol, and the versions of the two big parts.
import { branding } from "../branding.ts";

export function versionReport(display: string, electron: string | null, kernel: string | null): string {
  return [`${branding.name} ${display}`, electron ? `Electron ${electron}` : null, kernel ? `OCCT ${kernel}` : null].filter((p) => p !== null).join(" · ");
}
