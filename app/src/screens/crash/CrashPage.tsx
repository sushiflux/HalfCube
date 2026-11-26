import { useMemo, useState } from "react";
import { devParams } from "../../dev/params.ts";
import { copyText } from "../../ui/clipboard.ts";
import { currentVersion } from "../../version.ts";
import "./crash.css";
import { CrashScroll } from "./CrashScroll.tsx";
import {
  buildCrashReport,
  collectEnvironment,
  parseComponentStack,
  parseStack,
  shortLocation,
  throwingFunction,
  type CrashReport,
} from "./diagnostics.ts";

/**
 * The crash page. Always English, whatever the UI language, and independent of the app's translation, theme tokens and
 * components: it has to work when those are what broke. Dev build: the full diagnostic console (fixed dark). Every
 * other channel: a calm page with a concrete message, expandable technical details and a reload button. Both have the
 * copy button with the complete text.
 */
export interface CrashPageProps {
  error: Error;
  componentStack?: string | undefined;
}

function readVersion(): { display: string; channel: string } {
  try {
    const v = currentVersion();
    return { display: v.display, channel: v.channel };
  } catch {
    return { display: "unknown", channel: "unknown" };
  }
}

function useReport(error: Error, componentStack: string | undefined): { report: CrashReport; text: string; channel: string } {
  return useMemo(() => {
    const version = readVersion();
    const report: CrashReport = {
      name: error.name || "Error",
      message: error.message || "(no message)",
      stack: error.stack,
      componentStack,
      environment: collectEnvironment(version.display, version.channel),
    };
    return { report, text: buildCrashReport(report), channel: version.channel };
  }, [error, componentStack]);
}

type CopyState = "idle" | "copied" | "failed";

function CopyReport({ text }: { text: string }) {
  const [state, setState] = useState<CopyState>("idle");
  const labels: readonly { id: CopyState; text: string }[] = [
    { id: "idle", text: "Copy details" },
    { id: "copied", text: "Copied" },
    { id: "failed", text: "Not copied" },
  ];
  return (
    <>
      <button
        type="button"
        className="pcc-btn"
        onClick={() => {
          void copyText(text).then((ok) => {
            setState(ok ? "copied" : "failed");
            window.setTimeout(() => setState("idle"), 1600);
          });
        }}
      >
        <span className="pcc-copy">
          {labels.map((label) => (
            <span key={label.id} data-hidden={state === label.id ? "false" : "true"} aria-hidden={state !== label.id}>
              {label.text}
            </span>
          ))}
        </span>
      </button>
      <span role="status" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
        {state === "copied" ? "Copied" : state === "failed" ? "Not copied" : ""}
      </span>
    </>
  );
}

const chevron = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 6l6 6-6 6" />
  </svg>
);

/** Calm page for nightly, beta and release builds. */
function CalmCrashPage({ report, text }: { report: CrashReport; text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <CrashScroll className="pcc pcc-calm" testId="crash-page">
      <div className="pcc-wrap">
        <p className="pcc-kicker">Unexpected error</p>
        <h1>Something went wrong</h1>
        <p className="pcc-lead">
          HalfCube hit a problem it could not recover from and had to stop showing this screen. Reloading usually
          helps. If it happens again, copy the details and add them to your report on GitHub.
        </p>
        <p className="pcc-message">
          {report.name}: {report.message}
        </p>
        <div className="pcc-actions">
          <button type="button" className="pcc-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {chevron}
            <span className="pcc-copy">
              <span data-hidden={open ? "true" : "false"}>Show technical details</span>
              <span data-hidden={open ? "false" : "true"}>Hide technical details</span>
            </span>
          </button>
          <CopyReport text={text} />
          <button type="button" className="pcc-btn pcc-btn-primary" onClick={() => location.reload()}>
            Reload
          </button>
        </div>
        {open ? (
          <div className="pcc-details">
            <h2>Technical details</h2>
            <pre>{text}</pre>
          </div>
        ) : null}
      </div>
    </CrashScroll>
  );
}

type Tab = "frames" | "components" | "environment" | "raw";

/** The diagnostic console of the dev build: the more information, the better. */
function DevCrashConsole({ report, text }: { report: CrashReport; text: string }) {
  const frames = useMemo(() => parseStack(report.stack), [report.stack]);
  const components = useMemo(() => parseComponentStack(report.componentStack), [report.componentStack]);
  const [tab, setTab] = useState<Tab>("frames");
  const [selected, setSelected] = useState(0);
  const thrower = throwingFunction(frames);
  const frame = frames[selected];
  const env = report.environment;

  const tabs: readonly { id: Tab; label: string }[] = [
    { id: "frames", label: `Stack frames (${frames.length})` },
    { id: "components", label: `Component stack (${components.length})` },
    { id: "environment", label: "Environment" },
    { id: "raw", label: "Raw report" },
  ];

  return (
    <CrashScroll className="pcc pcc-dev" testId="crash-console">
      <div className="pcc-wrap">
        <p className="pcc-kicker">Uncaught render error · dev build {env.version}</p>
        <h1>
          {report.name}: {report.message}
        </h1>
        <p className="pcc-where">
          Thrown in <b>{thrower ?? "unknown function"}</b>
          {frame ? <> at {shortLocation(frames[0] ?? frame)}</> : null}
        </p>
        <div className="pcc-actions">
          <button type="button" className="pcc-btn pcc-btn-primary" onClick={() => location.reload()}>
            Reload
          </button>
          <CopyReport text={text} />
        </div>

        <div className="pcc-tabs" role="tablist" aria-label="Crash details">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              className="pcc-tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="pcc-panel" role="tabpanel">
          {tab === "frames" ? (
            frames.length === 0 ? (
              <p className="pcc-lead">The error has no parsable stack. See the raw report.</p>
            ) : (
              <div className="pcc-frames">
                <ul className="pcc-framelist">
                  {frames.map((f, index) => (
                    <li key={index}>
                      <button
                        type="button"
                        className="pcc-frame"
                        aria-current={index === selected}
                        onClick={() => setSelected(index)}
                      >
                        {f.isAsync ? "async " : ""}
                        {f.functionName ?? "(anonymous)"}
                        <small>{shortLocation(f)}</small>
                      </button>
                    </li>
                  ))}
                </ul>
                {frame ? (
                  <dl className="pcc-frame-detail pcc-kv">
                    <dt>Function</dt>
                    <dd>{frame.functionName ?? "(anonymous)"}</dd>
                    <dt>File</dt>
                    <dd>{frame.file ?? "-"}</dd>
                    <dt>Line</dt>
                    <dd>{frame.line ?? "-"}</dd>
                    <dt>Column</dt>
                    <dd>{frame.column ?? "-"}</dd>
                    <dt>Async</dt>
                    <dd>{frame.isAsync ? "yes" : "no"}</dd>
                    <dt>Raw</dt>
                    <dd>{frame.raw}</dd>
                  </dl>
                ) : null}
              </div>
            )
          ) : null}

          {tab === "components" ? (
            components.length === 0 ? (
              <p className="pcc-lead">No component stack was reported.</p>
            ) : (
              <ol className="pcc-list">
                {components.map((name, index) => (
                  <li key={index}>&lt;{name}&gt;</li>
                ))}
              </ol>
            )
          ) : null}

          {tab === "environment" ? (
            <dl className="pcc-frame-detail pcc-kv" style={{ position: "static" }}>
              <dt>Version</dt>
              <dd>{env.version}</dd>
              <dt>Channel</dt>
              <dd>{env.channel}</dd>
              <dt>Time</dt>
              <dd>{env.time}</dd>
              <dt>URL</dt>
              <dd>{env.url}</dd>
              <dt>Viewport</dt>
              <dd>{env.viewport}</dd>
              <dt>Platform</dt>
              <dd>{env.platform}</dd>
              <dt>Languages</dt>
              <dd>{env.language}</dd>
              <dt>User agent</dt>
              <dd>{env.userAgent}</dd>
            </dl>
          ) : null}

          {tab === "raw" ? (
            <div className="pcc-details">
              <pre>{text}</pre>
            </div>
          ) : null}
        </div>
      </div>
    </CrashScroll>
  );
}

export function CrashPage({ error, componentStack }: CrashPageProps) {
  const { report, text, channel } = useReport(error, componentStack);
  return channel === "dev" && !devParams().calm ? <DevCrashConsole report={report} text={text} /> : <CalmCrashPage report={report} text={text} />;
}
