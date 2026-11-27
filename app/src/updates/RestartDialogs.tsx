// The small own dialogs of the update flow: the restart warning (shown only after the click on "Jetzt neu starten" and only when the
// open design would be lost), the "restarting" notice (and the error when the restart did not start), and the error of a failed
// check with its complete, copyable text.
import { useId, useRef } from "react";
import { useI18n } from "../i18n/runtime.ts";
import { Button } from "../ui/Button.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { ErrorNotice } from "../ui/ErrorNotice.tsx";
import { Glyph } from "../ui/Glyph.tsx";
import { IconRefresh } from "../ui/icons.tsx";
import { confirmRestart, installOnExit, requestRestart, startDownload } from "./actions.ts";
import { updates, useUpdates } from "./controller.ts";
import { describeUpdateError } from "./errors.ts";
import { updateUi } from "./ui-state.ts";
import { detailError, isSupported } from "./view-model.ts";
import { type DesignWork } from "./work.ts";

/** Role alertdialog, focus on "Abbrechen": "Beim Beenden installieren" on the left, then "Abbrechen" and the destructive "Verwerfen und neu starten". */
export function RestartWarning({ open, work }: { open: boolean; work: DesignWork | null }) {
  const { t } = useI18n();
  const { state } = useUpdates();
  const cancel = useRef<HTMLButtonElement>(null);
  const messageId = useId();
  const scheduled = isSupported(state) && state.phase.kind === "on-exit";
  const steps = work?.steps ?? 0;
  const stepsText = steps === 1 ? t("updates.restart.stepsOne") : t("updates.restart.stepsMany", { count: steps });
  return (
    <Dialog
      open={open && work !== null}
      onClose={() => updateUi.closeView()}
      title={t("updates.restart.title")}
      role="alertdialog"
      size="wide"
      describedById={messageId}
      initialFocus={cancel}
      footer={
        <>
          {scheduled ? null : (
            <Button onClick={installOnExit} className="mr-auto" data-testid="restart-on-exit">
              {t("updates.restart.onExit")}
            </Button>
          )}
          <Button ref={cancel} onClick={() => updateUi.closeView()} data-testid="restart-cancel">
            {t("updates.restart.cancel")}
          </Button>
          <Button variant="destructive" onClick={confirmRestart} data-testid="restart-discard">
            {t("updates.restart.discard")}
          </Button>
        </>
      }
    >
      <div id={messageId} className="flex items-start gap-3" data-testid="restart-warning">
        <span className="mt-px flex-none text-[22px] text-warning">
          <Glyph name="warning" />
        </span>
        <div>
          <p className="mb-2">{t("updates.restart.message", { name: work?.name ?? "", steps: stepsText })}</p>
          <p className="text-muted">
            {t("updates.restart.wait")}
            {scheduled ? "" : ` ${t("updates.restart.waitExit")}`}
          </p>
        </div>
      </div>
    </Dialog>
  );
}

/** While the program is about to close, and the error if the restart could not be started. */
export function RestartingDialog() {
  const { t } = useI18n();
  const { restarting, restartError, state } = useUpdates();
  const channel = isSupported(state) ? state.channel : "";
  const error = restartError ? describeUpdateError(restartError, t, channel) : null;
  const close = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Dialog open={restarting} onClose={() => undefined} closeOnBackdrop={false} title={t("updates.restart.restartingTitle")} size="sm">
        <div className="flex items-center gap-3.5 py-1" data-testid="restarting" role="status">
          <span className="size-5 flex-none animate-[hc-spin_0.9s_linear_infinite] rounded-full border-2 border-[rgb(127_127_127/0.35)] border-t-primary" aria-hidden="true" />
          <span>{t("updates.restart.restarting")}</span>
        </div>
      </Dialog>
      <Dialog
        open={error !== null && !restarting}
        onClose={() => updates.dismissRestartError()}
        title={t("updates.restart.failedTitle")}
        showClose
        size="md"
        initialFocus={close}
        footer={
          <>
            <Button ref={close} onClick={() => updates.dismissRestartError()} data-testid="restart-error-close">
              {t("updates.window.close2")}
            </Button>
            <Button
              variant="primary"
              icon={<IconRefresh />}
              onClick={() => {
                updates.dismissRestartError();
                requestRestart();
              }}
              data-testid="restart-error-retry"
            >
              {t("updates.retry")}
            </Button>
          </>
        }
      >
        {error ? <ErrorNotice headline={error.headline} code={error.code} details={error.details} occurredAt={error.occurredAt} detailsMaxHeight="min(40vh, 320px)" defaultOpen /> : null}
      </Dialog>
    </>
  );
}

/** The complete, copyable error of a failed check ("Details" in the update slot). */
export function CheckErrorDialog({ open }: { open: boolean }) {
  const { t } = useI18n();
  const { state } = useUpdates();
  const retry = useRef<HTMLButtonElement>(null);
  const detail = isSupported(state) ? detailError(state.phase) : null;
  const error = detail ? describeUpdateError(detail.error, t, isSupported(state) ? state.channel : "") : null;
  const newer = detail?.source === "newer";
  return (
    <Dialog
      open={open && error !== null}
      onClose={() => updateUi.closeView()}
      title={newer ? t("updates.window.titleFailed") : t("updates.errorDialogTitle")}
      showClose
      size="md"
      initialFocus={retry}
      footer={
        <>
          <Button onClick={() => updateUi.closeView()} data-testid="check-error-close">
            {t("updates.window.close2")}
          </Button>
          <Button
            ref={retry}
            variant="primary"
            icon={<IconRefresh />}
            onClick={() => {
              updateUi.closeView();
              if (newer) startDownload();
              else void updates.checkNow();
            }}
            data-testid="check-error-retry"
          >
            {t("updates.retry")}
          </Button>
        </>
      }
    >
      <div data-testid="check-error">{error ? <ErrorNotice headline={error.headline} code={error.code} details={error.details} occurredAt={error.occurredAt} detailsMaxHeight="min(40vh, 320px)" defaultOpen /> : null}</div>
    </Dialog>
  );
}
