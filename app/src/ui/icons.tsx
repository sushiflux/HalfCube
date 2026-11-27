// Icons (Tabler-style outlines, 24 px grid, drawn inline so nothing is loaded and everything follows currentColor).
import type { ReactNode, SVGProps } from "react";

export type IconProps = Omit<SVGProps<SVGSVGElement>, "children"> & { size?: number | string };

function outline(paths: ReactNode, strokeWidth = 1.8) {
  return function Icon({ size = "1em", ...rest }: IconProps) {
    return (
      <svg
        viewBox="0 0 24 24"
        width={size}
        height={size}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        className="inline-block flex-none"
        {...rest}
      >
        {paths}
      </svg>
    );
  };
}

export const IconCopy = outline(
  <>
    <rect x="8" y="8" width="12" height="12" rx="2" />
    <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
  </>,
);
export const IconCheck = outline(<path d="M5 12.5l4.5 4.5L19 7.5" />, 2);
export const IconRetry = outline(<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" />, 1.9);
export const IconChevronRight = outline(<path d="M9 6l6 6-6 6" />, 2);
export const IconClose = outline(<path d="M6 6l12 12M18 6L6 18" />, 1.6);
export const IconPlus = outline(<path d="M12 5v14M5 12h14" />);
export const IconInfo = outline(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8h.01" />
  </>,
);
export const IconAlert = outline(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8v5M12 16h.01" />
  </>,
);
export const IconSketch = outline(
  <>
    <path d="M4 20h4L18.5 9.5a2.8 2.8 0 0 0-4-4L4 16v4" />
    <path d="M13.5 6.5l4 4" />
  </>,
);
export const IconTimeline = outline(
  <>
    <path d="M4 12h16" />
    <circle cx="7" cy="12" r="2" />
    <circle cx="13" cy="12" r="2" />
    <path d="M19 8v8" />
  </>,
);
export const IconCube = outline(
  <>
    <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
    <path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" />
  </>,
);
export const IconFree = outline(
  <>
    <circle cx="6" cy="6" r="2" />
    <circle cx="6" cy="18" r="2" />
    <circle cx="18" cy="8" r="2" />
    <path d="M6 8v8M18 10a6 6 0 0 1-6 6H8" />
  </>,
);
export const IconOpen = outline(
  <>
    <path d="M4 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v1" />
    <path d="M4 19l2.5-7h15L19 19z" />
  </>,
);
export const IconTour = outline(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M15.5 8.5l-2 5l-5 2l2-5z" />
  </>,
);

export type StepIconState = "pending" | "active" | "done" | "failed" | "warning";

/** The 16 px status icon of a loading step. The spinner stops under reduced motion (global rule in index.css). */
export function StepIcon({ state, className = "" }: { state: StepIconState; className?: string }) {
  const base = `inline-grid size-4 flex-none place-items-center ${className}`;
  switch (state) {
    case "done":
      return (
        <span className={`${base} text-primary`} data-step-state="done">
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <path d="M3.4 8.4l3 3 6.2-7" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      );
    case "active":
      return (
        <span className={`${base} text-primary`} data-step-state="active">
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity=".22" strokeWidth="2" />
            <path
              d="M8 2a6 6 0 0 1 6 6"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              style={{ transformOrigin: "50% 50%", animation: "hc-spin 0.9s linear infinite" }}
            />
          </svg>
        </span>
      );
    case "failed":
      return (
        <span className={`${base} text-destructive`} data-step-state="failed">
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <circle cx="8" cy="8" r="7.2" fill="currentColor" />
            <path d="M8 4.3v4.6" stroke="var(--c-surface)" strokeWidth="1.8" strokeLinecap="round" />
            <circle cx="8" cy="11.4" r="1.05" fill="var(--c-surface)" />
          </svg>
        </span>
      );
    case "warning":
      return (
        <span className={`${base} text-warning`} data-step-state="warning">
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <path d="M8 1.8l6.6 11.6H1.4z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
            <path d="M8 6.2v3.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            <circle cx="8" cy="11.5" r=".9" fill="currentColor" />
          </svg>
        </span>
      );
    case "pending":
      return (
        <span className={`${base} text-muted`} data-step-state="pending">
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <circle cx="8" cy="8" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </span>
      );
  }
}

// Tabler Icons (MIT), 24 px grid, used by "About HalfCube".
export const IconFileText = outline(
  <>
    <path d="M14 3v4a1 1 0 0 0 1 1h4" />
    <path d="M17 21h-10a2 2 0 0 1-2-2v-14a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2" />
    <path d="M9 9h1M9 13h6M9 17h6" />
  </>,
  2,
);
export const IconGithub = outline(
  <path d="M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2c2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2a4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 0 0-6.2 0c-2.4-1.6-3.5-1.3-3.5-1.3a4.2 4.2 0 0 0-.1 3.2a4.6 4.6 0 0 0-1.3 3.2c0 4.6 2.7 5.7 5.5 6c-.6.6-.6 1.2-.5 2v3.5" />,
  2,
);
export const IconExternal = outline(
  <>
    <path d="M12 6h-6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" />
    <path d="M11 13l9-9" />
    <path d="M15 4h5v5" />
  </>,
  2,
);
export const IconArrowLeft = outline(<path d="M5 12h14M5 12l6 6M5 12l6-6" />, 2);
export const IconSearch = outline(
  <>
    <circle cx="10" cy="10" r="7" />
    <path d="M21 21l-6-6" />
  </>,
  2,
);

// Tabler Icons (MIT), 24 px grid, used by the update views and the category badges of "Was ist neu".
export const IconDownload = outline(
  <>
    <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    <path d="M7 11l5 5l5-5" />
    <path d="M12 4v12" />
  </>,
  2,
);
export const IconRefresh = outline(
  <>
    <path d="M20 11a8.1 8.1 0 0 0-15.5-2m-.5-4v4h4" />
    <path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4" />
  </>,
  2,
);
export const IconCircleCheck = outline(
  <>
    <path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0-18 0" />
    <path d="M9 12l2 2l4-4" />
  </>,
  2,
);
export const IconSparkles = outline(
  <path d="M16 18a2 2 0 0 1 2 2a2 2 0 0 1 2-2a2 2 0 0 1-2-2a2 2 0 0 1-2 2m0-12a2 2 0 0 1 2 2a2 2 0 0 1 2-2a2 2 0 0 1-2-2a2 2 0 0 1-2 2m-7 12a6 6 0 0 1 6-6a6 6 0 0 1-6-6a6 6 0 0 1-6 6a6 6 0 0 1 6 6" />,
  2,
);
export const IconTool = outline(<path d="M7 10h3v-3l-3.5-3.5a6 6 0 0 1 8 8l6 6a2 2 0 0 1-3 3l-6-6a6 6 0 0 1-8-8l3.5 3.5" />, 2);
export const IconLock = outline(
  <>
    <path d="M5 13a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-10a2 2 0 0 1-2-2v-6" />
    <path d="M11 16a1 1 0 1 0 2 0a1 1 0 0 0-2 0" />
    <path d="M8 11v-4a4 4 0 1 1 8 0v4" />
  </>,
  2,
);
export const IconTrash = outline(
  <>
    <path d="M4 7h16" />
    <path d="M10 11v6M14 11v6" />
    <path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12" />
    <path d="M9 7v-3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3" />
  </>,
  2,
);
export const IconAlertTriangle = outline(
  <>
    <path d="M12 9v4" />
    <path d="M10.363 3.591l-8.106 13.534a1.914 1.914 0 0 0 1.636 2.871h16.214a1.914 1.914 0 0 0 1.636-2.87l-8.106-13.536a1.914 1.914 0 0 0-3.274 0" />
    <path d="M12 16h.01" />
  </>,
  2,
);
export const IconArrowRight = outline(<path d="M5 12h14m-6 6l6-6m-6-6l6 6" />, 2);
export const IconArrowDown = outline(<path d="M12 5v14m6-6l-6 6m-6-6l6 6" />, 2);
export const IconSettings = outline(
  <>
    <path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 0 0-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 0 0-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 0 0-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 0 0-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 0 0 1.066-2.573c-.94-1.543.826-3.31 2.37-2.37c1 .608 2.296.07 2.572-1.065" />
    <path d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0-6 0" />
  </>,
  2,
);
