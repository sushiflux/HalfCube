// Engine message protocol v0, shared by the UI, both transports and the contract tests.
// The same shapes are described as JSON Schema in protocol.schema.json; the C++ constants are in protocol.hpp.
//
// A message is a JSON header plus an optional binary payload. On the desktop (stdio) both travel in one frame
// (see frame.ts); in the browser the worker posts { header: string, payload: ArrayBuffer | null } and transfers
// the payload. Either way the client sees the same (header text, payload) pair.

export const PROTOCOL_VERSION = 0;

export const FRAME_MAGIC = 0x30454350; // bytes 'P' 'C' 'E' '0', little-endian u32
export const FRAME_PREFIX_BYTES = 16;
export const MAX_HEADER_BYTES = 16 * 1024 * 1024;
export const MAX_PAYLOAD_BYTES = 1024 * 1024 * 1024;
export const PAYLOAD_ALIGNMENT = 16;
export const MAX_REQUEST_ID = 2147483647;

// ---------------------------------------------------------------- recipe

/** A number, or the name of a recipe parameter whose value is used. */
export type RecipeValue = number | string;

export interface Recipe {
  format: "partcraft.recipe";
  formatVersion: 0;
  /** Named parameters (mm, or turns for springs). setParameter changes one of them. */
  parameters: Record<string, number>;
  /** Steps in timeline order. */
  steps: RecipeStep[];
}

export type RecipeStep = BoxStep | HoleStep | FilletStep | SpringStep | DebugSpinStep;

/** Creates a body: axis-aligned box from origin with the given size. */
export interface BoxStep {
  id: string;
  type: "box";
  body: string;
  origin: [RecipeValue, RecipeValue, RecipeValue];
  size: [RecipeValue, RecipeValue, RecipeValue];
}

/** Vertical (Z) through hole over the full height of the body. */
export interface HoleStep {
  id: string;
  type: "hole";
  body: string;
  center: [RecipeValue, RecipeValue];
  diameter: RecipeValue;
}

/**
 * Constant-radius fillet. Spike-only edge selector: "holeTopEdge" = the circular edge where the hole of step
 * `hole` meets the top face of the body. Real edge references come with the topological naming work.
 */
export interface FilletStep {
  id: string;
  type: "fillet";
  body: string;
  edges: { selector: "holeTopEdge"; hole: string };
  radius: RecipeValue;
}

/** Creates a body: round wire swept along a helix around Z starting at (radius, 0, 0). */
export interface SpringStep {
  id: string;
  type: "spring";
  body: string;
  radius: RecipeValue;
  pitch: RecipeValue;
  turns: RecipeValue;
  wireDiameter: RecipeValue;
}

/** Test-only (needs debug commands): busy-waits `ms`, checking for cancellation about every millisecond. */
export interface DebugSpinStep {
  id: string;
  type: "debug.spin";
  ms: RecipeValue;
}

// ---------------------------------------------------------------- client -> engine

export type CommandType =
  | "hello" | "loadRecipe" | "setParameter" | "cancel" | "ping" | "shutdown" | "debugCrash" | "debugPayload";

interface CommandBase {
  /** Client-chosen request id, 1..MAX_REQUEST_ID, unique per connection. Every reply carries it as replyTo. */
  id: number;
}

export interface HelloCommand extends CommandBase { type: "hello"; protocol: number; client: string }
/** Replaces the whole recipe. recipeVersion must be greater than the engine's current one. */
export interface LoadRecipeCommand extends CommandBase { type: "loadRecipe"; recipeVersion: number; recipe: Recipe }
/** Changes one parameter of the current recipe and rebuilds from the first affected step. */
export interface SetParameterCommand extends CommandBase {
  type: "setParameter"; recipeVersion: number; name: string; value: number;
}
/** Cancels a queued or running command. */
export interface CancelCommand extends CommandBase { type: "cancel"; target: number }
/** Liveness check. The native engine answers while busy; the WebAssembly engine only between commands. */
export interface PingCommand extends CommandBase { type: "ping" }
/** Native: finishes queued work, replies "bye" and exits with code 0. WebAssembly: replies "bye". */
export interface ShutdownCommand extends CommandBase { type: "shutdown" }
/** Test-only: crashes the engine on purpose (native: the process dies; WebAssembly: a trap). */
export interface DebugCrashCommand extends CommandBase { type: "debugCrash"; mode: "abort" | "nullcall" | "intdiv" }
/** Test-only: answers with a payload of `bytes` bytes (pattern byte i = (i * 31) & 255), for transport measurements. */
export interface DebugPayloadCommand extends CommandBase { type: "debugPayload"; bytes: number }

export type Command =
  | HelloCommand | LoadRecipeCommand | SetParameterCommand | CancelCommand | PingCommand | ShutdownCommand
  | DebugCrashCommand | DebugPayloadCommand;

// ---------------------------------------------------------------- engine -> client

interface EngineMessageBase {
  /** Id of the command this answers; null only for errors about unreadable messages. */
  replyTo: number | null;
  /**
   * The recipe version the message refers to. For loadRecipe/setParameter replies and their progress this is the
   * command's version; otherwise the engine's current recipe version (-1 = no recipe loaded).
   */
  recipeVersion: number;
}

export interface EngineInfo {
  name: "partcraft-engine";
  version: string;
  kernel: string;
  platform: "windows-x64" | "wasm32" | string;
  build: string;
}

export interface Capabilities {
  /** debugCrash, debugPayload and debug.spin are accepted (native: --debug-commands; worker: init option). */
  debugCommands: boolean;
  /** ping and cancel are handled while a rebuild runs (native: reader thread). */
  pingWhileBusy: boolean;
  /** Cancellation reaches a running rebuild (native always; WebAssembly only with a shared cancel flag). */
  cancelWhileBusy: boolean;
}

export interface HelloResult extends EngineMessageBase {
  type: "helloResult";
  protocol: number;
  engine: EngineInfo;
  capabilities: Capabilities;
  limits: { maxHeaderBytes: number; maxPayloadBytes: number; payloadAlignment: number };
}

export interface ProgressEvent extends EngineMessageBase {
  type: "progress";
  stage: "step" | "mesh";
  /** 0-based index of the finished step (stage "step") or -1 (stage "mesh"). */
  stepIndex: number;
  stepCount: number;
  stepId: string | null;
  /** Status of the finished step (stage "step" only). */
  step?: StepStatus;
}

export type StepState = "ok" | "warning" | "error" | "skipped";

export interface StepCheck {
  /** BRepCheck_Analyzer verdict of the body after this step. */
  valid: boolean;
  volume: number;
  faces: number;
  solids: number;
}

export interface StepStatus {
  stepId: string;
  type: RecipeStep["type"];
  status: StepState;
  /** Full message text for warning, error and skipped; "" for ok. Never truncated. */
  message: string;
  /** The result came from the engine's step cache (inputs unchanged). */
  cached: boolean;
  ms: number;
  /** Present when the step produced geometry that was checked. */
  check?: StepCheck;
}

export type SurfaceKind =
  | "plane" | "cylinder" | "cone" | "sphere" | "torus" | "bezier" | "bspline" | "revolution" | "extrusion"
  | "offset" | "other";

export interface FaceInfo {
  /** Index into this body's faces; the values in the faceIds buffer. */
  faceId: number;
  surface: SurfaceKind;
  /** Id of the recipe step that created this face (kept through later modifications). */
  originStep: string;
  /** Triangles of a face are contiguous: [triangleStart, triangleStart + triangleCount). */
  triangleStart: number;
  triangleCount: number;
}

/** Byte range inside the message payload. offset is a multiple of PAYLOAD_ALIGNMENT. */
export interface BufferRef { offset: number; byteLength: number }

/**
 * Mesh buffers of one body, all little-endian, inside the result payload:
 *   positions     Float32 x,y,z per vertex (mm)
 *   normals       Float32 x,y,z per vertex (unit length, outward)
 *   indices       Uint32 three per triangle, counter-clockwise seen from outside
 *   faceIds       Uint32 one per triangle (FaceInfo.faceId)
 *   edgePositions Float32 two points (6 floats) per line segment of the visible B-rep edges (no seams)
 *   edgeIds       Uint32 one per segment (index of the B-rep edge in the body)
 * Vertices are not shared between faces, so normals stay sharp along edges.
 */
export interface MeshLayout {
  vertexCount: number;
  triangleCount: number;
  edgeSegmentCount: number;
  positions: BufferRef;
  normals: BufferRef;
  indices: BufferRef;
  faceIds: BufferRef;
  edgePositions: BufferRef;
  edgeIds: BufferRef;
}

export interface BodyResult {
  bodyId: string;
  /** Last step that changed this body successfully. */
  lastStepId: string;
  volume: number;
  area: number;
  bbox: { min: [number, number, number]; max: [number, number, number] };
  faceCount: number;
  edgeCount: number;
  faces: FaceInfo[];
  mesh: MeshLayout;
}

export interface RebuildResult extends EngineMessageBase {
  type: "result";
  /** "error": at least one step failed; each body then shows its state before its first failing step. */
  outcome: "ok" | "warning" | "error";
  steps: StepStatus[];
  bodies: BodyResult[];
  timings: { rebuildMs: number; meshMs: number; encodeMs: number; totalMs: number };
  payloadBytes: number;
  /** Meshing tolerances used: chordal deflection (mm) and angular deflection (degrees). */
  tessellation: { deflection: number; angleDeg: number };
}

export interface Pong extends EngineMessageBase { type: "pong"; busyWith: number | null; queued: number }

export interface CancelResult extends EngineMessageBase {
  type: "cancelResult";
  target: number;
  /**
   * queued: it had not started; it ends with error "cancelled" without rebuilding.
   * running: it ends with error "cancelled" (native at once; WebAssembly only with the shared cancel flag).
   * notRunning: unknown, already finished, or (WebAssembly) the message arrived after the command finished.
   * Cancelling never reverts a recipe change; only the rebuild is skipped.
   */
  state: "queued" | "running" | "notRunning";
}

export interface Bye extends EngineMessageBase { type: "bye" }

export interface DebugPayloadResult extends EngineMessageBase {
  type: "debugPayloadResult";
  bytes: number;
  /** FNV-1a 32-bit hash of the payload, to check its integrity. */
  fnv1a: number;
  fillMs: number;
}

export type ErrorCode =
  | "protocol_mismatch" | "not_initialized" | "bad_message" | "unknown_command" | "bad_recipe" | "no_recipe"
  | "unknown_parameter" | "stale_version" | "cancelled" | "superseded" | "debug_disabled" | "internal";

export interface EngineError extends EngineMessageBase {
  type: "error";
  code: ErrorCode;
  /** Complete, user-presentable cause written by the engine. Never truncated. */
  message: string;
}

export type EngineMessage =
  | HelloResult | ProgressEvent | RebuildResult | Pong | CancelResult | Bye | DebugPayloadResult | EngineError;

/** Distributive Omit, so Omit over a union keeps each member's own fields. */
export type CommandWithoutId = Command extends infer C ? (C extends Command ? Omit<C, "id"> : never) : never;
