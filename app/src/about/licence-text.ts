// Loads a licence text (a plain text file of the build, e.g. licenses/occt.txt) once and remembers it. The path is relative
// to the page, so it works the same under app:// in the desktop program and on the dev server.
import { useEffect, useState } from "react";

export type LicenceTextState =
  | { status: "loading" }
  | { status: "ready"; text: string }
  | { status: "failed"; reason: string };

const cache = new Map<string, string>();

/** Only a plain relative path inside the licenses folder may be loaded; anything else is a mistake in the data. */
export function isLicenceTextPath(file: string): boolean {
  return /^licenses\/[A-Za-z0-9][A-Za-z0-9._-]*\.txt$/.test(file);
}

/** The address of a licence text relative to the page. */
export function licenceTextUrl(file: string, base: string = document.baseURI): string {
  return new URL(file, base).href;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function loadLicenceText(file: string, fetcher: typeof fetch = fetch, base?: string): Promise<string> {
  const known = cache.get(file);
  if (known !== undefined) return known;
  if (!isLicenceTextPath(file)) throw new Error(`not a licence text path (${file})`);
  let response: Response;
  try {
    response = await fetcher(licenceTextUrl(file, base));
  } catch (error) {
    throw new Error(describe(error));
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`);
  // A server that answers a missing file with its start page would otherwise show page source as a licence.
  if ((response.headers.get("content-type") ?? "").includes("text/html")) throw new Error("the server answered with an HTML page instead of the text file");
  const text = await response.text();
  cache.set(file, text);
  return text;
}

/** The text of `file`, or its loading / failed state. A null file has no state (nothing to load). */
export function useLicenceText(file: string | null): LicenceTextState | null {
  const [state, setState] = useState<{ file: string; value: LicenceTextState } | null>(null);
  useEffect(() => {
    if (file === null) return;
    let alive = true;
    loadLicenceText(file).then(
      (text) => alive && setState({ file, value: { status: "ready", text } }),
      (error: unknown) => alive && setState({ file, value: { status: "failed", reason: describe(error) } }),
    );
    return () => {
      alive = false;
    };
  }, [file]);
  if (file === null) return null;
  return state?.file === file ? state.value : { status: "loading" };
}
