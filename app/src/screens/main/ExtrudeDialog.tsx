// The extrude dialog a floating window in the 3D view with the notched close button. Profile, direction
// ("one side" / "symmetric" and the opposite direction), the distance in the value field and the result (only "new body" in this
// slice). Every row has its room from the start, so nothing moves when a hint, a problem or a preview appears: the message under the
// distance has two lines reserved, problems of the engine come as a notice laid over the view under the window (never inside it).
// Enter confirms, Esc cancels (handled for the whole command in MainWindow); the field has the keyboard from the first moment.
import { useEffect, useRef, type ReactNode } from "react";
import { useI18n } from "../../i18n/runtime.ts";
import { quantityErrorText } from "../../model/index.ts";
import { Button } from "../../ui/Button.tsx";
import { cx } from "../../ui/cx.ts";
import { Glyph } from "../../ui/Glyph.tsx";
import { NotchFrame, NOTCH_BUTTON } from "../../ui/NotchFrame.tsx";
import { Segmented } from "../../ui/Segmented.tsx";
import { Tip } from "../../ui/Tip.tsx";
import { ValueField } from "../../ui/ValueField.tsx";
import type { ExtrudeCommand, ExtrudeState } from "./extrude-command.ts";

export interface ExtrudeDialogProps {
  command: ExtrudeCommand;
  state: ExtrudeState;
  /** "Fläche 1 · Skizze1", or null while no area is chosen. */
  profileLabel: string | null;
}

export function ExtrudeDialog({ command, state, profileLabel }: ExtrudeDialogProps) {
  const { t, language } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  // The field has the keyboard from the first moment: typing a distance is what the dialog is for.
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const { form, distance } = state;
  const symmetric = form.extent === "symmetric";
  const invalid = !distance.ok;
  const message = !distance.ok ? (distance.error === "notPositive" ? t("main.extrude.distanceRule") : quantityErrorText(t, distance, "length")) : symmetric ? t("main.extrude.hintSymmetric") : t("main.extrude.hintOneSide");
  const canConfirm = state.profile !== null && distance.ok && !state.confirming;
  const decimalComma = language === "de";

  return (
    <NotchFrame
      role="dialog"
      aria-label={t("main.extrude.dialogLabel")}
      data-testid="extrude-dialog"
      data-pending={state.pending || undefined}
      data-mode={state.mode}
      className="w-full"
      action={
        <button
          type="button"
          aria-label={t("main.extrude.close")}
          onClick={() => command.cancel()}
          data-testid="extrude-close"
          style={{ width: NOTCH_BUTTON, height: NOTCH_BUTTON }}
          className="inline-grid cursor-pointer place-items-center rounded-ctl bg-destructive text-[16px] text-on-destructive hover:brightness-95 dark:hover:brightness-110"
        >
          <Glyph name="close" />
        </button>
      }
      onKeyDown={(event) => {
        // Enter confirms from the field and from anywhere in the window except a plain button (it keeps its own Enter); a choice of
        // the direction or result bar is a radio button and has nothing to do with Enter, so Enter confirms there too.
        const button = (event.target as HTMLElement).closest("button");
        if (event.key !== "Enter" || event.nativeEvent.isComposing || (button && button.getAttribute("role") !== "radio")) return;
        event.preventDefault();
        void command.confirm();
      }}
    >
      <div className="px-3.5 pt-[11px] pb-3.5">
        <h2 className="mb-3 flex min-h-[22px] items-center gap-2 text-[14px] font-semibold">
          <span className="text-[18px]">
            <Glyph name="fnExtrude" />
          </span>
          {t("main.extrude.title")}
        </h2>

        <Row label={t("main.extrude.profile")}>
          <Tip label={t("main.extrude.profileSwitch")} align="start">
            <span
              data-testid="extrude-profile"
              data-chosen={state.profile !== null || undefined}
              className={cx(
                "inline-flex h-7 items-center gap-1.5 rounded-ctl border px-2 text-[12px] font-semibold",
                state.profile !== null ? "border-primary text-primary" : "border-line-strong text-muted",
              )}
            >
              <span className="text-[15px]">
                <Glyph name="rectangle" />
              </span>
              {profileLabel ?? t("main.extrude.profileNone")}
            </span>
          </Tip>
        </Row>

        <Row label={t("main.extrude.direction")}>
          <div className="flex items-center gap-1.5">
            <Segmented
              size="sm"
              label={t("main.extrude.direction")}
              value={form.extent}
              onChange={(extent) => command.setExtent(extent)}
              options={[
                { value: "oneSide", label: t("main.extrude.oneSide"), testId: "extrude-one-side" },
                { value: "symmetric", label: t("main.extrude.symmetric"), testId: "extrude-symmetric" },
              ]}
            />
            <Tip label={symmetric ? t("main.extrude.flipSymmetric") : t("main.extrude.flipTip")} align="start">
              <button
                type="button"
                aria-label={t("main.extrude.flip")}
                aria-pressed={symmetric ? false : form.reversed}
                disabled={symmetric}
                onClick={(event) => {
                  command.flip();
                  // A mouse click hands the keyboard back to the field (a key press stays on the button, as keyboard users expect).
                  if (event.detail > 0) input.current?.focus();
                }}
                data-testid="extrude-flip"
                className={cx(
                  "relative inline-grid size-7 cursor-pointer place-items-center overflow-hidden rounded-ctl border border-line-strong bg-surface text-[15px]",
                  "disabled:cursor-not-allowed disabled:opacity-45",
                  !symmetric && form.reversed ? "bg-primary-soft text-fg" : "text-muted hover:bg-surface-2 hover:text-fg disabled:hover:bg-surface disabled:hover:text-muted",
                )}
              >
                <Glyph name="flip" />
                {!symmetric && form.reversed ? <span aria-hidden="true" className="absolute right-0 bottom-0 left-0 h-[3px] bg-primary" /> : null}
              </button>
            </Tip>
          </div>
        </Row>

        <Row label={symmetric ? t("main.extrude.thickness") : t("main.extrude.distance")}>
          <ValueField
            value={form.text}
            onChange={(text) => command.setText(text)}
            unit="mm"
            label={symmetric ? t("main.extrude.thicknessLabel") : t("main.extrude.distanceLabel")}
            look="dimension"
            active
            invalid={invalid}
            inputRef={input}
            data-testid="extrude-distance"
            data-decimal={decimalComma ? "comma" : "point"}
          />
        </Row>
        <p
          data-testid="extrude-hint"
          data-invalid={invalid || undefined}
          aria-live="polite"
          className={cx("mb-2.5 -mt-1 min-h-[34px] text-[12px] leading-[1.35]", invalid ? "text-error" : "text-muted")}
        >
          {message}
        </p>

        <Row label={t("main.extrude.result")}>
          <Segmented
            size="sm"
            label={t("main.extrude.result")}
            value="newBody"
            onChange={() => undefined}
            options={[
              { value: "join", label: t("main.extrude.join"), disabled: true, hint: t("main.extrude.laterTip") },
              { value: "cut", label: t("main.extrude.cut"), disabled: true, hint: t("main.extrude.laterTip") },
              { value: "newBody", label: t("main.extrude.newBody"), testId: "extrude-new-body" },
            ]}
          />
        </Row>

        <div className="mt-3 flex justify-end gap-2">
          <Button onClick={() => command.cancel()} data-testid="extrude-cancel">
            {t("main.extrude.cancel")}
          </Button>
          <Button variant="primary" disabled={!canConfirm} loading={state.confirming} onClick={() => void command.confirm()} data-testid="extrude-ok">
            {t("main.extrude.confirm")}
          </Button>
        </div>
      </div>
    </NotchFrame>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mb-2.5 grid grid-cols-[78px_1fr] items-center gap-2">
      <span className="text-[12px] font-medium text-muted">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
