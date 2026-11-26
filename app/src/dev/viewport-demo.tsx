// Dev-only demo page of the 3D view (?demo=viewport[&renderer=webgl2][&planes=1][&labels=xyz][&preset=touchpad][&theme=..&mode=..]):
// grid, origin, origin planes, two bodies with face and edge ids, sketch lines of every line kind, a preview line and the
// axis navigator. The Playwright suite drives it through window.__viewportDemo.
//
// Extrude mode (&extrude=1[&distance=15]): the two sample bodies, two pickable profiles on the top face of the box (setProfiles, the pick
// kind "profile" only), the drag arrow (setExtrudeHandle) and a translucent preview body that follows the distance, which the arrow
// changes through the extrudeHandle event, the way the main window wires it. window.__viewportDemo.extrude has the test hooks.
//
// Sketch mode (&sketch=1[&scene=gallery|states|stress][&plane=xy|xz|yz][&highlight=band|fill][&colour=green|blue]): the sketch rendering
// layer with a gallery of every state (fully constrained with a hole, under- and over-constrained, construction, circles,
// dimensions, constraints), a tool preview with hints and guides, hover and selection by the pointer, and plain HTML labels
// and glyphs placed at the layer's anchors the way the main window will do it.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { i18n, useI18n } from "../i18n/runtime.ts";
import { themeStore, useTheme } from "../theme/runtime.ts";
import { themeKeys } from "../theme/themes.ts";
import { Button } from "../ui/Button.tsx";
import { createViewport, navigationPresets, styleFromTheme, type AxisKey, type EntityRef, type PlaneId, type NavigationPreset, type Viewport } from "../viewport/index.ts";
import type { AxisLabelMode } from "../viewport/navigator-model.ts";
import { ViewportView } from "../viewport/ViewportView.tsx";
import { originPlaneFrame, planeToWorld } from "../viewport/geometry.ts";
import type { ScreenAnchor, SketchFullColour, SketchHighlight, SketchHit, SketchLayer, SketchLayerOptions } from "../viewport/index.ts";
import { demoScene, extrudeSample, prismBody, type DemoScene } from "./viewport-sample.ts";
import { gallerySketch, statesSketch, stressSketch, type DemoPlane, type SketchDemo } from "./viewport-sketch-sample.ts";

export interface SketchHoverMeasurement {
  moves: number;
  curves: number;
  /** Mean and worst time of one layer.pick call, ms. */
  pickMeanMs: number;
  pickMaxMs: number;
  /** rAF-to-rAF time while the hover changes every frame. */
  frameMeanMs: number;
  frameP95Ms: number;
  frameMaxMs: number;
  /** Mean CPU time of one render call, ms. */
  cpuMeanMs: number;
  hits: number;
}

export interface FrameMeasurement {
  frames: number;
  /** rAF-to-rAF time while orbiting every frame, ms. */
  meanMs: number;
  p95Ms: number;
  maxMs: number;
  /** Mean CPU time of one render call, ms. */
  meanCpuMs: number;
}

export interface WheelMeasurement {
  notches: number;
  /** Every animation frame of the whole run, also frames the page spent on other work: rAF-to-rAF time, ms. */
  rafFrames: number;
  rafMeanMs: number;
  rafP95Ms: number;
  rafMaxMs: number;
  /** Intervals over 25 ms (a frame missed at 60 Hz by more than half a frame). */
  rafOver25: number;
  /** Frames the viewport drew during the run, and the CPU time of one draw (grid update and render call), ms. */
  drawnFrames: number;
  cpuMeanMs: number;
  cpuMaxMs: number;
  /** View distance (mm) before and after the run. */
  distanceBefore: number;
  distanceAfter: number;
}

/** Test hooks of the extrude demo (&extrude=1). */
export interface ExtrudeDemoHandle {
  /** The distance the arrow and the preview show now. */
  distance(): number;
  /** The extrudeHandle events the viewport has sent since the last clearEvents(). */
  events(): { distance: number; phase: "start" | "move" | "end" }[];
  clearEvents(): void;
  /** Client coordinates of a point on the fill of the profile (the first triangle's centre) and of the arrow's tip and middle. */
  profilePoint(regionId: string): { x: number; y: number } | null;
  handleTip(): { x: number; y: number } | null;
  handleMiddle(): { x: number; y: number } | null;
  /** Sets the distance as the dialog would: arrow and preview follow. */
  setDistance(distance: number): void;
  /** Sets a list of distances one after another, `delayMs` apart (typing speed); resolves when the last one is in. */
  typeDistances(values: readonly number[], delayMs: number): Promise<void>;
  /** Sets the sample's profiles again `times` times in a row (a host that refreshes them often). */
  reapplyProfiles(times: number): void;
  /** The profile regions of the sample. */
  regionIds: string[];
}

export interface ViewportDemoHandle {
  viewport: Viewport;
  /** Extrude mode only. */
  extrude?: ExtrudeDemoHandle;
  scene: DemoScene;
  /** Sketch mode only. */
  sketchLayer?: SketchLayer;
  sketch?: SketchDemo;
  /** Sketch mode: client coordinates of the sketch point (u, v). */
  sketchPoint?(u: number, v: number): { x: number; y: number };
  /** Sketch mode: moves the pointer over the sketch `moves` times (one move per frame) and measures picking and frames. */
  measureSketchHover?(moves: number): Promise<SketchHoverMeasurement>;
  /** Client coordinates of a point on something (face centre, edge middle, sketch entity middle, plane corner area). */
  clientPointOf(ref: EntityRef): { x: number; y: number } | null;
  /** Client coordinates of the point (u, v) on an origin plane. */
  planePoint(plane: PlaneId, u: number, v: number): { x: number; y: number } | null;
  /** Counts the "view" events a turn to an axis end causes until the view is idle again. */
  countViewEvents(axis: AxisKey, animate: boolean): Promise<number>;
  /** The eight corners of the content bounds in client coordinates. */
  contentCorners(): { x: number; y: number }[];
  /** Creates and disposes `count` extra viewports one after another; reports the canvases in the page before and after. */
  cycle(count: number): Promise<{ canvasesBefore: number; canvasesAfter: number; backend: string }>;
  /** Orbits by `dxPx` every animation frame for `frames` frames and reports the frame times. */
  measureOrbit(frames: number, dxPx: number): Promise<FrameMeasurement>;
  /**
   * Sends `notches` mouse-wheel notches (deltaY = 100 * direction, as a real wheel does) to the canvas, one every `intervalMs`,
   * with the pointer over the middle of the view, waits for the view to settle and reports the frame times of the whole run.
   * direction 1 = wheel down, -1 = wheel up.
   */
  measureWheel(notches: number, intervalMs: number, direction: 1 | -1): Promise<WheelMeasurement>;
}

declare global {
  interface Window {
    __viewportDemo?: ViewportDemoHandle;
  }
}

const refText = (ref: EntityRef | null): string => {
  if (!ref) return "none";
  switch (ref.kind) {
    case "plane": return `plane:${ref.plane}`;
    case "face": return `face:${ref.bodyId}:${ref.faceId}`;
    case "edge": return `edge:${ref.bodyId}:${ref.edgeId}`;
    case "sketch": return `sketch:${ref.sketchId}:${ref.entityId}`;
    case "profile": return `profile:${ref.sketchId}:${ref.regionId}`;
  }
};

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

export function DemoViewport() {
  const { theme, mode } = useTheme();
  const { language } = useI18n();
  const query = useMemo(() => new URLSearchParams(location.search), []);
  const renderer = query.get("renderer") === "webgl2" ? "webgl2" : "auto";
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const [preset, setPreset] = useState<NavigationPreset>(query.get("preset") === "touchpad" ? "touchpad" : "mouse");
  const [labels, setLabels] = useState<AxisLabelMode>(query.get("labels") === "xyz" ? "xyz" : "views");
  const [planes, setPlanes] = useState(query.get("planes") === "1");
  const [hidden, setHidden] = useState(false);
  const [grid, setGrid] = useState(true);
  const [previewOn, setPreviewOn] = useState(true);
  const [hoverRef, setHoverRef] = useState<EntityRef | null>(null);
  const [selection, setSelection] = useState<readonly EntityRef[]>([]);
  const [measurement, setMeasurement] = useState<FrameMeasurement | null>(null);
  const scene = useRef<DemoScene>(demoScene());
  const sketchMode = query.get("sketch") === "1";
  const extrudeMode = !sketchMode && query.get("extrude") === "1";
  const extrudeSampleRef = useRef(extrudeSample());
  const [distance, setDistance] = useState(Number(query.get("distance") ?? "15"));
  const distanceRef = useRef(distance);
  const handleEvents = useRef<{ distance: number; phase: "start" | "move" | "end" }[]>([]);
  /** &panel=0 hides the demo's own controls (for screenshots). */
  const showPanel = query.get("panel") !== "0";
  const [highlight, setHighlight] = useState<SketchHighlight>(query.get("highlight") === "fill" ? "fill" : "band");
  const [colour, setColour] = useState<SketchFullColour>(query.get("colour") === "blue" ? "blue" : "green");
  const [showDims, setShowDims] = useState(true);
  const [showCons, setShowCons] = useState(true);
  const [sketchPreview, setSketchPreview] = useState(true);
  const [skipped, setSkipped] = useState(false);
  const [sketchHover, setSketchHover] = useState<SketchHit | null>(null);
  const [sketchSelection, setSketchSelection] = useState<string[]>([]);
  const [anchors, setAnchors] = useState<{ dims: ScreenAnchor[]; cons: ScreenAnchor[] }>({ dims: [], cons: [] });
  const sketchSelectionRef = useRef<string[]>([]);
  const aligned = useRef(false);
  const sketchDemo = useMemo<SketchDemo>(() => {
    const plane = (["xy", "xz", "yz"] as const).includes(query.get("plane") as DemoPlane) ? (query.get("plane") as DemoPlane) : "xy";
    const scene = query.get("scene");
    return scene === "stress" ? stressSketch(plane) : scene === "states" ? statesSketch(plane) : gallerySketch(plane);
  }, [query]);
  const sketchOptions = useMemo<SketchLayerOptions>(() => ({ highlight, colour, showConstraints: showCons, showDimensions: showDims }), [highlight, colour, showCons, showDims]);
  const sketchView = useMemo(() => (skipped ? { ...sketchDemo.view, drag: { points: [], complete: true, profilesSkipped: true } } : sketchDemo.view), [sketchDemo, skipped]);

  useEffect(() => {
    if (!viewport) return;
    const s = scene.current;
    if (!sketchMode) {
      viewport.setBodies(s.bodies);
      viewport.setSketches(extrudeMode ? [] : s.sketches);
    }
    const offHover = viewport.on("hover", (p) => setHoverRef(p?.ref ?? null));
    const offPick = viewport.on("pick", (p, mods) => {
      const next: EntityRef[] = p ? (mods.shift ? [...viewport.getSelection(), p.ref] : [p.ref]) : [];
      viewport.setSelection(next);
      setSelection(next);
    });
    const measureOrbit = async (frames: number, dxPx: number): Promise<FrameMeasurement> => {
      viewport.resetFrameStats();
      const times: number[] = [];
      let last = 0;
      await new Promise<void>((resolve) => {
        let n = 0;
        const tick = (now: number) => {
          if (last > 0) times.push(now - last);
          last = now;
          viewport.orbitBy(dxPx, 0);
          if (++n < frames) requestAnimationFrame(tick);
          else resolve();
        };
        requestAnimationFrame(tick);
      });
      await viewport.whenIdle();
      const sorted = [...times].sort((a, b) => a - b);
      const stats = viewport.frameStats();
      return { frames: times.length, meanMs: times.reduce((a, b) => a + b, 0) / Math.max(1, times.length), p95Ms: percentile(sorted, 0.95), maxMs: sorted[sorted.length - 1] ?? 0, meanCpuMs: stats.meanCpuMs };
    };
    const clientPointOf = (ref: EntityRef): { x: number; y: number } | null => {
      let point: [number, number, number] | null = null;
      if (ref.kind === "face") {
        const body = s.bodies.find((b) => b.id === ref.bodyId);
        if (!body) return null;
        // The centre of a quad (two triangles), otherwise the centre of the middle triangle: always on the face.
        const tris: number[] = [];
        body.faceIds.forEach((f, t) => { if (f === ref.faceId) tris.push(t); });
        const use = tris.length <= 2 ? tris : [tris[Math.floor(tris.length / 2)]!];
        const sum: [number, number, number] = [0, 0, 0];
        for (const t of use) for (let k = 0; k < 3; k++) for (let c = 0; c < 3; c++) sum[c] = sum[c]! + body.positions[body.indices[t * 3 + k]! * 3 + c]! / (use.length * 3);
        point = sum;
      } else if (ref.kind === "edge") {
        const body = s.bodies.find((b) => b.id === ref.bodyId);
        const e = body?.edges;
        if (!e) return null;
        const i = e.ids.indexOf(ref.edgeId);
        const from = e.offsets[i]!, to = e.offsets[i + 1]!;
        const mid = Math.floor((from + to - 1) / 2);
        point = [e.positions[mid * 3]!, e.positions[mid * 3 + 1]!, e.positions[mid * 3 + 2]!];
        if ((to - from) % 2 === 0) {
          for (let c = 0; c < 3; c++) point[c] = (e.positions[mid * 3 + c]! + e.positions[(mid + 1) * 3 + c]!) / 2;
        }
      } else if (ref.kind === "sketch") {
        const sk = s.sketches.find((x) => x.id === ref.sketchId);
        const ent = sk?.entities.find((x) => x.id === ref.entityId);
        if (!sk || !ent) return null;
        const g = ent.geometry;
        let uv: readonly [number, number] | null = null;
        if (g.type === "line") uv = [(g.a[0] + g.b[0]) / 2, (g.a[1] + g.b[1]) / 2];
        else if (g.type === "circle") uv = [g.center[0] + g.radius, g.center[1]];
        if (!uv) return null;
        const p = sk.plane;
        point = [p.origin[0] + p.xAxis[0] * uv[0] + p.yAxis[0] * uv[1], p.origin[1] + p.xAxis[1] * uv[0] + p.yAxis[1] * uv[1], p.origin[2] + p.xAxis[2] * uv[0] + p.yAxis[2] * uv[1]];
      } else if (ref.kind === "profile") {
        return null;
      } else {
        // A point near the plane's corner on the side the start view looks from, so no other plane and nothing solid is in front.
        const far = 110;
        point = ref.plane === "xy" ? [far, -far, 0] : ref.plane === "xz" ? [far, 0, far] : [0, -far, far];
      }
      const c = viewport.worldToClient(point);
      return c ? { x: c.x, y: c.y } : null;
    };
    const cycle = async (count: number) => {
      const canvasesBefore = document.querySelectorAll("canvas").length;
      let backend = "";
      for (let i = 0; i < count; i++) {
        const host = document.createElement("div");
        host.style.width = "320px";
        host.style.height = "200px";
        document.body.appendChild(host);
        const extra = await createViewport(host, { style: styleFromTheme(themeStore.getState().theme, themeStore.getState().mode), renderer });
        extra.setBodies(s.bodies);
        extra.setSketches(s.sketches);
        backend = extra.backend.backend;
        await extra.whenIdle();
        extra.dispose();
        host.remove();
      }
      return { canvasesBefore, canvasesAfter: document.querySelectorAll("canvas").length, backend };
    };
    const countViewEvents = async (axis: AxisKey, animate: boolean): Promise<number> => {
      let n = 0;
      const off = viewport.on("view", () => { n++; });
      viewport.alignToAxis(axis, animate);
      await viewport.whenIdle();
      off();
      return n;
    };
    const contentCorners = (): { x: number; y: number }[] => {
      const b = viewport.contentBounds();
      const out: { x: number; y: number }[] = [];
      for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) {
        const c = viewport.worldToClient([x, y, z]);
        if (c) out.push({ x: c.x, y: c.y });
      }
      return out;
    };
    const planePoint = (plane: PlaneId, u: number, v: number): { x: number; y: number } | null => {
      const c = viewport.worldToClient(planeToWorld(originPlaneFrame(plane), [u, v]));
      return c ? { x: c.x, y: c.y } : null;
    };
    const layer = viewport.sketchLayer();
    const sketchPoint = (u: number, v: number): { x: number; y: number } => {
      const rect = viewport.canvas.getBoundingClientRect();
      const p = layer.toScreen(u, v);
      return { x: rect.left + p.x, y: rect.top + p.y };
    };
    const measureSketchHover = async (moves: number): Promise<SketchHoverMeasurement> => {
      const rect = viewport.canvas.getBoundingClientRect();
      viewport.resetFrameStats();
      const picks: number[] = [];
      const frames: number[] = [];
      let hits = 0;
      let last = 0;
      for (let i = 0; i < moves; i++) {
        const x = 60 + ((i * 37) % Math.max(1, rect.width - 120));
        const y = 60 + ((i * 53) % Math.max(1, rect.height - 120));
        const t0 = performance.now();
        const hit = layer.pick(x, y);
        picks.push(performance.now() - t0);
        if (hit) hits++;
        layer.setHover(hit);
        await new Promise<void>((resolve) => {
          requestAnimationFrame((now) => {
            if (last > 0) frames.push(now - last);
            last = now;
            resolve();
          });
        });
      }
      await viewport.whenIdle();
      layer.setHover(null);
      const sorted = [...frames].sort((a, b) => a - b);
      const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
      return {
        moves,
        curves: sketchDemo.view.lines.length + sketchDemo.view.circles.length,
        pickMeanMs: mean(picks),
        pickMaxMs: Math.max(...picks),
        frameMeanMs: mean(frames),
        frameP95Ms: percentile(sorted, 0.95),
        frameMaxMs: sorted[sorted.length - 1] ?? 0,
        cpuMeanMs: viewport.frameStats().meanCpuMs,
        hits,
      };
    };
    const measureWheel = async (notches: number, intervalMs: number, direction: 1 | -1): Promise<WheelMeasurement> => {
      const rect = viewport.canvas.getBoundingClientRect();
      const clientX = rect.left + rect.width / 2;
      const clientY = rect.top + rect.height * 0.62;
      await viewport.whenIdle();
      viewport.resetFrameStats();
      const distanceBefore = viewport.getView().distance;
      const times: number[] = [];
      let last = 0;
      let running = true;
      const tick = (now: number) => {
        if (last > 0) times.push(now - last);
        last = now;
        if (running) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      const renders0 = viewport.renderCount;
      for (let i = 0; i < notches; i++) {
        viewport.canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: 100 * direction, deltaMode: 0, clientX, clientY, bubbles: true, cancelable: true }));
        await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
      }
      await viewport.whenIdle();
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
      running = false;
      const sorted = [...times].sort((a, b) => a - b);
      const stats = viewport.frameStats();
      return {
        notches,
        rafFrames: times.length,
        rafMeanMs: times.reduce((a, b) => a + b, 0) / Math.max(1, times.length),
        rafP95Ms: percentile(sorted, 0.95),
        rafMaxMs: sorted[sorted.length - 1] ?? 0,
        rafOver25: times.filter((t) => t > 25).length,
        drawnFrames: viewport.renderCount - renders0,
        cpuMeanMs: stats.meanCpuMs,
        cpuMaxMs: stats.maxCpuMs,
        distanceBefore,
        distanceAfter: viewport.getView().distance,
      };
    };
    window.__viewportDemo = {
      viewport, scene: s, clientPointOf, measureOrbit, measureWheel, cycle, countViewEvents, contentCorners, planePoint,
      ...(sketchMode ? { sketchLayer: layer, sketch: sketchDemo, sketchPoint, measureSketchHover } : {}),
    };
    return () => {
      offHover();
      offPick();
      delete window.__viewportDemo;
    };
  }, [viewport, renderer, sketchMode, sketchDemo, extrudeMode]);

  // Extrude mode: the profiles, the arrow and the preview.
  useEffect(() => {
    if (!viewport || !extrudeMode) return;
    const sample = extrudeSampleRef.current;
    viewport.setProfiles(sample.profiles);
    viewport.setPickKinds(["profile"]);
    const off = viewport.on("extrudeHandle", (d, phase) => {
      handleEvents.current.push({ distance: d, phase });
      distanceRef.current = d;
      setDistance(d);
    });
    const client = (p: readonly [number, number, number]) => {
      const c = viewport.worldToClient(p);
      return c ? { x: c.x, y: c.y } : null;
    };
    const apply = (d: number) => {
      distanceRef.current = d;
      setDistance(d);
    };
    const extrude: ExtrudeDemoHandle = {
      distance: () => distanceRef.current,
      events: () => [...handleEvents.current],
      clearEvents: () => { handleEvents.current = []; },
      profilePoint: (regionId) => {
        const p = sample.profiles.find((x) => x.regionId === regionId);
        if (!p) return null;
        const t = p.triangles;
        const u = (t[0]! + t[2]! + t[4]!) / 3, v = (t[1]! + t[3]! + t[5]!) / 3;
        return client(planeToWorld(p.plane, [u, v]));
      },
      handleTip: () => client([sample.origin[0], sample.origin[1], sample.origin[2] + distanceRef.current]),
      handleMiddle: () => client([sample.origin[0], sample.origin[1], sample.origin[2] + distanceRef.current / 2]),
      setDistance: apply,
      typeDistances: async (values, delayMs) => {
        for (const v of values) {
          apply(v);
          await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        }
      },
      reapplyProfiles: (times) => { for (let i = 0; i < times; i++) viewport.setProfiles(sample.profiles); },
      regionIds: sample.profiles.map((p) => p.regionId),
    };
    if (window.__viewportDemo) window.__viewportDemo.extrude = extrude;
    return () => {
      off();
      viewport.setProfiles(null);
      viewport.setPickKinds(null);
      viewport.setExtrudeHandle(null);
      viewport.setPreview(null);
      if (window.__viewportDemo) delete window.__viewportDemo.extrude;
    };
  }, [viewport, extrudeMode]);
  useEffect(() => {
    if (!viewport || !extrudeMode) return;
    const sample = extrudeSampleRef.current;
    viewport.setExtrudeHandle({ origin: sample.origin, direction: [0, 0, 1], distance });
    // The preview is the first profile pulled by the distance (the second profile stays a plain target).
    viewport.setPreview(Math.abs(distance) > 1e-6 ? { bodies: [prismBody("preview", sample.plane, sample.profiles[0]!.triangles, 0, distance)] } : null);
  }, [viewport, extrudeMode, distance]);

  // Sketch mode: the sketch with its options, and the pointer.
  useEffect(() => {
    if (!viewport || !sketchMode) return;
    const layer = viewport.sketchLayer();
    layer.setSketch(sketchView, sketchOptions);
    if (!aligned.current) {
      aligned.current = true;
      layer.alignToSketch(false);
    }
  }, [viewport, sketchMode, sketchView, sketchOptions]);
  useEffect(() => {
    if (!viewport || !sketchMode) return;
    viewport.sketchLayer().setPreview(sketchPreview ? sketchDemo.preview : null);
  }, [viewport, sketchMode, sketchPreview, sketchDemo]);
  useEffect(() => {
    if (!viewport || !sketchMode) return;
    const layer = viewport.sketchLayer();
    const update = () => setAnchors({ dims: layer.dimensionAnchors(), cons: layer.constraintAnchors() });
    update();
    const off = layer.subscribe(update);
    const canvas = viewport.canvas;
    const local = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    let down: { x: number; y: number } | null = null;
    const onMove = (e: PointerEvent) => {
      const p = local(e);
      const hit = layer.pick(p.x, p.y);
      layer.setHover(hit);
      setSketchHover(hit);
    };
    const onDown = (e: PointerEvent) => { if (e.button === 0) down = local(e); };
    const onUp = (e: PointerEvent) => {
      const p = local(e);
      if (e.button !== 0 || !down || Math.hypot(p.x - down.x, p.y - down.y) > 4) return;
      down = null;
      const hit = layer.pick(p.x, p.y);
      const id = hit === null ? null : hit.kind === "region" ? hit.key : hit.kind === "origin" || hit.kind === "axis" ? null : hit.id;
      const next = id === null ? [] : e.shiftKey ? [...sketchSelectionRef.current, id] : [id];
      sketchSelectionRef.current = next;
      layer.setSelection(next);
      setSketchSelection(next);
    };
    const onLeave = () => { layer.setHover(null); setSketchHover(null); };
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointerleave", onLeave);
    return () => {
      off();
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointerleave", onLeave);
    };
  }, [viewport, sketchMode]);

  useEffect(() => { viewport?.setOriginPlanesVisible(planes); }, [viewport, planes]);
  useEffect(() => { viewport?.setHiddenEdgesVisible(hidden); }, [viewport, hidden]);
  useEffect(() => { viewport?.setGridVisible(grid); }, [viewport, grid]);
  useEffect(() => { if (!sketchMode && !extrudeMode) viewport?.setPreview(previewOn ? scene.current.preview : null); }, [viewport, previewOn, sketchMode, extrudeMode]);

  const reloadWith = useCallback((next: Record<string, string>) => {
    const q = new URLSearchParams(location.search);
    for (const [k, v] of Object.entries(next)) q.set(k, v);
    location.search = q.toString();
  }, []);

  return (
    <div className="relative h-full w-full bg-bg text-fg">
      <div className="absolute inset-0">
        <ViewportView className="h-full w-full" navigationPreset={preset} axisLabels={labels} renderer={renderer} onViewport={setViewport} />
      </div>
      <div className={`absolute top-3 left-3 flex max-w-[60%] flex-wrap items-center gap-1.5 rounded-card border border-line bg-surface/90 p-2${showPanel ? "" : " hidden"}`} data-testid="viewport-controls">
        {themeKeys.map((key) => (
          <Button key={key} variant={key === theme ? "primary" : "neutral"} onClick={() => themeStore.setTheme(key)}>{key}</Button>
        ))}
        <Button data-testid="vp-mode" onClick={() => themeStore.setMode(mode === "light" ? "dark" : "light")}>{mode}</Button>
        <Button onClick={() => i18n.setLanguage(language === "de" ? "en" : "de")}>{language}</Button>
        <span className="mx-1 h-5 w-px bg-line" />
        <Button data-testid="vp-fit" onClick={() => viewport?.fitAll()}>Fit all</Button>
        <Button data-testid="vp-zoom-selection" onClick={() => viewport?.zoomToSelection()}>Zoom to selection</Button>
        <Button data-testid="vp-planes" variant={planes ? "primary" : "neutral"} onClick={() => setPlanes(!planes)}>Planes</Button>
        <Button data-testid="vp-hidden" variant={hidden ? "primary" : "neutral"} onClick={() => setHidden(!hidden)}>Hidden edges</Button>
        <Button data-testid="vp-grid" variant={grid ? "primary" : "neutral"} onClick={() => setGrid(!grid)}>Grid</Button>
        <Button data-testid="vp-preview" variant={previewOn ? "primary" : "neutral"} onClick={() => setPreviewOn(!previewOn)}>Preview</Button>
        <Button data-testid="vp-preset" onClick={() => setPreset(navigationPresets[(navigationPresets.indexOf(preset) + 1) % navigationPresets.length]!)}>{preset}</Button>
        <Button data-testid="vp-labels" onClick={() => setLabels(labels === "views" ? "xyz" : "views")}>{labels}</Button>
        <Button data-testid="vp-renderer" onClick={() => reloadWith({ renderer: renderer === "webgl2" ? "auto" : "webgl2" })}>{renderer}</Button>
        {sketchMode ? (
          <>
            <span className="mx-1 h-5 w-px bg-line" />
            <Button data-testid="sk-highlight" variant={highlight === "fill" ? "primary" : "neutral"} onClick={() => setHighlight(highlight === "band" ? "fill" : "band")}>{highlight}</Button>
            <Button data-testid="sk-colour" variant={colour === "blue" ? "primary" : "neutral"} onClick={() => setColour(colour === "green" ? "blue" : "green")}>{colour}</Button>
            <Button data-testid="sk-dims" variant={showDims ? "primary" : "neutral"} onClick={() => setShowDims(!showDims)}>Dimensions</Button>
            <Button data-testid="sk-cons" variant={showCons ? "primary" : "neutral"} onClick={() => setShowCons(!showCons)}>Constraints</Button>
            <Button data-testid="sk-preview" variant={sketchPreview ? "primary" : "neutral"} onClick={() => setSketchPreview(!sketchPreview)}>Tool preview</Button>
            <Button data-testid="sk-skipped" variant={skipped ? "primary" : "neutral"} onClick={() => setSkipped(!skipped)}>Drag skips regions</Button>
            <Button data-testid="sk-align" onClick={() => viewport?.sketchLayer().alignToSketch()}>Align</Button>
          </>
        ) : null}
        <Button data-testid="vp-measure" onClick={() => { void window.__viewportDemo?.measureOrbit(120, 3).then(setMeasurement); }}>Measure orbit</Button>
      </div>
      {sketchMode ? (
        <div className="pointer-events-none absolute inset-0 overflow-hidden" data-testid="sketch-overlay">
          {anchors.dims.map((a) => {
            const d = sketchDemo.view.dimensions.find((x) => x.id === a.id);
            if (!d) return null;
            const text = d.kind === "angle" ? `${(d.measured ?? d.value.value).toFixed(1)}°` : `${d.kind === "diameter" ? "Ø " : d.kind === "radius" ? "R " : ""}${d.value.value.toFixed(2)}`;
            return (
              <div
                key={a.id}
                data-testid={`sk-dim-${a.id}`}
                className="mono absolute rounded-[3px] border px-1.5 text-[12px] leading-[20px]"
                style={{ left: a.x, top: a.y, transform: "translate(-50%, -50%)", background: "var(--c-surface)", borderColor: d.state !== "ok" ? "var(--c-sketch-over)" : "var(--c-dim-line)", color: "var(--c-dim-text)", minWidth: 56, textAlign: "center" }}
              >
                {d.driving ? text : `(${text})`}
              </div>
            );
          })}
          {anchors.cons.map((a) => {
            const id = a.id.replace(/#2$/, "");
            const c = sketchDemo.view.constraints.find((x) => x.id === id);
            if (!c) return null;
            const letter = { horizontal: "H", vertical: "V", parallel: "∥", perpendicular: "⊥", equal: "=", coincident: "●", pointOnCurve: "◎", fix: "F" }[c.kind];
            return (
              <div
                key={a.id}
                data-testid={`sk-con-${a.id}`}
                className="mono absolute grid h-[18px] w-[18px] place-items-center rounded-[3px] border text-[11px] leading-none"
                style={{ left: a.x, top: a.y, transform: "translate(-50%, -50%)", background: "var(--c-surface)", borderColor: c.state === "ok" ? "var(--c-constraint)" : "var(--c-sketch-over)", color: "var(--c-constraint)" }}
              >
                {letter}
              </div>
            );
          })}
        </div>
      ) : null}
      <div className="mono pointer-events-none absolute bottom-3 left-3 rounded-card border border-line bg-surface/90 px-2.5 py-1.5 text-[12px] leading-5 text-muted" data-testid="viewport-info">
        <div data-testid="viewport-backend" data-backend={viewport?.backend.backend ?? ""}>
          {viewport ? `${viewport.backend.backend} · MSAA ${viewport.backend.msaaSamples}x · init ${viewport.backend.initMs.toFixed(0)} ms · ${viewport.backend.adapter ?? viewport.backend.webglRenderer ?? ""}` : "starting"}
        </div>
        {sketchMode ? (
          <>
            <div data-testid="sketch-hover">sketch hover: {sketchHover === null ? "none" : `${sketchHover.kind}:${"id" in sketchHover ? sketchHover.id : "key" in sketchHover ? sketchHover.key : "axis" in sketchHover ? sketchHover.axis : ""}`}</div>
            <div data-testid="sketch-selection">sketch selection: {sketchSelection.length === 0 ? "none" : sketchSelection.join(", ")}</div>
          </>
        ) : (
          <>
            {extrudeMode ? <div data-testid="extrude-state">extrude distance: {distance.toFixed(2)} mm</div> : null}
            <div data-testid="viewport-hover">hover: {refText(hoverRef)}</div>
            <div data-testid="viewport-selection">selection: {selection.length === 0 ? "none" : selection.map(refText).join(", ")}</div>
          </>
        )}
        {measurement ? (
          <div data-testid="viewport-measurement">
            orbit {measurement.frames} frames: mean {measurement.meanMs.toFixed(1)} ms, p95 {measurement.p95Ms.toFixed(1)} ms, max {measurement.maxMs.toFixed(1)} ms, CPU {measurement.meanCpuMs.toFixed(2)} ms
          </div>
        ) : null}
      </div>
    </div>
  );
}
