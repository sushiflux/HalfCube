// Spike UI: viewport in the middle, recipe parameters and step status on the left, engine diagnostics and test
// buttons on the right, notices (errors in full, copyable) at the bottom.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import p1a from "../../recipes/p1a.json";
import spring from "../../recipes/spring.json";
import type { Recipe, StepStatus } from "../../protocol/protocol.ts";
import type { EngineSession } from "./engine-session.ts";
import { errorText, type Notice, type NoticeStore } from "./notices.ts";
import type { RecipeStore } from "./recipe-store.ts";
import { spikeHooks } from "./spike-hooks.ts";
import type { PickHit, RendererMode, Viewport } from "./viewport.ts";

interface Props {
  store: RecipeStore;
  session: EngineSession;
  notices: NoticeStore;
  rendererMode: RendererMode;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");
  return (
    <button
      className="btn small"
      onClick={async () => {
        setState((await copyText(text)) ? "ok" : "fail");
        setTimeout(() => setState("idle"), 1500);
      }}
    >
      {state === "ok" ? "Kopiert" : state === "fail" ? "Kopieren nicht möglich" : "Kopieren"}
    </button>
  );
}

function NoticePanel({ notices }: { notices: NoticeStore }) {
  const list = useSyncExternalStore(notices.subscribe, notices.snapshot);
  if (list.length === 0) return null;
  return (
    <section className="notices" aria-label="Meldungen" data-testid="notices">
      {[...list].reverse().map((n: Notice) => (
        <article key={n.id} className={`notice ${n.level}`} data-level={n.level}>
          <header>
            <strong>{n.title}</strong>
            <span className="muted">{n.time.toLocaleTimeString()}</span>
            <span className="spacer" />
            <CopyButton text={`${n.title}\n${n.text}`} />
            <button className="btn small" onClick={() => notices.dismiss(n.id)}>
              Schließen
            </button>
          </header>
          <pre>{n.text}</pre>
        </article>
      ))}
    </section>
  );
}

function ParamControl(props: { store: RecipeStore; name: string; label: string; min: number; max: number; step: number }) {
  const { store, name } = props;
  useSyncExternalStore(store.subscribe.bind(store) as never, () => store.revision);
  const value = store.current.parameters[name];
  if (value === undefined) return null;
  return (
    <label className="param">
      <span>{props.label}</span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={value}
        onChange={(e) => store.setParameter(name, Number(e.target.value))}
        data-param={name}
      />
      <input
        type="number"
        min={props.min}
        max={props.max}
        step={props.step}
        value={value}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v) && v > 0) store.setParameter(name, v);
        }}
      />
      <span className="unit">mm</span>
    </label>
  );
}

function StepList({ steps }: { steps: StepStatus[] }) {
  return (
    <ol className="steps">
      {steps.map((s) => (
        <li key={s.stepId} className={`step ${s.status}`}>
          <div className="step-head">
            <span className={`dot ${s.status}`} />
            <strong>{s.stepId}</strong>
            <span className="muted">{s.type}</span>
            <span className="spacer" />
            <span className="muted">{s.cached ? "Cache" : `${s.ms.toFixed(1)} ms`}</span>
          </div>
          {s.message && (
            <div className="step-msg">
              <pre>{s.message}</pre>
              <CopyButton text={`${s.stepId} (${s.type}): ${s.message}`} />
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}

const fmt = (v: number | null | undefined, d = 1) => (v === null || v === undefined || Number.isNaN(v) ? "–" : v.toFixed(d));

export function App({ store, session, notices, rendererMode }: Props) {
  const snap = useSyncExternalStore(session.subscribe, session.snapshot);
  useSyncExternalStore(store.subscribe.bind(store) as never, () => store.revision);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const [pick, setPick] = useState<PickHit | null>(null);
  const [edgeWidth, setEdgeWidth] = useState(1.5);

  useEffect(() => {
    let disposed = false;
    let vp: Viewport | null = null;
    // three.js is loaded on demand so it downloads while the engine starts.
    import("./viewport.ts")
      .then(({ Viewport }) => Viewport.create(canvasRef.current!, rendererMode))
      .then((v) => {
        if (disposed) return v.dispose();
        vp = v;
        v.onPick = (p) => setPick(p);
        spikeHooks.viewport = v;
        setViewport(v);
      })
      .catch((e) => notices.push("error", "Die 3D-Ansicht konnte nicht starten", errorText(e)));
    return () => {
      disposed = true;
      vp?.dispose();
    };
  }, [rendererMode, notices]);

  // Results that arrive before the view is ready are drawn once it is.
  useEffect(() => {
    if (!viewport) return;
    session.display = (result, payload) => viewport.setResult(result, payload);
    const last = session.lastResult;
    if (last) void viewport.setResult(last.result, last.payload);
    return () => {
      session.display = null;
    };
  }, [viewport, session]);

  const bi = viewport?.info;
  const hello = snap.hello;
  const isSpring = "turns" in store.current.parameters;
  const t = snap.lastTiming;

  return (
    <div className="app">
      <header className="topbar">
        <span className="title">Partcraft</span>
        <span className="muted">Architektur-Spike</span>
        <span className="spacer" />
        <span className={`badge status-${snap.status}`} data-testid="engine-status">
          Engine: {snap.kind === "native" ? "nativ (Prozess)" : "WebAssembly (Worker)"} · {snap.status}
        </span>
        <span className="badge" data-testid="backend">
          Ansicht: {bi ? bi.backend : "startet …"}
          {bi && bi.mode !== "auto" ? ` (${bi.mode === "webgl" ? "WebGL2 erzwungen" : "WebGPU ausgeblendet"})` : ""}
        </span>
      </header>

      <aside className="left">
        <h2>Rezept</h2>
        <div className="row">
          <button className="btn" disabled={!store.canUndo} onClick={() => store.undo()}>
            Rückgängig
          </button>
          <button className="btn" disabled={!store.canRedo} onClick={() => store.redo()}>
            Wiederholen
          </button>
        </div>
        <div className="row">
          <button className="btn" disabled={!isSpring} onClick={() => store.replace(p1a as Recipe, "P1a")}>
            Block P1a
          </button>
          <button className="btn" disabled={isSpring} onClick={() => store.replace(spring as Recipe, "spring")}>
            Feder
          </button>
        </div>
        {!isSpring ? (
          <>
            <ParamControl store={store} name="holeDiameter" label="Bohrung Ø" min={2} max={45} step={0.5} />
            <ParamControl store={store} name="filletRadius" label="Verrundung R" min={0.5} max={26} step={0.5} />
            <ParamControl store={store} name="length" label="Länge" min={50} max={160} step={1} />
          </>
        ) : (
          <>
            <ParamControl store={store} name="turns" label="Windungen" min={1} max={20} step={1} />
            <ParamControl store={store} name="wireDiameter" label="Draht Ø" min={0.5} max={4} step={0.1} />
          </>
        )}
        <h2>Schritte</h2>
        <StepList steps={snap.steps} />
      </aside>

      <main className="view">
        <canvas ref={canvasRef} data-testid="viewport" />
        <div className="overlay">
          {pick ? (
            <div data-testid="pick">
              <strong>Fläche {pick.face.faceId}</strong> · {pick.face.surface} · aus Schritt „{pick.face.originStep}“ ·{" "}
              {pick.face.triangleCount} Dreiecke · Treffer-Dreieck {pick.triangle} · Raycast {fmt(pick.raycastMs, 2)} ms
            </div>
          ) : (
            <div className="muted">Fläche anklicken, um sie auszuwählen. Ziehen dreht die Ansicht.</div>
          )}
        </div>
      </main>

      <aside className="right">
        <h2>Engine</h2>
        <dl>
          <dt>Kern</dt>
          <dd>{hello ? `${hello.engine.kernel} · ${hello.engine.platform}` : "–"}</dd>
          <dt>Start + Hallo</dt>
          <dd>{fmt(snap.startMs)} ms{snap.instantiateMs !== null ? ` (WASM laden ${fmt(snap.instantiateMs)} ms)` : ""}</dd>
          <dt>Abbruch laufend</dt>
          <dd>{hello?.capabilities.cancelWhileBusy ? "ja" : "nein"}{snap.kind === "wasm" && !snap.sharedCancel ? " (ohne COOP/COEP)" : ""}</dd>
          <dt>Angezeigte Version</dt>
          <dd data-testid="displayed-version">{snap.displayedVersion}</dd>
          <dt>Veraltet verworfen</dt>
          <dd>{snap.staleDiscarded} · überholt {snap.supersededIgnored}</dd>
          <dt>Abstürze</dt>
          <dd>
            {snap.crashes}
            {snap.lastRecoveryMs !== null ? ` · zuletzt erholt in ${fmt(snap.lastRecoveryMs)} ms` : ""}
          </dd>
        </dl>
        <h2>Letzter Neuaufbau</h2>
        <dl>
          <dt>Befehl</dt>
          <dd>{t ? `${t.command} v${t.recipeVersion}` : "–"}</dd>
          <dt>Hin und zurück</dt>
          <dd>{fmt(t?.roundTripMs, 2)} ms</dd>
          <dt>Engine gesamt</dt>
          <dd>
            {fmt(t?.engineTotalMs, 2)} ms (Bau {fmt(t?.engineRebuildMs, 2)}, Netz {fmt(t?.engineMeshMs, 2)}, Kodieren{" "}
            {fmt(t?.engineEncodeMs, 2)})
          </dd>
          <dt>Transport</dt>
          <dd>
            {fmt(t?.transportMs, 2)} ms für {t ? (t.payloadBytes / 1024).toFixed(0) : "–"} KiB
            {t?.hopMs !== undefined ? ` (Haupt→UI ${fmt(t.hopMs, 2)} ms)` : ""}
          </dd>
          <dt>Bis Bild</dt>
          <dd>{fmt(t?.toFrameMs, 2)} ms</dd>
          <dt>Dreiecke</dt>
          <dd>{snap.result ? snap.result.bodies.reduce((s, b) => s + b.mesh.triangleCount, 0) : "–"}</dd>
        </dl>
        <h2>Ansicht</h2>
        <dl>
          <dt>Backend</dt>
          <dd data-testid="backend-detail">{bi ? `${bi.backend} (Init ${fmt(bi.initMs)} ms)` : "–"}</dd>
          <dt>Adapter</dt>
          <dd>
            {bi?.adapter
              ? `${bi.adapter.vendor} · ${bi.adapter.architecture}${bi.adapter.description ? " · " + bi.adapter.description : ""}`
              : bi?.webglRenderer ?? bi?.adapterError ?? "–"}
          </dd>
        </dl>
        <label className="param">
          <span>Kantenbreite</span>
          <input
            type="range"
            min={0.5}
            max={5}
            step={0.5}
            value={edgeWidth}
            onChange={(e) => {
              const v = Number(e.target.value);
              setEdgeWidth(v);
              viewport?.setEdgeWidth(v);
            }}
          />
          <span className="unit">{edgeWidth} px</span>
        </label>
        <div className="row wrap">
          {(["auto", "webgl", "nogpu"] as const).map((m) => (
            <a
              key={m}
              className={`btn small${m === rendererMode ? " active" : ""}`}
              href={`?${new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(location.search)), renderer: m })}`}
            >
              {m === "auto" ? "WebGPU (auto)" : m === "webgl" ? "WebGL2 erzwingen" : "Ohne WebGPU"}
            </a>
          ))}
        </div>
        <h2>Absturz-Test</h2>
        <div className="row wrap">
          <button className="btn danger" onClick={() => session.crash("abort")} data-crash="abort">
            abort
          </button>
          <button className="btn danger" onClick={() => session.crash("nullcall")} data-crash="nullcall">
            Nullzeiger-Aufruf
          </button>
          <button className="btn danger" onClick={() => session.crash("intdiv")} data-crash="intdiv">
            Division durch 0
          </button>
          {snap.kind === "native" && (
            <button className="btn danger" onClick={() => session.simulateHang()}>
              Hänger simulieren
            </button>
          )}
          {snap.status === "failed" && (
            <button className="btn" onClick={() => void session.restart()}>
              Engine neu starten
            </button>
          )}
        </div>
      </aside>

      <footer className="bottom">
        <NoticePanel notices={notices} />
      </footer>
    </div>
  );
}
