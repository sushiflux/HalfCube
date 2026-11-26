// Builds the suite's web and desktop bundles, then serves the web build on the reserved end-to-end port with the same
// security headers as the product (CSP, cross-origin isolation). Started by Playwright's webServer; killed by it too.
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, relative, sep } from "node:path";
import { responseHeaders } from "../../../config/security.ts";
import { serverHost, serverPort, webDir } from "./paths.ts";
import { prepare } from "./prepare.ts";

const mimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

if (process.env.HALFCUBE_E2E_SKIP_BUILD !== "1") await prepare();

const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? "/", "http://localhost");
    let rel: string;
    try {
      rel = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    } catch {
      response.writeHead(400).end("Bad request");
      return;
    }
    const file = normalize(join(webDir, rel));
    const inside = relative(webDir, file);
    if (inside === "" || inside.startsWith("..") || inside.includes(`..${sep}`)) {
      response.writeHead(404).end("Not found");
      return;
    }
    const info = await stat(file).catch(() => undefined);
    if (!info?.isFile()) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end(`Not found: ${rel}`);
      return;
    }
    response.writeHead(200, {
      "Content-Type": mimeTypes[extname(file).toLowerCase()] ?? "application/octet-stream",
      "Content-Length": info.size,
      "Cache-Control": "no-store",
      ...responseHeaders,
    });
    if (request.method === "HEAD") response.end();
    else createReadStream(file).pipe(response);
  })().catch((error: unknown) => {
    response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }).end(String(error));
  });
});

server.listen(serverPort, serverHost, () => {
  console.log(`e2e server: http://${serverHost}:${serverPort}/ serving ${webDir}`);
});
