// Which addresses the program may hand to the system browser. The page checks it before asking, the Electron main process
// checks it again (it never trusts the page): only plain https addresses, no credentials, nothing absurdly long.

const MAX_LENGTH = 2048;

/** The normalised address when `raw` may be opened outside the program, otherwise null. */
export function parseExternalUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname === "" || url.username !== "" || url.password !== "") return null;
  return url.href;
}
