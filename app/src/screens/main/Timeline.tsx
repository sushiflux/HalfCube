// The timeline docked at the bottom: an icon row by default (or icons with names, a setting). A sketch is ONE step with
// the sketch icon and a small plus; the plus unfolds the steps inside the sketch as one framed strip with dividers, the
// strip look. Body operations are steps of their own. A click on an inner step only highlights it: what
// else it should do is not decided yet. The height is fixed, so unfolding a sketch moves nothing.
import { useT } from "../../i18n/runtime.ts";
import { cx } from "../../ui/cx.ts";
import { Glyph } from "../../ui/Glyph.tsx";
import type { TimelineLabelMode } from "../../prefs/settings.ts";
import type { SubStep, TimelineStep } from "./timeline-model.ts";

export interface TimelineProps {
  steps: readonly TimelineStep[];
  labels: TimelineLabelMode;
  componentName: string;
  /** Feature ids of the sketches that are unfolded. */
  expanded: ReadonlySet<string>;
  selectedStepId: string | null;
  /** "<featureId>/<elementId>" of the highlighted inner step. */
  selectedSubId: string | null;
  /** Id of the sketch step being edited. */
  editingId: string | null;
  onToggle: (featureId: string) => void;
  onSelectStep: (featureId: string) => void;
  onSelectSub: (featureId: string, subId: string) => void;
  onOpenSketch: (featureId: string) => void;
  /** Double-click on an extrusion opens it for editing. */
  onOpenExtrude: (featureId: string) => void;
}

type Translate = ReturnType<typeof useT>;

function stateText(t: Translate, step: TimelineStep): string {
  if (step.draft) return t("main.timeline.draft", { name: step.label });
  if (step.state === "error") return t("main.timeline.stepFailed", { name: step.label });
  if (step.state === "warning") return t("main.timeline.stepWarning", { name: step.label });
  return step.label;
}

interface StepButtonProps {
  step: TimelineStep;
  labels: TimelineLabelMode;
  selected: boolean;
  editing: boolean;
  onSelect: () => void;
  onOpen?: () => void;
  /** Part of a sketch strip: the strip draws the frame. */
  framed?: boolean;
}

function StepButton({ step, labels, selected, editing, onSelect, onOpen, framed }: StepButtonProps) {
  const t = useT();
  const named = labels === "names";
  const failed = step.state === "error";
  const marked = selected || editing || step.draft === true;
  return (
    <button
      type="button"
      aria-label={stateText(t, step)}
      aria-current={selected ? "step" : undefined}
      data-testid={`timeline-step-${step.featureId}`}
      data-state={step.state}
      data-draft={step.draft || undefined}
      data-editing={editing || undefined}
      onClick={onSelect}
      onDoubleClick={onOpen}
      className={cx(
        "relative inline-flex flex-none cursor-pointer items-center justify-center gap-1.5 text-[12px] font-medium whitespace-nowrap text-fg",
        named ? "pr-2.5 pl-2" : "w-7",
        framed ? "h-6 bg-primary-soft" : "h-[26px] rounded-sm border bg-surface",
        !framed && (failed ? "border-[1.5px] border-error" : marked ? "border-primary bg-primary-soft" : "border-line-strong"),
      )}
    >
      <span className={cx("text-[16px]", failed && "text-error")}>
        <Glyph name={step.glyph} />
      </span>
      {named ? <span>{step.label}</span> : null}
      {failed ? <span aria-hidden="true" className="absolute -top-1 -right-1 size-2 rounded-full border-[1.5px] border-surface bg-error" /> : null}
      {marked && framed ? <span aria-hidden="true" className="absolute inset-0 shadow-[inset_0_0_0_1.5px_var(--c-primary)]" /> : null}
    </button>
  );
}

function SubButton({ sub, labels, selected, onSelect }: { sub: SubStep; labels: TimelineLabelMode; selected: boolean; onSelect: () => void }) {
  const named = labels === "names";
  return (
    <button
      type="button"
      aria-label={sub.label}
      aria-pressed={selected}
      data-testid={`timeline-sub-${sub.id}`}
      onClick={onSelect}
      className={cx(
        "relative inline-flex h-6 min-w-7 flex-none cursor-pointer items-center justify-center gap-1.5 border-l border-line px-1.5 text-[12px] font-medium whitespace-nowrap text-fg hover:bg-surface-2",
        selected && "bg-primary-soft shadow-[inset_0_0_0_1.5px_var(--c-primary)]",
      )}
    >
      <span className="text-[14px]">
        <Glyph name={sub.glyph} />
      </span>
      {named ? <span>{sub.label}</span> : null}
    </button>
  );
}

export function Timeline({ steps, labels, componentName, expanded, selectedStepId, selectedSubId, editingId, onToggle, onSelectStep, onSelectSub, onOpenSketch, onOpenExtrude }: TimelineProps) {
  const t = useT();
  return (
    <section aria-label={t("main.timeline.label")} className="flex h-[54px] flex-none items-center gap-3 border-t border-line bg-surface px-2.5" data-testid="timeline">
      <div
        role="list"
        className="flex h-10 min-w-0 flex-1 items-center gap-1 overflow-x-auto rounded-ctl border border-line bg-surface px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        data-testid="timeline-track"
      >
        {steps.length === 0 ? <span className="px-1 text-[12.5px] text-muted">{t("main.timeline.empty")}</span> : null}
        {steps.map((step) => {
          const selected = step.featureId === selectedStepId;
          const editing = step.featureId === editingId;
          if (step.kind !== "sketch") {
            return (
              <div key={step.featureId} role="listitem" className="flex flex-none">
                <StepButton
                  step={step}
                  labels={labels}
                  selected={selected}
                  editing={step.featureId === editingId}
                  onSelect={() => onSelectStep(step.featureId)}
                  {...(step.draft ? {} : { onOpen: () => onOpenExtrude(step.featureId) })}
                />
              </div>
            );
          }
          const open = expanded.has(step.featureId);
          return (
            <div key={step.featureId} role="listitem" className="flex flex-none">
              <div
                role="group"
                aria-label={step.label}
                className={cx(
                  "relative inline-flex h-[26px] flex-none overflow-hidden rounded-sm border bg-surface",
                  open ? "border-muted" : selected || editing ? "border-primary" : "border-line-strong",
                )}
              >
                <StepButton step={step} labels={labels} selected={selected} editing={editing} framed onSelect={() => onSelectStep(step.featureId)} onOpen={() => onOpenSketch(step.featureId)} />
                <button
                  type="button"
                  aria-expanded={open}
                  aria-label={open ? t("main.timeline.collapse", { name: step.label }) : t("main.timeline.expand", { name: step.label })}
                  data-testid={`timeline-expand-${step.featureId}`}
                  onClick={() => onToggle(step.featureId)}
                  className="relative grid h-6 w-4 cursor-pointer place-items-center border-l border-line-strong bg-transparent text-[12px] text-muted before:absolute before:-inset-x-[5px] before:-inset-y-[6px] before:content-[''] hover:text-fg"
                >
                  <span className={open ? "text-primary" : ""}>
                    <Glyph name={open ? "minus" : "plus"} />
                  </span>
                </button>
                {open ? (
                  <div className="inline-flex" data-testid={`timeline-sub-steps-${step.featureId}`}>
                    {step.subSteps.map((sub) => (
                      <SubButton key={sub.id} sub={sub} labels={labels} selected={selectedSubId === `${step.featureId}/${sub.id}`} onSelect={() => onSelectSub(step.featureId, sub.id)} />
                    ))}
                  </div>
                ) : null}
                {open ? <span aria-hidden="true" className="absolute right-0 bottom-0 left-0 h-0.5 bg-primary" /> : null}
              </div>
            </div>
          );
        })}
        {steps.length > 0 ? (
          <span
            aria-hidden="true"
            className="relative ml-1 h-8 w-[3px] flex-none bg-primary before:absolute before:-top-px before:-left-1 before:h-[7px] before:w-[11px] before:rounded-t-sm before:bg-primary before:content-['']"
          />
        ) : null}
      </div>
      <div className="min-w-[210px] flex-none text-right text-[12px] whitespace-nowrap text-muted" data-testid="timeline-position">
        {t("main.timeline.position", { current: steps.length, total: steps.length })} · <b className="font-semibold text-fg">{componentName}</b>
      </div>
    </section>
  );
}
