// React view on a sketch session: one useSyncExternalStore over its immutable state.
import { useSyncExternalStore } from "react";
import type { SessionState, SketchSession } from "./session.ts";

const none = () => () => undefined;
const idle: SessionState = {
  tool: "select",
  prompt: "select",
  selection: [],
  inProgress: false,
  typed: null,
  dimEdit: null,
  ghost: null,
  notice: null,
  dragBlocked: false,
};

export function useSessionState(session: SketchSession | null): SessionState {
  return useSyncExternalStore(session ? session.subscribe : none, session ? session.getState : () => idle);
}
