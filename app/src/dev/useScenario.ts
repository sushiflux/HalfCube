import { useEffect, useState } from "react";
import type { LoadingProgress } from "../ui/loading/types.ts";
import { progressAt, scenarioDuration, type Scenario } from "./scenarios.ts";

const holdAfterLoopMs = 1400;

/** Plays a demo scenario on a timer. In-app scenarios loop; the start scenarios stop at the end or at the failure. */
export function useScenario(scenario: Scenario | undefined): LoadingProgress {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!scenario) return;
    const started = performance.now();
    const duration = scenarioDuration(scenario);
    let frame = 0;
    const tick = () => {
      const t = performance.now() - started;
      if (scenario.loop) {
        setElapsed(t % (duration + holdAfterLoopMs));
      } else {
        setElapsed(Math.min(t, duration + 1));
        if (t > duration + 1) return;
      }
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [scenario]);

  return scenario ? progressAt(scenario, elapsed) : { steps: [] };
}
