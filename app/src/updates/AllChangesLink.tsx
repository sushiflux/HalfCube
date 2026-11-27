// The link "Alle Änderungen anzeigen": with a product website (website.ts) it opens that page in the system browser, without one it opens
// the app's own dialog with the complete changelog. The source says where the dialog takes its entries from: the changelog shipped with
// the app ("app"), or the release notes of the offered update ("update", from the update window, because they also carry the skipped
// versions).
import { useT } from "../i18n/runtime.ts";
import type { ChangesSource } from "../screens/main/url-state.ts";
import { ExternalLink } from "../ui/ExternalLink.tsx";
import { IconExternal, IconFileText } from "../ui/icons.tsx";
import { CHANGELOG_WEBSITE_URL } from "./website.ts";
import { updateUi } from "./ui-state.ts";

const linkClass = "inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-ctl px-1 text-[13px] font-medium text-primary hover:underline";

export function AllChangesLink({ source }: { source: ChangesSource }) {
  const t = useT();
  if (CHANGELOG_WEBSITE_URL !== "") {
    return (
      <ExternalLink href={CHANGELOG_WEBSITE_URL} className={linkClass} data-testid="all-changes-link">
        <span className="inline-flex text-base">
          <IconFileText />
        </span>
        {t("updates.allChanges")}
        <span className="inline-flex text-[14px]">
          <IconExternal />
        </span>
      </ExternalLink>
    );
  }
  return (
    <button type="button" onClick={() => updateUi.openChanges(source)} className={linkClass} data-testid="all-changes-link">
      <span className="inline-flex text-base">
        <IconFileText />
      </span>
      {t("updates.allChanges")}
    </button>
  );
}
