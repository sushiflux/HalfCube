import { Component, type ErrorInfo, type ReactNode } from "react";
import { CrashPage } from "./CrashPage.tsx";

interface State {
  error: Error | null;
  componentStack: string | undefined;
}

function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(typeof value === "string" ? value : `Non-error value thrown: ${safeString(value)}`);
}

function safeString(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/**
 * Wraps the app root: instead of a white page, the crash page. A class component because React has no hook for this.
 * It catches render and lifecycle errors only; event handlers and async code need their own handling.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null, componentStack: undefined };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: toError(error) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    this.setState({ error: toError(error), componentStack: info.componentStack ?? undefined });
    console.error(error);
  }

  override render(): ReactNode {
    if (this.state.error) return <CrashPage error={this.state.error} componentStack={this.state.componentStack} />;
    return this.props.children;
  }
}
