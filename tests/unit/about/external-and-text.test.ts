import { describe, expect, it } from "vitest";
import { parseExternalUrl } from "../../../app/src/about/external-url.ts";
import { isLicenceTextPath, licenceTextUrl, loadLicenceText } from "../../../app/src/about/licence-text.ts";
import { versionReport } from "../../../app/src/about/version-report.ts";

describe("parseExternalUrl", () => {
  it("accepts plain https addresses", () => {
    expect(parseExternalUrl("https://github.com/sushiflux/Partcraft")).toBe("https://github.com/sushiflux/Partcraft");
    expect(parseExternalUrl("https://react.dev")).toBe("https://react.dev/");
  });

  it("refuses everything else", () => {
    for (const bad of ["http://github.com", "javascript:alert(1)", "file:///C:/x", "app://partcraft/index.html", "https://user:pw@example.com/", "https://", "github.com", "", "  ", 42, null, undefined]) {
      expect(parseExternalUrl(bad)).toBeNull();
    }
    expect(parseExternalUrl(`https://example.com/${"a".repeat(2100)}`)).toBeNull();
  });
});

describe("licence text files", () => {
  const base = "http://localhost:5315/index.html";

  it("only allows a plain file name inside licenses/", () => {
    expect(isLicenceTextPath("licenses/occt.txt")).toBe(true);
    expect(isLicenceTextPath("licenses/partcraft-license.txt")).toBe(true);
    for (const bad of ["occt.txt", "licenses/../index.html", "/licenses/occt.txt", "licenses/a/b.txt", "licenses/occt.html", "https://x/licenses/a.txt", "licenses/.txt"]) {
      expect(isLicenceTextPath(bad)).toBe(false);
    }
  });

  it("resolves the path relative to the page, so it works under app:// too", () => {
    expect(licenceTextUrl("licenses/occt.txt", base)).toBe("http://localhost:5315/licenses/occt.txt");
    expect(licenceTextUrl("licenses/occt.txt", "app://partcraft/index.html")).toBe("app://partcraft/licenses/occt.txt");
  });

  it("loads a text once and remembers it", async () => {
    let calls = 0;
    const fetcher = (() => {
      calls += 1;
      return Promise.resolve(new Response("GNU LESSER GENERAL PUBLIC LICENSE", { status: 200, headers: { "Content-Type": "text/plain" } }));
    }) as typeof fetch;
    expect(await loadLicenceText("licenses/remember.txt", fetcher, base)).toBe("GNU LESSER GENERAL PUBLIC LICENSE");
    expect(await loadLicenceText("licenses/remember.txt", fetcher, base)).toBe("GNU LESSER GENERAL PUBLIC LICENSE");
    expect(calls).toBe(1);
  });

  it("says what went wrong: the status, the network error, an HTML page instead of the text", async () => {
    const answer = (init: ResponseInit, body = "") => (() => Promise.resolve(new Response(body, init))) as typeof fetch;
    await expect(loadLicenceText("licenses/missing.txt", answer({ status: 404, statusText: "Not Found" }), base)).rejects.toThrow("HTTP 404 Not Found");
    await expect(loadLicenceText("licenses/html.txt", answer({ status: 200, headers: { "Content-Type": "text/html" } }, "<html>"), base)).rejects.toThrow("HTML page");
    await expect(loadLicenceText("licenses/net.txt", () => Promise.reject(new Error("offline")), base)).rejects.toThrow("offline");
    await expect(loadLicenceText("../secret.txt", answer({ status: 200 }), base)).rejects.toThrow("not a licence text path");
  });
});

describe("versionReport", () => {
  it("names the version and the two big parts, as far as they exist", () => {
    expect(versionReport("v2026.11.6.12.24867 (</>)", "45.5.0", "8.0.2")).toBe("Partcraft v2026.11.6.12.24867 (</>) · Electron 45.5.0 · OCCT 8.0.2");
    expect(versionReport("v2026.11.6.12.24867 (β)", null, "8.0.2")).toBe("Partcraft v2026.11.6.12.24867 (β) · OCCT 8.0.2");
    expect(versionReport("v2026.11.6.12.24867", null, null)).toBe("Partcraft v2026.11.6.12.24867");
  });
});
