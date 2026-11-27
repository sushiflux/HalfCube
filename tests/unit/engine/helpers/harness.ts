// Starts clients against the real native engine process and checks every command the client sends and every message
// the engine sends against the generated JSON Schema.
import { EngineClient, type EngineClientOptions } from "../../../../app/src/engine/client.ts";
import type { EngineMessage } from "../../../../app/src/engine/generated/protocol.ts";
import type { EngineTransport, ExitInfo } from "../../../../app/src/engine/transport.ts";
import { NativeTransport } from "../../../../desktop/src/native-transport.ts";
import { commandProblems, engineMessageProblems } from "./schema.ts";

export type EngineKind = "native";

/** Where an engine lives: the path of the native executable. */
export interface EngineLocation {
  kind: EngineKind;
  path: string;
}

export function transportFor(where: EngineLocation): EngineTransport {
  return new NativeTransport({ exe: where.path });
}

export interface TestEngine {
  client: EngineClient;
  transports: EngineTransport[];
  /** Schema violations seen so far; every test asserts it stays empty. */
  schemaErrors: string[];
  exits: ExitInfo[];
  unsolicited: EngineMessage[];
  /** Runs fn (which must send synchronously) without the command schema check, for deliberately invalid commands. */
  unchecked<T>(fn: () => T): T;
}

export async function startEngine(
  where: EngineLocation,
  options: Partial<EngineClientOptions> & { start?: boolean } = {},
): Promise<TestEngine> {
  const { start = true, ...clientOptions } = options;
  const schemaErrors: string[] = [];
  const exits: ExitInfo[] = [];
  const unsolicited: EngineMessage[] = [];
  const transports: EngineTransport[] = [];
  let skipCheck = false;
  const client = new EngineClient({
    clientName: "contract-tests",
    createTransport: () => {
      const t = transportFor(where);
      const send = t.send.bind(t);
      t.send = (header, payload) => {
        const problems = skipCheck ? [] : commandProblems(JSON.parse(header));
        if (problems.length > 0) schemaErrors.push(`command ${header.slice(0, 200)}: ${problems.join("; ")}`);
        send(header, payload);
      };
      transports.push(t);
      return t;
    },
    onMessage: (m) => {
      const problems = engineMessageProblems(m);
      if (problems.length > 0) schemaErrors.push(`${m.type}: ${problems.join("; ")}`);
    },
    onExit: (i) => exits.push(i),
    onUnsolicited: (m) => unsolicited.push(m),
    ...clientOptions,
  });
  if (start) await client.start();
  const unchecked = <T>(fn: () => T): T => {
    skipCheck = true;
    try {
      return fn();
    } finally {
      skipCheck = false;
    }
  };
  return { client, transports, schemaErrors, exits, unsolicited, unchecked };
}

/** Sends one raw header on a fresh transport and returns the first reply (for handshake tests). */
export async function rawExchange(where: EngineLocation, header: string): Promise<EngineMessage> {
  const t = transportFor(where);
  const got = new Promise<EngineMessage>((resolve) => {
    t.onMessage = (h) => resolve(JSON.parse(h) as EngineMessage);
  });
  await t.start();
  t.send(header);
  const message = await got;
  t.kill();
  return message;
}

export const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** True while a process with this id exists. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
