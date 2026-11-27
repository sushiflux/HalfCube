// One row of the settings dialog: the name on the left, the control (and its help text) on the right.
import type { ReactNode } from "react";

export function Row({ label, children, testId }: { label: string; children: ReactNode; testId: string }) {
  return (
    <div className="grid grid-cols-[minmax(0,200px)_1fr] items-start gap-x-4 gap-y-1 border-b border-line py-3 last:border-b-0 max-[640px]:grid-cols-1" data-testid={testId}>
      <div className="pt-2 text-[13.5px] font-medium">{label}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
