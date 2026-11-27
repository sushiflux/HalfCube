// The "i" of the title bar with the update notice: the same 36 px button as always, a click opens "Über HalfCube". With an update
// the icon carries a small mark that never changes its size or place: found = filled dot, downloading = thin progress ring around
// the "i" (plus the dot), ready = closed ring and a check badge, scheduled for exit = hollow ring, failed = warning triangle. The
// state is never colour alone: the tooltip and the aria-label say it in words.
import type { MessageKey } from "../i18n/types.ts";
import { useT } from "../i18n/runtime.ts";
import { Glyph } from "../ui/Glyph.tsx";
import { Tip } from "../ui/Tip.tsx";
import { useUpdates } from "./controller.ts";
import { downloadPercent, iconKind, isSupported, isVerifying, type IconKind } from "./view-model.ts";
import type { UpdateState } from "./types.ts";

/** The key and parameters of the tooltip / aria-label for a state, or null for the plain icon. */
export function infoLabel(state: UpdateState | null): { key: MessageKey; params?: { percent: number } } | null {
  if (!isSupported(state)) return null;
  const { phase } = state;
  switch (iconKind(state)) {
    case "found":
      return { key: "updates.iconFound" };
    case "dl":
      return isVerifying(phase) ? { key: "updates.iconVerifying" } : { key: "updates.iconDownloading", params: { percent: downloadPercent(phase) } };
    case "ready":
      return { key: "updates.iconReady" };
    case "exit":
      return { key: "updates.iconExit" };
    case "failed":
      return { key: phase.kind === "download-failed" ? "updates.iconDownloadFailed" : "updates.iconCheckFailed" };
    case "none":
      return null;
  }
}

/** A thin ring; `pct` of it is drawn in the primary colour on a track in the line colour. */
export function Ring({ pct, size, radius, className }: { pct: number; size: number; radius: number; className?: string }) {
  const c = size / 2;
  return (
    <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden="true" className={className}>
      <circle cx={c} cy={c} r={radius} fill="none" stroke="var(--c-progress-track)" strokeWidth="2" />
      <circle cx={c} cy={c} r={radius} fill="none" stroke="var(--c-primary)" strokeWidth="2" pathLength="100" strokeDasharray="100" strokeDashoffset={(100 - pct).toFixed(1)} />
    </svg>
  );
}

/** The warning triangle badge (destructive fill, a halo in the background colour cuts it free from the glyph). */
export function TriangleBadge({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={className}>
      <path d="M8 1.6 15 14H1z" fill="var(--c-destructive)" stroke="var(--halo)" strokeWidth="3" strokeLinejoin="round" paintOrder="stroke" />
      <path d="M8 6v3.6M8 11.5v.3" stroke="var(--c-on-destructive)" strokeWidth="1.7" strokeLinecap="round" fill="none" />
    </svg>
  );
}

function Mark({ kind, pct }: { kind: IconKind; pct: number }) {
  switch (kind) {
    case "found":
      return <span className="absolute top-[6px] right-[7px] size-[10px] rounded-full bg-primary shadow-[0_0_0_2px_var(--halo)]" data-mark="dot" />;
    case "dl":
      return (
        <>
          <Ring pct={pct} size={36} radius={15.5} className="pointer-events-none absolute top-0 left-0 size-9 -rotate-90" />
          <span className="absolute top-[6px] right-[7px] size-[10px] rounded-full bg-primary shadow-[0_0_0_2px_var(--halo)]" data-mark="dot" />
        </>
      );
    case "ready":
      return (
        <>
          <Ring pct={100} size={36} radius={15.5} className="pointer-events-none absolute top-0 left-0 size-9 -rotate-90" />
          <span className="absolute top-[3px] right-[3px] grid size-[14px] place-items-center rounded-full bg-primary text-[10px] text-on-primary shadow-[0_0_0_2px_var(--halo)]" data-mark="check">
            <Glyph name="check" />
          </span>
        </>
      );
    case "exit":
      // A hollow ring (outer 12 px, 2 px stroke), clearly another shape than the filled dot of "found".
      return <span className="absolute top-[5px] right-[6px] size-3 rounded-full border-2 border-primary bg-[var(--halo)] shadow-[0_0_0_2px_var(--halo)]" data-mark="ring" />;
    case "failed":
      return <TriangleBadge className="pointer-events-none absolute top-[3px] right-[3px] size-4" />;
    case "none":
      return null;
  }
}

export function InfoButton({ onClick }: { onClick: () => void }) {
  const t = useT();
  const { state } = useUpdates();
  const kind = iconKind(state);
  const label = infoLabel(state);
  const text = label ? t(label.key, label.params) : t("main.title.about");
  const pct = isSupported(state) ? downloadPercent(state.phase) : 0;
  return (
    <Tip label={text} align="end">
      <button
        type="button"
        aria-label={text}
        onClick={onClick}
        data-testid="about-button"
        data-update-icon={kind}
        className="relative inline-grid size-9 cursor-pointer place-items-center rounded-ctl text-[18px] text-muted [--halo:var(--c-surface)] hover:bg-surface-2 hover:text-fg hover:[--halo:var(--c-surface-2)]"
      >
        <Glyph name="info" />
        <Mark kind={kind} pct={pct} />
      </button>
    </Tip>
  );
}
