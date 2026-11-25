import { useCallback, useEffect, useRef, useState } from "react";

/** Copies text; returns false when the browser or the system refuses. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fall through to the older way, which also works where the clipboard API is blocked.
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.className = "fixed -left-[9999px] top-0 opacity-0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

export type CopyState = "idle" | "copied" | "failed";

/** State for a copy button: "copied" or "failed" for a moment, then idle again. */
export function useCopy(getText: () => string): { state: CopyState; copy: () => void } {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = useCallback(() => {
    void copyText(getText()).then((ok) => {
      setState(ok ? "copied" : "failed");
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setState("idle"), 1600);
    });
  }, [getText]);
  return { state, copy };
}
