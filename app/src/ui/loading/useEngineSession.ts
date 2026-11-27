// The engine session of the running app and its React hook. One session per page; starting it is idempotent.
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { createEngineSession, type EngineSession, type EngineStatus } from "../../engine/index.ts";
import { currentVersion } from "../../version.ts";

let session: EngineSession | undefined;

/** The one engine session of this page, created on first use (the native engine behind the desktop bridge). */
export function getEngineSession(): EngineSession {
  if (!session) {
    session = createEngineSession();
    // Dev channel only: lets a test read the engine status and end the engine on purpose.
    if (currentVersion().channel === "dev") (window as unknown as { __halfcubeSession?: EngineSession }).__halfcubeSession = session;
  }
  return session;
}

/**
 * Starts the engine (once) and follows its status. With `enabled` false nothing is created or started, so demo scenes
 * and tests do not need an engine; the hook then returns null.
 */
export function useEngineSession(enabled: boolean): { session: EngineSession; status: EngineStatus } | null {
  const active = enabled ? getEngineSession() : null;
  const subscribe = useCallback(
    (listener: () => void) => (active ? active.subscribe(listener) : () => undefined),
    [active],
  );
  const read = useCallback(() => (active ? active.getStatus() : null), [active]);
  const status = useSyncExternalStore(subscribe, read, read);
  useEffect(() => {
    if (active) void active.start();
  }, [active]);
  return active && status ? { session: active, status } : null;
}
