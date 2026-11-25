// Minimal static file server for the update feed, bound to 127.0.0.1 only. Usage: node scripts/serve.mjs <dir> <port>
import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";

const dir = resolve(process.argv[2]);
const port = Number(process.argv[3]);
createServer((req, res) => {
  const name = normalize(decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname)).replace(/^[\/]+/, "");
  const file = join(dir, name);
  if (!resolve(file).startsWith(dir + sep)) { res.writeHead(403).end(); return; }
  try {
    const st = statSync(file);
    if (!st.isFile()) throw new Error("not a file");
    res.writeHead(200, { "Content-Length": st.size, "Content-Type": "application/octet-stream" });
    if (req.method === "HEAD") { res.end(); return; }
    createReadStream(file).pipe(res);
    console.log(`${req.method} /${name} 200 ${st.size}`);
  } catch {
    console.log(`${req.method} /${name} 404`);
    res.writeHead(404).end();
  }
}).listen(port, "127.0.0.1", () => console.log(`serving ${dir} on http://127.0.0.1:${port}/`));
