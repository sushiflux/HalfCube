// "Was ist neu": a window with the changelog entry of the version now running (only that one, like other programs do), grouped by
// product area with a category badge on every line. It scrolls inside when the entry is long. One click closes it (close button, Esc,
// backdrop); what it showed is remembered, so it never opens again for that version. The link "Alle Änderungen anzeigen" leads to
// everything older.
import { useId, useState } from "react";
import { useI18n } from "../i18n/runtime.ts";
import type { Language } from "../i18n/types.ts";
import { Modal } from "../ui/Modal.tsx";
import { NotchCloseButton, NotchFrame } from "../ui/NotchFrame.tsx";
import { ScrollArea } from "../ui/ScrollArea.tsx";
import { AllChangesLink } from "./AllChangesLink.tsx";
import { ChannelBadge } from "./Badges.tsx";
import { EntryBody } from "./NewsEntries.tsx";
import { formatIsoDate } from "./format.ts";
import { entryOfVersion, entryTitle, type NewsSource } from "./news-logic.ts";
import { newsSourceRef } from "./runtime.ts";
import { updateUi } from "./ui-state.ts";

/** Closes the window and remembers that the running version was shown. */
export function closeNews(source: NewsSource = newsSourceRef.current): void {
  source.remember(source.currentId);
  updateUi.closeNews();
}

function readNews(language: Language) {
  const source = newsSourceRef.current;
  return { source, entry: entryOfVersion(source.markdown(), language, source.currentId) };
}

export function NewsDialog({ open }: { open: boolean }) {
  const { t, language } = useI18n();
  const titleId = useId();
  // Read when the window opens: closing it stores the running version, which must not change the content while the window fades out.
  const [content, setContent] = useState(() => readNews(language));
  const [readKey, setReadKey] = useState<string>(open ? language : "closed");
  const key = open ? language : "closed";
  if (key !== readKey) {
    setReadKey(key);
    if (open) setContent(readNews(language));
  }
  const { entry, source } = content;
  const date = entry?.date ? formatIsoDate(entry.date, language) : null;
  return (
    <Modal open={open} onClose={() => closeNews(source)} aria-labelledby={titleId} top="compact" className="w-[min(720px,calc(100vw-32px))]">
      <NotchFrame action={<NotchCloseButton label={t("updates.news.close")} onClick={() => closeNews(source)} data-testid="news-close" />} data-testid="news-window">
        <div className="flex flex-col text-fg">
          <h2 id={titleId} className="mt-1 flex min-h-10 flex-none items-center px-14 pl-6 text-[15px] font-semibold">
            {t("updates.news.title")}
          </h2>
          <div className="flex flex-none items-center gap-2 px-6 text-[12.5px] text-muted" data-testid="news-sub">
            <span className="mono font-semibold text-fg">{entry ? entryTitle(entry) : source.currentId}</span>
            <ChannelBadge channel={source.channel} />
            {date ? <span data-testid="news-date">{date}</span> : null}
          </div>
          {/* The height follows the entry up to 640 px (or the window); beyond that the list scrolls inside, the footer stays at the bottom. 150 px are the title, the version line and the footer. */}
          <ScrollArea className="mt-2.5" viewportClassName="max-h-[min(490px,calc(100vh-222px))]" data-testid="news-scroll">
            {entry ? <EntryBody entry={entry} language={language} className="px-6 pb-3" /> : <p className="px-6 py-3 text-[13px] text-muted">{t("updates.news.empty")}</p>}
          </ScrollArea>
          <div className="flex-none border-t border-line px-6 pt-1.5 pb-3.5">
            <AllChangesLink source="app" />
            <p className="mt-0.5 text-[12.5px] text-muted">{t("updates.news.foot")}</p>
          </div>
        </div>
      </NotchFrame>
    </Modal>
  );
}
