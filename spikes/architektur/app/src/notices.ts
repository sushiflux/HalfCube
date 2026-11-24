// Messages for the user (errors, crash reports, recovery notes). Shown in full in the notice panel, never
// truncated, each with a Copy button; never through browser dialogs.
export type NoticeLevel = "error" | "warning" | "info";

export interface Notice {
  id: number;
  level: NoticeLevel;
  title: string;
  /** Complete text, copied as is. */
  text: string;
  time: Date;
}

export class NoticeStore {
  list: Notice[] = [];
  private nextId = 1;
  private listeners = new Set<() => void>();

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  snapshot = () => this.list;

  push(level: NoticeLevel, title: string, text: string): Notice {
    const n: Notice = { id: this.nextId++, level, title, text, time: new Date() };
    this.list = [...this.list, n];
    this.emit();
    return n;
  }

  dismiss(id: number) {
    this.list = this.list.filter((n) => n.id !== id);
    this.emit();
  }

  private emit() {
    for (const l of [...this.listeners]) l();
  }
}

/** Text of an error for the panel and the clipboard: name, message, cause chain. */
export function errorText(e: unknown): string {
  if (e instanceof Error) {
    let s = `${e.name}: ${e.message}`;
    if (e.cause !== undefined) s += `\nCause: ${errorText(e.cause)}`;
    return s;
  }
  return String(e);
}
