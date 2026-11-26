// The "Lizenzen" tab of "About Partcraft": a searchable list of the project's own texts and every bundled component, grouped,
// and a detail page per component with licence, copyright notice, source and the full licence text. The tab has the height
// the Info tab gives it; the list and the detail scroll inside it with the overlay scrollbar, so nothing else ever moves.
import { useRef, useState, type ReactNode } from "react";
import { useConfirm } from "../ui/Confirm.tsx";
import { useI18n } from "../i18n/runtime.ts";
import type { MessageKey } from "../i18n/types.ts";
import { getDesktopBridge } from "../platform.ts";
import { Button } from "../ui/Button.tsx";
import { CopyButton } from "../ui/CopyButton.tsx";
import { cx } from "../ui/cx.ts";
import { ExternalLink } from "../ui/ExternalLink.tsx";
import { IconAlert, IconArrowLeft, IconChevronRight, IconClose, IconExternal, IconInfo, IconSearch } from "../ui/icons.tsx";
import { ScrollArea } from "../ui/ScrollArea.tsx";
import { findItem, groupItems, listLicence, pickText, searchItems } from "./catalogue.ts";
import { useLicenceText } from "./licence-text.ts";
import { aboutStore } from "./state.ts";
import type { LicenceGroup, LicenceItem } from "./types.ts";

const groupKeys: Record<LicenceGroup, MessageKey> = {
  self: "about.groupSelf",
  engine: "about.groupEngine",
  ui: "about.groupUi",
  shell: "about.groupShell",
};

export interface AboutLicencesProps {
  items: readonly LicenceItem[];
  /** The component whose detail is open (from the address); an unknown id shows the list. */
  itemId: string | null;
}

export function AboutLicences({ items, itemId }: AboutLicencesProps) {
  const item = findItem(items, itemId);
  return item ? <Detail key={item.id} item={item} /> : <List items={items} />;
}

function List({ items }: { items: readonly LicenceItem[] }) {
  const { t, language } = useI18n();
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const found = searchItems(items, query, language);
  const groups = groupItems(found);
  return (
    <div className="flex min-h-0 flex-1 flex-col px-6 pt-3.5" data-testid="about-licences-list">
      <label className="flex h-[34px] flex-none items-center gap-2 rounded-ctl border border-line-strong bg-surface pr-1.5 pl-2.5 focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-primary">
        <span className="inline-flex text-base text-muted">
          <IconSearch />
        </span>
        <input
          ref={input}
          type="text"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder={t("about.searchLabel")}
          aria-label={t("about.searchLabel")}
          autoComplete="off"
          spellCheck={false}
          data-testid="about-search"
          className="h-full min-w-0 flex-1 border-0 bg-transparent text-[13px] text-fg outline-none placeholder:text-muted"
        />
        {/* Always in the layout, only invisible without text, so typing never changes the field. */}
        <button
          type="button"
          aria-label={t("about.searchClear")}
          tabIndex={query === "" ? -1 : 0}
          onClick={() => {
            setQuery("");
            input.current?.focus();
          }}
          data-testid="about-search-clear"
          className={cx("inline-grid size-[26px] cursor-pointer place-items-center rounded-ctl text-[14px] text-muted hover:text-fg", query === "" && "invisible")}
        >
          <IconClose />
        </button>
      </label>
      <p className="mt-2 mb-1 flex-none text-[12.5px] text-muted">{t("about.licencesIntro")}</p>
      <ScrollArea className="min-h-0 flex-1" viewportClassName="pb-[22px]">
        <div data-testid="about-licence-groups">
          {groups.length === 0 ? (
            <p role="status" className="px-2.5 py-4 text-[13px] text-muted" data-testid="about-search-none">
              {t("about.searchNone", { query: query.trim() })}
            </p>
          ) : (
            groups.map(({ group, items: rows }, index) => (
              <section key={group} aria-label={t(groupKeys[group])} data-testid={`about-group-${group}`}>
                <h3 className={cx("px-2.5 pb-1 text-[11px] font-semibold tracking-[0.12em] text-muted uppercase", index === 0 ? "pt-1.5" : "pt-3.5")}>{t(groupKeys[group])}</h3>
                {rows.map((row) => (
                  <button
                    key={row.id}
                    type="button"
                    aria-label={row.name}
                    onClick={() => aboutStore.setItem(row.id)}
                    data-testid={`licence-row-${row.id}`}
                    className="relative grid min-h-12 w-full cursor-pointer grid-cols-[1fr_auto_16px] items-center gap-2.5 border-0 border-b border-line bg-transparent px-2.5 py-1.5 text-left text-fg hover:bg-surface-2"
                  >
                    <span className="min-w-0">
                      <span className="block text-[13px] leading-[1.3] font-semibold">{row.name}</span>
                      <span className="block text-[12px] leading-[1.3] text-muted">{pickText(row.purpose, language)}</span>
                    </span>
                    <span className="text-right text-[11.5px] leading-[1.3] text-muted">
                      <b className="block text-[12px] font-medium text-fg">{listLicence(row, language)}</b>
                      <span className="mono">{pickText(row.version, language)}</span>
                    </span>
                    <span className="inline-flex text-[14px] text-muted">
                      <IconChevronRight />
                    </span>
                  </button>
                ))}
              </section>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="m-0 min-w-0 break-words">{children}</dd>
    </>
  );
}

function Detail({ item }: { item: LicenceItem }) {
  const { t, language } = useI18n();
  const labelled = item.licenseLabel !== undefined && item.group !== "self";
  const note = pickText(item.note, language);
  return (
    <div className="flex min-h-0 flex-1 flex-col px-6 pt-2" data-testid="about-licence-detail" data-item={item.id}>
      <div className="flex-none">
        <button
          type="button"
          onClick={() => aboutStore.setItem(null)}
          data-testid="about-back"
          className="-ml-1 inline-flex h-[30px] cursor-pointer items-center gap-1.5 rounded-ctl pr-2 pl-1 text-[13px] font-medium text-primary hover:underline"
        >
          <span className="inline-flex text-base">
            <IconArrowLeft />
          </span>
          {t("about.back")}
        </button>
      </div>
      <ScrollArea className="min-h-0 flex-1" viewportClassName="pb-[22px]">
        <div className="flex flex-wrap items-baseline gap-x-2.5">
          <h3 className="m-0 text-[18px] font-semibold tracking-[-0.01em]">{item.name}</h3>
          <span className="mono text-[13px] font-medium">{pickText(item.version, language)}</span>
        </div>
        <div className="text-[13px] text-muted">{pickText(item.purpose, language)}</div>
        <dl className="mt-2 grid grid-cols-[148px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[12.5px]">
          <Field label={t("about.fieldLicence")}>
            <span data-testid="detail-licence">{labelled ? pickText(item.licenseLabel, language) : pickText(item.license, language)}</span>
            {labelled ? <span className="mono block text-[11.5px] text-muted">{pickText(item.license, language)}</span> : null}
          </Field>
          <Field label={t("about.fieldCopyright")}>
            {item.copyright.length === 0 ? <span className="text-muted">{t("about.noCopyright")}</span> : item.copyright.map((line) => <div key={line}>{line}</div>)}
          </Field>
          <Field label={t("about.fieldSource")}>
            <ExternalLink href={item.source} className="inline-flex items-center gap-[5px] rounded-ctl font-medium text-primary hover:underline">
              {item.source.replace(/^https:\/\//, "")}
              <span className="inline-flex text-[14px]">
                <IconExternal />
              </span>
            </ExternalLink>
          </Field>
        </dl>
        {note !== "" ? <div className="mt-2.5 rounded-card border border-line bg-surface-2 px-3 py-2 text-[12.5px]">{note}</div> : null}
        <div className="mt-3.5 mb-1.5 text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">{t("about.licenceText")}</div>
        <LicenceText item={item} />
      </ScrollArea>
    </div>
  );
}

function LicenceText({ item }: { item: LicenceItem }) {
  const { t } = useI18n();
  const state = useLicenceText(item.textFile);
  const confirm = useConfirm();

  if (state === null) {
    // No text file: on the desktop the Chromium licences are a file of Electron's own, opened through the main process.
    const bridge = getDesktopBridge();
    if (item.id === "chromium" && bridge) {
      return (
        <div className="rounded-card border border-line bg-bg p-3 text-[12.5px]" data-testid="licence-text" data-state="chromium">
          <p className="m-0 mb-2.5 flex gap-2">
            <span className="mt-px inline-flex flex-none text-base text-muted">
              <IconInfo />
            </span>
            {t("about.chromiumNote")}
          </p>
          <Button
            size="sm"
            icon={<IconExternal />}
            data-testid="open-chromium-licences"
            onClick={() => {
              void bridge.openChromiumLicences().then((result) => {
                if (result.ok) return;
                void confirm({ title: t("about.openFailedTitle"), message: t("about.openFailedLead", { reason: result.message }), confirmLabel: t("common.ok"), hideCancel: true });
              });
            }}
          >
            {t("about.openChromium")}
          </Button>
        </div>
      );
    }
    return (
      <p className="flex gap-2 rounded-card border border-line bg-bg p-3 text-[12.5px]" data-testid="licence-text" data-state="missing">
        <span className="mt-px inline-flex flex-none text-base text-muted">
          <IconInfo />
        </span>
        {t("about.textMissing")}
      </p>
    );
  }

  if (state.status === "failed") {
    const message = t("about.textFailed", { file: item.textFile ?? "", reason: state.reason });
    return (
      <div role="alert" className="selectable rounded-card border border-line bg-bg p-3 text-[12.5px]" data-testid="licence-text" data-state="failed">
        <p className="m-0 mb-2.5 flex gap-2">
          <span className="mt-px inline-flex flex-none text-base text-error">
            <IconAlert />
          </span>
          <span className="min-w-0 break-words">{message}</span>
        </p>
        <CopyButton getText={() => message} size="sm" />
      </div>
    );
  }

  if (state.status === "loading") {
    return (
      <div className="min-h-[120px] rounded-card border border-line bg-bg p-3 text-[12.5px] text-muted" data-testid="licence-text" data-state="loading">
        {t("about.textLoading")}
      </div>
    );
  }

  return (
    <div className="rounded-card border border-line bg-bg" data-testid="licence-text" data-state="ready">
      <pre className="selectable m-0 px-4 py-3 font-mono text-[11.5px] leading-[1.55] break-words whitespace-pre-wrap text-fg">{state.text}</pre>
    </div>
  );
}
