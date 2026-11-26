// Logo, wordmark and credit line. The logo is the real image, only scaled: never redrawn, cropped or recoloured.
import { branding } from "../branding.ts";
import { useT } from "../i18n/runtime.ts";
import logo512 from "../../../branding/icons/icon-512.png";
import logo128 from "../../../branding/icons/icon-128.png";
import logo64 from "../../../branding/icons/icon-64.png";
import { cx } from "./cx.ts";

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
 * Wordmark "Klar": "Half" and "Cube" in Geist, weight 600 at large sizes and 640 below about 28 px, letter spacing
 * -0.028em large and +0.004em small. The two colours are fixed brand colours (light and dark), independent of the
 * colour theme. The same drawing at every size, only scaled.
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
  const isSmall = small ?? (typeof size === "number" && size < 28);
  return (
    <span
      role="img"
      aria-label={branding.name}
      className={cx("inline-block font-sans leading-none whitespace-nowrap text-wm-half", className)}
      style={{
        fontSize: size,
        fontWeight: isSmall ? 640 : 600,
        letterSpacing: isSmall ? "0.004em" : "-0.028em",
      }}
    >
      Half<i className="text-wm-cube not-italic">Cube</i>
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
