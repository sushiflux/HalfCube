// Logo, wordmark and credit line. The logo is the real image, only scaled: never redrawn, cropped or recoloured.
import { branding } from "../branding.ts";
import { useT } from "../i18n/runtime.ts";
import logo512 from "../../../branding/icons/icon-512.png";
import logo128 from "../../../branding/icons/icon-128.png";
import logo64 from "../../../branding/icons/icon-64.png";
import { cx } from "./cx.ts";
import { wordmarkBaseline, wordmarkOutlines, wordmarkSmallBelow, wordmarkUnitsPerEm } from "./wordmark.generated.ts";

/** Square logo files (the logo with its transparent margin), scaled from branding/source/logo-square.png. */
export const logoSources = { large: logo512, medium: logo128, small: logo64 } as const;

export function Logo({
  size,
  source = "medium",
  className,
  ...rest
}: {
  size: number | string;
  source?: keyof typeof logoSources;
  className?: string;
  "data-handover-target"?: string;
}) {
  return (
    <img
      src={logoSources[source]}
      alt=""
      aria-hidden="true"
      width={typeof size === "number" ? size : undefined}
      height={typeof size === "number" ? size : undefined}
      draggable={false}
      className={cx("block flex-none select-none", className)}
      style={typeof size === "string" ? { width: size, height: size } : undefined}
      {...rest}
    />
  );
}

/**
 * Wordmark "Klar": "Half" and "Cube" as the letter outlines of branding/wordmark (Geist, weight 600 at large sizes and
 * 640 below 28 px, letter spacing -0.028em large and +0.004em small), generated into wordmark.generated.ts by
 * scripts/make-wordmark.mjs. It is a drawing, not text, so no font has to be loaded and nothing flashes. The two colours
 * are fixed brand colours (light and dark, `--wm-half` / `--wm-cube`), independent of the colour theme. The same drawing at
 * every size, only scaled. The box is a text line of height 1 em with the baseline where Geist puts it, so it sits where the
 * text version sat.
 */
export function Wordmark({
  size,
  small,
  className,
}: {
  /** Font size in px, or any CSS length (e.g. "calc(68 * var(--u))" together with `small`). */
  size: number | string;
  small?: boolean;
  className?: string;
}) {
  const isSmall = small ?? (typeof size === "number" && size < wordmarkSmallBelow);
  const outline = isSmall ? wordmarkOutlines.small : wordmarkOutlines.large;
  const em = wordmarkUnitsPerEm;
  return (
    <span
      role="img"
      aria-label={branding.name}
      data-wordmark={isSmall ? "small" : "large"}
      className={cx("inline-block flex-none", className)}
      style={{
        fontSize: size,
        width: `${outline.advance / em}em`,
        height: "1em",
        // Like a line of text: the baseline of the drawing sits on the baseline of the line around it.
        verticalAlign: `${-(em - wordmarkBaseline) / em}em`,
      }}
    >
      <svg
        aria-hidden="true"
        focusable="false"
        viewBox={`0 ${-wordmarkBaseline} ${outline.advance} ${em}`}
        className="block size-full overflow-visible"
      >
        <path className="fill-wm-half" d={outline.half} />
        <path className="fill-wm-cube" d={outline.cube} />
      </svg>
    </span>
  );
}

/** "Mit ♥ gemacht" in German, "Made with ♥" in every other language. The heart is always green. */
export function CreditLine({ onDark = false, className }: { onDark?: boolean; className?: string }) {
  const t = useT();
  const after = t("credit.after");
  return (
    <span className={className}>
      {t("credit.before")} <span className={onDark ? "text-[#4ade80]" : "text-toggle-on"}>♥</span>
      {after === "" ? "" : ` ${after}`}
    </span>
  );
}
