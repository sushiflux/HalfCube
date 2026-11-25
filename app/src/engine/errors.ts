// Errors the engine client rejects with. Every one carries the complete cause in message; raw engine text is in
// detail / info.diagnostics and meant for "technical details", never as the headline.
import type { ErrorMessage } from "./generated/protocol.ts";
import type { ExitInfo } from "./transport.ts";

/** The engine answered a command with an error message. */
export class EngineCommandError extends Error {
  readonly code: ErrorMessage["code"];
  readonly detail: string | undefined;
  readonly command: string | undefined;
  readonly requestId: number;

  constructor(message: ErrorMessage, requestId: number) {
    super(message.message);
    this.name = "EngineCommandError";
    this.code = message.code;
    this.detail = message.detail;
    this.command = message.command;
    this.requestId = requestId;
  }
}

/** The engine ended, hung or lost its connection while the request was open (or the engine was restarted). */
export class EngineCrashedError extends Error {
  readonly info: ExitInfo;

  constructor(info: ExitInfo) {
    super(info.message);
    this.name = "EngineCrashedError";
    this.info = info;
  }
}

/** A newer request with the same supersede key replaced this one; its answer is dropped. */
export class EngineSupersededError extends Error {
  readonly requestId: number;
  readonly key: string;

  constructor(requestId: number, key: string) {
    super(`Request ${requestId} was replaced by a newer request with the key "${key}"; its answer is not used.`);
    this.name = "EngineSupersededError";
    this.requestId = requestId;
    this.key = key;
  }
}

/** The request could not be sent because no engine connection is open. */
export class EngineNotRunningError extends Error {
  constructor(message = "The engine is not running.") {
    super(message);
    this.name = "EngineNotRunningError";
  }
}

export const isCommandError = (e: unknown): e is EngineCommandError => e instanceof EngineCommandError;
export const isCrashed = (e: unknown): e is EngineCrashedError => e instanceof EngineCrashedError;
export const isSuperseded = (e: unknown): e is EngineSupersededError => e instanceof EngineSupersededError;
/** The command was cancelled (by cancel() or because the engine stopped it). */
export const isCancelled = (e: unknown): boolean => e instanceof EngineCommandError && e.code === "cancelled";
