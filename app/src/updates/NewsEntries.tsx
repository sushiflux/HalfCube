// The pieces of a changelog entry as "Was ist neu", the update window and "Alle Änderungen" show them: the lines of an entry grouped by
// product area in the fixed order, every line behind its category badge (one shared component), and inline Markdown for the text.
import { Fragment, type ReactNode } from "react";
import type { Language } from "../i18n/types.ts";
import { cx } from "../ui/cx.ts";
import { CategoryBadge } from "./Badges.tsx";
import type { ChangelogEntry } from "./changelog.ts";
import { orderSections } from "./news-logic.ts";

/** Inline Markdown of a changelog line: **bold**, *italic*, `code` and [links] (the link text only; nothing is ever opened from here). */
export function inlineMarkdown(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|\[[^\]]+\]\([^)]*\))/g;
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const token = match[0];
    if (token.startsWith("**")) out.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith("`")) out.push(<code key={key++} className="mono text-[12px]">{token.slice(1, -1)}</code>);
    else if (token.startsWith("[")) out.push(token.slice(1, token.indexOf("](")));
    else out.push(<em key={key++}>{token.slice(1, -1)}</em>);
    last = at + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** The sections of one entry: area label, then its lines with their category badges. */
export function EntryBody({ entry, language, compact = false, className }: { entry: ChangelogEntry; language: Language; compact?: boolean; className?: string }) {
  const sections = orderSections(entry.sections, language);
  return (
    <div className={className} data-testid="news-entry-body">
      {sections.map((section, i) => (
        <Fragment key={`${section.area ?? ""}-${i}`}>
          {section.area !== null ? (
            <div className={cx("mt-2.5 mb-1 text-[11px] font-semibold tracking-[0.12em] text-muted uppercase", i === 0 && "mt-0.5")} data-testid="news-area">
              {section.area}
            </div>
          ) : null}
          {section.lines.map((line, j) => (
            <div key={j} className={cx("grid items-start gap-2.5 py-1 leading-[1.45]", compact ? "grid-cols-[96px_1fr] text-[12.5px]" : "grid-cols-[104px_1fr] text-[13.5px]")} data-testid="news-line">
              <span className="mt-px justify-self-start">{line.category ? <CategoryBadge category={line.category} /> : null}</span>
              <span>{inlineMarkdown(line.text)}</span>
            </div>
          ))}
        </Fragment>
      ))}
    </div>
  );
}
