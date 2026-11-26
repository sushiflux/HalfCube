// Records the answers of the native release engine to every case in cases.ts into tests/fixtures/engine/:
// <case>.json (command, answer header) and <case>.bin (binary payload, if any). The contract tests compare both
// engines with these recordings; the replay stub (replay.ts) plays them for UI work without an engine.
//
//   node tests/fixtures/engine/record.ts [path to partcraft-engine.exe]
//
// Run it again after a change of the engine's results and review the diff.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EngineClient } from "../../../app/src/engine/client.ts";
import { NativeTransport } from "../../../desktop/src/native-transport.ts";
import { repoRoot } from "../../../config/build-info.ts";
import { ENGINE_CASES } from "./cases.ts";
import type { RecordedCase } from "./recording.ts";

const exe = process.argv[2] ?? join(repoRoot, "engine", "_build", "windows-release", "bin", "partcraft-engine.exe");
const dir = join(repoRoot, "tests", "fixtures", "engine");
mkdirSync(dir, { recursive: true });

const client = new EngineClient({ clientName: "fixture-recorder", createTransport: () => new NativeTransport({ exe }) });
const hello = await client.start();
let revision = 0;
try {
  for (const c of ENGINE_CASES) {
    // Revisions must grow within one engine; the recording keeps the case's own command.
    const command = c.command.type === "model.sync" ? { ...c.command, revision: ++revision } : c.command;
    const reply = await client.request(command).reply;
    const payloadFile = reply.payload && reply.payload.byteLength > 0 ? `${c.name}.bin` : null;
    const recorded: RecordedCase = {
      name: c.name,
      recordedWith: { engine: hello.engine.versionFull, platform: hello.engine.platform, os: hello.engine.os },
      command: c.command,
      reply: { ...reply.message, replyTo: null },
      payload: payloadFile,
    };
    writeFileSync(join(dir, `${c.name}.json`), `${JSON.stringify(recorded, null, 2)}\n`);
    if (payloadFile && reply.payload) writeFileSync(join(dir, payloadFile), new Uint8Array(reply.payload));
    console.log(`recorded ${c.name}${payloadFile ? ` (${reply.payload!.byteLength} bytes payload)` : ""}`);
  }
} finally {
  await client.stop();
}
