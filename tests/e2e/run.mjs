// Runs the end-to-end suite.
//
//   npm run test:e2e              the browser project runs in the official Playwright Docker image
//                                 (mcr.microsoft.com/playwright:v<@playwright/test version>-noble), started for the run
//                                 and removed afterwards; the Electron project runs natively. Docker must already be running:
//                                 this script never starts Docker Desktop (a starting window could take the focus).
//   npm run test:e2e:local        MARKED FALLBACK: the browser project runs in an installed Chrome, Brave or Edge, headless
//                                 (PARTCRAFT_E2E_CHROME names another executable). Not the Docker browser; every report
//                                 line of the browser project says so.
//
// Further arguments go to `playwright test`:  npm run test:e2e -- welcome --project=electron
// Environment: PARTCRAFT_E2E_CONTAINER (name of the browser container, default partcraft-e2e-browser-<pid>), PARTCRAFT_E2E_PORT_WS (default 3100) for the Docker browser server, PARTCRAFT_E2E_HOST (default 127.0.0.1)
// for the address the test web server listens on. Docker Desktop on Windows reaches the loopback-only server through
// host.docker.internal, so the default needs no change there; another address can make Windows show a firewall prompt.
import { spawn, spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const local = args.includes("--local");
const playwrightArgs = args.filter((a) => a !== "--local");
// Only the Electron project selected: no browser is needed, so no container is started.
const projectIndex = playwrightArgs.indexOf("--project");
const needsBrowser = !(playwrightArgs.includes("--project=electron") || (projectIndex >= 0 && playwrightArgs[projectIndex + 1] === "electron"));
const cli = join(root, "node_modules", "@playwright", "test", "cli.js");
const version = JSON.parse(readFileSync(join(root, "node_modules", "@playwright", "test", "package.json"), "utf8")).version;
const wsPort = Number(process.env.PARTCRAFT_E2E_PORT_WS ?? 3100);
const image = `mcr.microsoft.com/playwright:v${version}-noble`;
const container = process.env.PARTCRAFT_E2E_CONTAINER ?? `partcraft-e2e-browser-${process.pid}`;

// http://host.docker.internal is not a trustworthy origin (no clipboard, no cross-origin isolation for the engine worker),
// http://localhost is. So the container forwards its own 127.0.0.1:<server port> to the host's loopback server.
const serverPort = JSON.parse(readFileSync(join(root, "config", "dev-ports.json"), "utf8"))["e2e-cdp"];
const forwarder =
  `const n=require('net');n.createServer(c=>{const u=n.connect(${serverPort},'host.docker.internal');c.pipe(u).pipe(c);` +
  `c.on('error',()=>u.destroy());u.on('error',()=>c.destroy());}).listen(${serverPort},'127.0.0.1')`;

const sleep =(ms) => new Promise((r) => setTimeout(r, ms));

function docker(...a) {
  return spawnSync("docker", a, { encoding: "utf8" });
}

function portOpen(port) {
  return new Promise((done) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("error", () => done(false));
  });
}

async function startDockerBrowser() {
  const info = docker("info", "--format", "{{.ServerVersion}}");
  if (info.error || info.status !== 0) {
    console.error(
      "Docker laeuft nicht (docker info schlug fehl). Starte Docker Desktop selbst; dieses Skript startet es nicht, damit\n" +
        "kein Fenster den Fokus nimmt. Ohne Docker: npm run test:e2e:local (markierter Fallback mit installiertem Chrome/Brave).\n" +
        `${(info.stderr ?? "").trim()}`,
    );
    process.exit(2);
  }
  console.error(`Docker-Browser: ${image} (Container ${container}, Playwright-Server auf 127.0.0.1:${wsPort})`);
  const run = docker(
    "run", "-d", "--rm", "--init", "--ipc=host", "--name", container,
    "--workdir", "/home/pwuser", "--user", "pwuser",
    "--add-host=host.docker.internal:host-gateway",
    "-p", `127.0.0.1:${wsPort}:${wsPort}`,
    image,
    "/bin/sh", "-c", `node -e "${forwarder}" & npx -y playwright@${version} run-server --port ${wsPort} --host 0.0.0.0`,
  );
  if (run.status !== 0) {
    console.error(`Der Container liess sich nicht starten:\n${run.stderr}`);
    process.exit(2);
  }
  // The server first downloads the matching playwright package inside the container; wait until it listens.
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (await portOpen(wsPort)) {
      const logs = docker("logs", container);
      if (/Listening on/i.test(`${logs.stdout}${logs.stderr}`)) return;
    }
    if (docker("inspect", "-f", "{{.State.Running}}", container).stdout.trim() !== "true") {
      console.error(`Der Container ${container} ist vorzeitig beendet:\n${docker("logs", container).stderr}`);
      process.exit(2);
    }
    await sleep(500);
  }
  console.error(`Der Playwright-Server im Container wurde nicht bereit:\n${docker("logs", container).stderr}`);
  stopDockerBrowser();
  process.exit(2);
}

function stopDockerBrowser() {
  docker("stop", "-t", "2", container);
  docker("rm", "-f", container);
}

const env = { ...process.env };
if (!needsBrowser) {
  env.PARTCRAFT_E2E_BROWSER = "local"; // never used: no browser project runs
} else if (local) {
  env.PARTCRAFT_E2E_BROWSER = "local";
  console.error("LOKALER FALLBACK: Der Browser-Teil laeuft in einem installierten Chrome/Brave/Edge (headless), NICHT im Docker-Image.");
} else {
  env.PARTCRAFT_E2E_BROWSER = "docker";
  env.PARTCRAFT_E2E_WS = `ws://127.0.0.1:${wsPort}/`;
  await startDockerBrowser();
  process.on("SIGINT", () => {
    stopDockerBrowser();
    process.exit(130);
  });
}

const child = spawn(process.execPath, [cli, "test", ...playwrightArgs], { cwd: root, env, stdio: "inherit" });
child.on("exit", (code, signal) => {
  if (!local) stopDockerBrowser();
  process.exit(code ?? (signal ? 1 : 0));
});
