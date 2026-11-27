// The two kinds of badge of the update views: the channel of a version (Nightly purple, Beta blue, a release has none) and the
// category of a changelog line (one shared component, one colour per category, the word is always there, never colour alone).
import type { ReactNode } from "react";
import { useT } from "../i18n/runtime.ts";
import { IconAlertTriangle, IconLock, IconRefresh, IconSparkles, IconTool, IconTrash } from "../ui/icons.tsx";
import type { Channel } from "../version.ts";
import type { ChangelogCategory } from "./changelog.ts";
import "./updates.css";

const categoryIcons: Record<ChangelogCategory, ReactNode> = {
  new: <IconSparkles size={13} />,
  change: <IconRefresh size={13} />,
  fix: <IconTool size={13} />,
  security: <IconLock size={13} />,
  removed: <IconTrash size={13} />,
  deprecated: <IconAlertTriangle size={13} />,
};

export function CategoryBadge({ category }: { category: ChangelogCategory }) {
  const t = useT();
  return (
    <span className="hc-badge" data-cat={category} data-testid="category-badge">
      {categoryIcons[category]}
      {t(`updates.category.${category}`)}
    </span>
  );
}

/** The channel of a version; nothing for a release and for a dev build. */
export function ChannelBadge({ channel }: { channel: Channel }) {
  const t = useT();
  if (channel !== "nightly" && channel !== "beta") return null;
  return (
    <span className="hc-badge" data-channel={channel} data-testid="channel-badge">
      {channel === "nightly" ? t("updates.channelNightly") : t("updates.channelBeta")}
    </span>
  );
}
