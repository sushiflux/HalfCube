// A link to an address outside the program. The click goes to the Electron main process, which opens the system browser
// (the program window never navigates away). Without a bridge (unit tests, a bare dev page) it stays a plain link.
// A failure to open is reported in our own dialog, with the complete cause.
import type { MouseEvent, ReactNode } from "react";
import { parseExternalUrl } from "../about/external-url.ts";
import { useT } from "../i18n/runtime.ts";
import { getDesktopBridge } from "../platform.ts";
import { useConfirm } from "./Confirm.tsx";
import { cx } from "./cx.ts";

export interface ExternalLinkProps {
  href: string;
  children: ReactNode;
  className?: string;
  "data-testid"?: string;
}

export function ExternalLink({ href, children, className, ...rest }: ExternalLinkProps) {
  const t = useT();
  const confirm = useConfirm();
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    const bridge = getDesktopBridge();
    if (!bridge) return; // no desktop bridge: leave the plain link alone
    event.preventDefault();
    const url = parseExternalUrl(href);
    const done = url === null ? Promise.resolve({ ok: false as const, message: `Not a plain https address: ${href}` }) : bridge.openExternal(url);
    void done.then((result) => {
      if (result.ok) return;
      void confirm({
        title: t("about.openFailedTitle"),
        message: t("about.openFailedLead", { reason: result.message }),
        confirmLabel: t("common.ok"),
        hideCancel: true,
      });
    });
  };
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" onClick={onClick} className={cx("cursor-pointer", className)} {...rest}>
      {children}
    </a>
  );
}
