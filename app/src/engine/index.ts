// Public surface of the engine client. The UI imports from here only.
export { createEngineSession } from "./create.ts";
export type { CreateEngineSessionOptions } from "./create.ts";
export { EngineSession } from "./session.ts";
export type { EngineSessionOptions, RestartLimit } from "./session.ts";
export { EngineClient, REPLY_TYPE } from "./client.ts";
export type {
  ClientState,
  CommandInput,
  EngineClientOptions,
  ProgressHandler,
  Reply,
  RequestHandle,
  RequestOptions,
} from "./client.ts";
export {
  EngineCommandError,
  EngineCrashedError,
  EngineNotRunningError,
  EngineSupersededError,
  isCancelled,
  isCommandError,
  isCrashed,
  isSuperseded,
} from "./errors.ts";
export type {
  EnginePhase,
  EngineProblem,
  EngineProblemCode,
  EngineStatus,
  StartupStep,
  StartupStepId,
  StatusListener,
  StepState,
} from "./status.ts";
export type { EngineTransport, ExitInfo } from "./transport.ts";
export * from "./generated/protocol.ts";
