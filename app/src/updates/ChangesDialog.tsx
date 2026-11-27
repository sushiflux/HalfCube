// "Alle Änderungen": the complete changelog of the channel in the app's own dialog (used while HalfCube has no website, see website.ts).
// Every entry, newest first, each under its version and month, its lines grouped by area with the category badges as in "Was ist
// neu"; all entries are open and the window scrolls inside. It works offline: from the channel file shipped with the app, and from the
// update window from the release notes of the offered update (which carry the newest entries of the channel, also the skipped ones).
import { useId, useMemo, useState } from "react";
import { useI18n } from "../i18n/runtime.ts";
import type { ChangesSource } from "../screens/main/url-state.ts";
import { Modal } from "../ui/Modal.tsx";
import { NotchCloseButton, NotchFrame } from "../ui/NotchFrame.tsx";
import { ScrollArea } from "../ui/ScrollArea.tsx";
import { useUpdates } from "./controller.ts";
import { EntryBody } from "./NewsEntries.tsx";
import { formatIsoDate } from "./format.ts";
import { allEntries, entryTitle } from "./news-logic.ts";
import { newsSourceRef } from "./runtime.ts";
import { updateUi } from "./ui-state.ts";
import { isSupported, offerOf } from "./view-model.ts";

/** The Markdown the dialog shows: the release notes of the offer when it comes from the update window and an offer exists, else the shipped file. */
function useChangesMarkdown(source: ChangesSource | null): string {
  const { state } = useUpdates();
  const offer = isSupported(state) ? offerOf(state.phase) : null;
  if (source === "update" && offer) return offer.notesMarkdown;
  return newsSourceRef.current.markdown();
}

export function ChangesDialog({ source }: { source: ChangesSource | null }) {
  const { t, language } = useI18n();
  const titleId = useId();
  // The dialog keeps its last source while it fades out.
  const [shown, setShown] = useState<ChangesSource>(source ?? "app");
  if (source !== null && source !== shown) setShown(source);
  const markdown = useChangesMarkdown(shown);
  const entries = useMemo(() => allEntries(markdown, language), [markdown, language]);
  const close = () => updateUi.closeChanges();
  return (
    <Modal open={source !== null} onClose={close} aria-labelledby={titleId} top="compact" className="h-[min(640px,calc(100vh-72px))] w-[min(720px,calc(100vw-32px))]">
      <NotchFrame action={<NotchCloseButton label={t("updates.changes.close")} onClick={close} data-testid="changes-close" />} className="h-full" contentClassName="h-full" data-testid="changes-window" data-source={source ?? ""}>
        <div className="flex h-full min-h-0 flex-col text-fg">
          <h2 id={titleId} className="mt-1 flex min-h-10 flex-none items-center px-14 pl-6 text-[15px] font-semibold">
            {t("updates.changes.title")}
          </h2>
          <div className="flex-none px-6 text-[12.5px] text-muted" data-testid="changes-sub">
            {entries.length > 0 ? t(entries.length === 1 ? "updates.changes.subOne" : "updates.changes.sub", { count: entries.length }) : ""}
          </div>
          <ScrollArea className="mt-2.5 min-h-0 flex-1 pb-2" data-testid="changes-scroll">
            {entries.length > 0 ? (
              entries.map((entry, i) => {
                const date = entry.date ? formatIsoDate(entry.date, language) : null;
                return (
                  <section key={`${entry.id}-${i}`} className="border-t border-line first:border-t-0" data-testid="changes-entry" data-version={entry.id ?? ""}>
                    <h3 className="flex min-h-11 items-baseline gap-2.5 px-6 pt-3 pb-1">
                      <span className="mono text-[14px] font-semibold">{entryTitle(entry)}</span>
                      {date ? <span className="text-[12.5px] text-muted" data-testid="changes-date">{date}</span> : null}
                    </h3>
                    <EntryBody entry={entry} language={language} className="px-6 pb-3" />
                  </section>
                );
              })
            ) : (
              <p className="px-6 py-3 text-[13px] text-muted">{t("updates.changes.empty")}</p>
            )}
          </ScrollArea>
        </div>
      </NotchFrame>
    </Modal>
  );
}
