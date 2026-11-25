import { useT } from "../i18n/runtime.ts";
import { Button, type ButtonVariant } from "./Button.tsx";
import { useCopy } from "./clipboard.ts";
import { cx } from "./cx.ts";
import { IconAlert, IconCheck, IconCopy } from "./icons.tsx";

/**
 * "Copy" button with a short "Copied" confirmation. All three labels take room in the same grid cell, so the
 * confirmation never changes the width and nothing moves.
 */
export function CopyButton({
  getText,
  variant = "neutral",
  className,
}: {
  getText: () => string;
  variant?: ButtonVariant;
  className?: string;
}) {
  const t = useT();
  const { state, copy } = useCopy(getText);
  const labels = [
    { id: "idle", icon: <IconCopy />, text: t("common.copy") },
    { id: "copied", icon: <IconCheck />, text: t("common.copied") },
    { id: "failed", icon: <IconAlert />, text: t("common.copyFailed") },
  ] as const;
  return (
    <>
      <Button variant={variant} onClick={copy} className={className} data-copy-state={state}>
        <span className="inline-grid">
          {labels.map((label) => (
            <span
              key={label.id}
              className={cx("col-start-1 row-start-1 inline-flex items-center gap-2", state !== label.id && "invisible")}
              aria-hidden={state !== label.id}
            >
              <span className="inline-flex text-base">{label.icon}</span>
              {label.text}
            </span>
          ))}
        </span>
      </Button>
      <span className="sr-only" role="status">
        {state === "copied" ? t("common.copied") : state === "failed" ? t("common.copyFailed") : ""}
      </span>
    </>
  );
}
