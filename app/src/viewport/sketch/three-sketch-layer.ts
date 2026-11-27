// The sketch rendering layer (U2a): draws the solved sketch of the model (curves by solver state, points, origin and plane
// axes, dimension graphics, the highlight of determined regions), hover and selection, and a tool's preview, and answers
// where things are on the screen (picking, anchors for the HTML overlays). Lines go through the same LineLayer as the rest
// of the view, with dash lengths in pixels from uniforms, never from a texture (so dashes keep their screen size at every zoom).
//
// Work is split by what changes it. A new sketch (or a drag step) replaces the curve geometry in place. A zoom changes
// everything that is sized in pixels (arrowheads, the band, hints, the axes' reach): that part is rebuilt when the scale
// changes and is cheap. Hover and selection rebuild only their small highlight, so moving the pointer over a sketch of
// hundreds of curves costs a few small buffers per change and nothing else.
import type * as THREE from "three/webgpu";
import type { SketchView } from "../../model/editors.ts";
import { cameraBasis, pixelsPerWorld, type Lens, type ViewState } from "../camera.ts";
import { buildSegments, type Polyline } from "../geometry.ts";
import { emptyBounds, expandBounds, type Bounds, type Vec3 } from "../math.ts";
import type { LineKind, LineStyle, ViewportStyle } from "../style.ts";
import { LineLayer } from "../three-lines.ts";
import { constraintAnchors as placeConstraintAnchors, dimensionAnchors as placeDimensionAnchors } from "./anchors.ts";
import { BAND_WIDTH_PX, bandOfLoops, determinedLoops } from "./band.ts";
import { BAND_OPACITY, linearAlpha } from "./band-colour.ts";
import { arrowTriangle, dimensionGraphic, dimensionGraphics, liveDimensionGraphic, type DimensionGraphic, type Seg } from "./dimensions.ts";
import { focusedView, frameOfView, framesEqual, fittedViewOnto, makeProjector, sketchToWorld, type Frame3, type SketchProjector } from "./frame.ts";
import { pickSketch } from "./pick.ts";
import { hintSegments, previewPolylines } from "./preview.ts";
import { mergeMeshes, ribbonOfPolyline, type RibbonMesh } from "./ribbon.ts";
import { buildScene, curveKinds, curvePolyline, curveSegments, emptyScene, fullColour, sketchExtent, type CurveSegments, type SketchScene, type UV } from "./scene.ts";
import { DiscSet } from "./three-discs.ts";
import { FlatMesh } from "./three-flat.ts";
import { filledProfiles, PROFILE_FILL_OPACITY, ProfileFill } from "./three-profile-fill.ts"; // profile fill
import type { LiveTone, ScreenAnchor, SketchHit, SketchLayer, SketchLayerOptions, SketchPreview } from "./types.ts";

/** What the layer needs from the viewport that owns it. */
export interface SketchHost {
  readonly group: THREE.Group;
  getView(): ViewState;
  getLens(): Lens;
  getStyle(): ViewportStyle;
  requestRender(): void;
  moveTo(view: ViewState, animate: boolean): void;
  /** The grid lies in the sketch plane while a sketch is shown (null: back to the XY plane). */
  setGridFrame(frame: Frame3 | null): void;
}

// Render order: the grid is at 10 to 12, body edges below 20.
const ORDER = { fill: 18, band: 19, regionHighlight: 19, halo: 20, axes: 21, curves: 22, dimensions: 23, points: 24, origin: 25, preview: 26 } as const;

/** Width of the translucent band on a hovered or selected line, CSS pixels. */
export const HALO_WIDTH_PX = 7;
export const HALO_OPACITY = 0.4;
export { BAND_OPACITY };
const POINT_RADIUS_PX = 4.6;
const POINT_STROKE_PX = 1.8;
const POINT_HALO_RADIUS_PX = 9;
const ORIGIN_CROSS_PX = 8;

const DEFAULT_OPTIONS: SketchLayerOptions = { highlight: "band", colour: "green", showConstraints: true, showDimensions: true };

const empty = (): Bounds => emptyBounds();

/** The world axis a sketch axis points along most (its line takes that axis' colour: X red, Y green, Z blue). */
export function axisKindOf(direction: Vec3): "axisX" | "axisY" | "axisZ" {
  const a = [Math.abs(direction[0]), Math.abs(direction[1]), Math.abs(direction[2])];
  return a[0]! >= a[1]! && a[0]! >= a[2]! ? "axisX" : a[1]! >= a[2]! ? "axisY" : "axisZ";
}

function toLayerGeometry(frame: Frame3, polylines: readonly (readonly UV[])[]) {
  const lines: Polyline[] = polylines.map((pl, i) => ({ owner: i, points: pl.map((p) => sketchToWorld(frame, p[0], p[1])) }));
  const b = buildSegments(lines);
  return { positions: b.positions, distanceStart: b.distanceStart, distanceEnd: b.distanceEnd };
}

const segPolylines = (segs: readonly Seg[]): UV[][] => segs.map((s) => [s[0], s[1]]);

export class ThreeSketchLayer implements SketchLayer {
  private view: SketchView | null = null;
  private options: SketchLayerOptions = DEFAULT_OPTIONS;
  private scene: SketchScene = emptyScene();
  private frame: Frame3 | null = null;
  private curveSegs: CurveSegments[] = [];
  private graphics: DimensionGraphic[] = [];
  /** The live dimensions of the shape being drawn, with the graphics they got at the current scale. */
  private liveGraphics: { tone: LiveTone; graphic: DimensionGraphic }[] = [];
  private selection = new Set<string>();
  private hover: SketchHit | null = null;
  private preview: SketchPreview | null = null;
  private contentVersion = 0;
  private scaleKey = "";
  private projectorMemo: { key: string; projector: SketchProjector } | null = null;
  private axisReach = 1;
  private listeners = new Set<() => void>();
  private notifyPending = false;
  private disposed = false;
  private highlightDirty = false;

  private readonly curveLayers = new Map<LineKind, LineLayer>();
  private readonly axisU = LineLayer.empty({ renderOrder: ORDER.axes, polygonOffset: true });
  private readonly axisV = LineLayer.empty({ renderOrder: ORDER.axes, polygonOffset: true });
  private readonly originCross = LineLayer.empty({ renderOrder: ORDER.origin, polygonOffset: true });
  private readonly dimLines = LineLayer.empty({ renderOrder: ORDER.dimensions, polygonOffset: true });
  private readonly dimProblemLines = LineLayer.empty({ renderOrder: ORDER.dimensions, polygonOffset: true });
  private readonly dimArrows = new FlatMesh({ renderOrder: ORDER.dimensions });
  private readonly dimProblemArrows = new FlatMesh({ renderOrder: ORDER.dimensions });
  private readonly band = new FlatMesh({ renderOrder: ORDER.band, opacity: BAND_OPACITY });
  private readonly fill = new ProfileFill(); // profile fill
  private readonly regionSelected = new FlatMesh({ renderOrder: ORDER.regionHighlight });
  private readonly regionHover = new FlatMesh({ renderOrder: ORDER.regionHighlight });
  private readonly haloSelected = new FlatMesh({ renderOrder: ORDER.halo, opacity: HALO_OPACITY });
  private readonly haloHover = new FlatMesh({ renderOrder: ORDER.halo, opacity: HALO_OPACITY });
  private readonly pointHalos = new DiscSet({ renderOrder: ORDER.halo, opacity: HALO_OPACITY });
  private readonly pointDiscs = new DiscSet({ renderOrder: ORDER.points });
  private readonly pointRings = new DiscSet({ renderOrder: ORDER.points + 0.5, ringInner: (POINT_RADIUS_PX + POINT_STROKE_PX / 2 - POINT_STROKE_PX) / (POINT_RADIUS_PX + POINT_STROKE_PX / 2) });
  private readonly previewSolid = LineLayer.empty({ renderOrder: ORDER.preview, polygonOffset: true }, true);
  private readonly previewConstruction = LineLayer.empty({ renderOrder: ORDER.preview, polygonOffset: true }, true);
  private readonly previewGuides = LineLayer.empty({ renderOrder: ORDER.preview, polygonOffset: true }, true);
  private readonly previewHints = LineLayer.empty({ renderOrder: ORDER.preview, polygonOffset: true });
  private readonly previewPoints = new DiscSet({ renderOrder: ORDER.preview });
  /** The arrowheads of the dimension that is being placed (its lines go with the solid preview lines). */
  private readonly previewArrows = new FlatMesh({ renderOrder: ORDER.preview });
  /** The lines and arrowheads of the live dimensions, one set per tone (active, quiet, invalid). */
  private readonly liveLines: Record<LiveTone, LineLayer> = {
    active: LineLayer.empty({ renderOrder: ORDER.preview, polygonOffset: true }),
    quiet: LineLayer.empty({ renderOrder: ORDER.preview, polygonOffset: true }),
    invalid: LineLayer.empty({ renderOrder: ORDER.preview, polygonOffset: true }),
  };
  private readonly liveArrows: Record<LiveTone, FlatMesh> = {
    active: new FlatMesh({ renderOrder: ORDER.preview }),
    quiet: new FlatMesh({ renderOrder: ORDER.preview }),
    invalid: new FlatMesh({ renderOrder: ORDER.preview }),
  };
  private readonly dashLayers: LineLayer[];
  private readonly lineLayers: LineLayer[];

  private readonly host: SketchHost;

  constructor(host: SketchHost) {
    this.host = host;
    for (const kind of curveKinds) this.curveLayers.set(kind, LineLayer.empty({ renderOrder: ORDER.curves, polygonOffset: true }, true));
    this.dashLayers = [...this.curveLayers.values(), this.previewSolid, this.previewConstruction, this.previewGuides];
    this.lineLayers = [
      ...this.curveLayers.values(), this.axisU, this.axisV, this.originCross, this.dimLines, this.dimProblemLines,
      this.previewSolid, this.previewConstruction, this.previewGuides, this.previewHints, ...Object.values(this.liveLines),
    ];
    const g = host.group;
    for (const l of this.lineLayers) g.add(l.group);
    for (const m of [this.dimArrows, this.dimProblemArrows, this.previewArrows, ...Object.values(this.liveArrows), this.band, this.fill, this.regionSelected, this.regionHover, this.haloSelected, this.haloHover]) g.add(m.mesh);
    for (const d of [this.pointHalos, this.pointDiscs, this.pointRings, this.previewPoints]) g.add(d.group);
    this.applyStyles();
  }

  // --- the SketchLayer interface --------------------------------------------------------------------------------------

  setSketch(view: SketchView | null, options: SketchLayerOptions): void {
    this.options = options;
    this.view = view;
    this.contentVersion++;
    this.scaleKey = "";
    if (!view) {
      this.frame = null;
      this.scene = emptyScene();
      this.curveSegs = [];
      this.graphics = [];
      for (const l of this.curveLayers.values()) l.replaceGeometry({ positions: new Float32Array(0) });
      for (const l of [this.axisU, this.axisV, this.originCross, this.dimLines, this.dimProblemLines, ...Object.values(this.liveLines)]) l.replaceGeometry({ positions: new Float32Array(0) });
      this.liveGraphics = [];
      for (const m of [this.dimArrows, this.dimProblemArrows, this.previewArrows, ...Object.values(this.liveArrows), this.band, this.regionSelected, this.regionHover, this.haloSelected, this.haloHover]) m.clear();
      this.fill.clear();
      for (const d of [this.pointHalos, this.pointDiscs, this.pointRings]) d.set([]);
      this.host.setGridFrame(null);
    } else {
      const frame = frameOfView(view);
      if (!framesEqual(this.frame, frame)) this.host.setGridFrame(frame);
      this.frame = frame;
      this.scene = buildScene(view);
      this.curveSegs = curveSegments(frame, this.scene);
      this.applyStyles();
      this.updateCurveLayers(frame);
      this.updatePointItems();
      this.updateFill(view, frame); // profile fill
    }
    this.notifyPending = true;
    this.host.requestRender();
  }

  setPreview(preview: SketchPreview | null): void {
    this.preview = preview;
    this.scaleKey = "";
    this.notifyPending = true;
    this.host.requestRender();
  }

  setHover(hit: SketchHit | null): void {
    if (hitKey(this.hover) === hitKey(hit)) return;
    this.hover = hit;
    this.highlightDirty = true;
    this.host.requestRender();
  }

  setSelection(ids: string[]): void {
    const next = new Set(ids);
    if (next.size === this.selection.size && ids.every((i) => this.selection.has(i))) return;
    this.selection = next;
    this.highlightDirty = true;
    this.host.requestRender();
  }

  pick(x: number, y: number, tolerancePx?: number): SketchHit | null {
    const proj = this.ensureScale();
    if (!this.view || !proj) return null;
    return pickSketch({ scene: this.scene, dimensions: this.graphics, profiles: this.view.drag?.profilesSkipped ? [] : this.view.profiles, projector: proj }, x, y, tolerancePx);
  }

  toSketch(x: number, y: number): { u: number; v: number } | null {
    const proj = this.projector();
    return proj ? proj.toSketch(x, y) : null;
  }

  toScreen(u: number, v: number): { x: number; y: number } {
    const proj = this.projector();
    return proj?.toScreen(u, v) ?? { x: Number.NaN, y: Number.NaN };
  }

  pxPerMm(): number {
    return this.projector()?.pxPerMm ?? pixelsPerWorld(this.host.getLens(), this.host.getView().distance);
  }

  dimensionAnchors(): ScreenAnchor[] {
    const proj = this.ensureScale();
    return proj ? placeDimensionAnchors(this.graphics, proj) : [];
  }

  liveAnchors(): ScreenAnchor[] {
    const proj = this.ensureScale();
    return proj ? placeDimensionAnchors(this.liveGraphics.map((l) => l.graphic), proj) : [];
  }

  constraintAnchors(): ScreenAnchor[] {
    const proj = this.ensureScale();
    if (!proj || !this.view || !this.options.showConstraints) return [];
    const lens = this.host.getLens();
    return placeConstraintAnchors(this.view.constraints, this.scene, this.graphics, proj, { width: lens.width, height: lens.height });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  alignToSketch(animate = true): void {
    if (!this.frame) return;
    const frame = this.frame;
    const extent = sketchExtent(this.scene);
    let bounds: Bounds | null = null;
    if (extent) {
      let b = empty();
      for (const u of [extent.min[0], extent.max[0]]) for (const v of [extent.min[1], extent.max[1]]) b = expandBounds(b, sketchToWorld(frame, u, v));
      bounds = b;
    }
    this.host.moveTo(fittedViewOnto(frame, this.host.getView(), this.host.getLens(), bounds), animate);
  }

  focusOn(ids: readonly string[], animate = true): boolean {
    const frame = this.frame;
    if (!frame) return false;
    let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
    const take = (u: number, v: number) => {
      minU = Math.min(minU, u); maxU = Math.max(maxU, u);
      minV = Math.min(minV, v); maxV = Math.max(maxV, v);
    };
    for (const id of ids) {
      const curve = this.scene.curveById.get(id);
      if (curve?.type === "line") { take(curve.a[0], curve.a[1]); take(curve.b[0], curve.b[1]); continue; }
      if (curve?.type === "circle") { take(curve.c[0] - curve.r, curve.c[1] - curve.r); take(curve.c[0] + curve.r, curve.c[1] + curve.r); continue; }
      const point = this.scene.pointById.get(id);
      if (point) take(point.u, point.v);
    }
    if (!Number.isFinite(minU)) return false;
    let b = empty();
    for (const u of [minU, maxU]) for (const v of [minV, maxV]) b = expandBounds(b, sketchToWorld(frame, u, v));
    this.host.moveTo(focusedView(this.host.getView(), this.host.getLens(), b), animate);
    return true;
  }

  // --- called by the viewport ---------------------------------------------------------------------------------------------

  /** World bounds of the sketch's own content, for fit-all. */
  bounds(): Bounds {
    const extent = sketchExtent(this.scene);
    if (!this.frame || !extent) return empty();
    let b = empty();
    for (const u of [extent.min[0], extent.max[0]]) for (const v of [extent.min[1], extent.max[1]]) b = expandBounds(b, sketchToWorld(this.frame, u, v));
    return b;
  }

  /** The camera or the size of the view changed: overlays have to follow. */
  cameraChanged(): void {
    this.notifyPending = true;
  }

  styleChanged(): void {
    this.applyStyles();
    // Points carry their colours with them (the hollow ones the colour of the view).
    if (this.view) this.updatePointItems();
    this.scaleKey = "";
    this.updateFillColour();
    this.highlightDirty = true;
  }

  /** Before every frame: sizes in pixels, dash scales, highlights, and the notice to the subscribers. */
  beforeRender(): void {
    if (this.disposed) return;
    const proj = this.ensureScale();
    if (this.highlightDirty && proj) this.rebuildHighlights(proj);
    const lens = this.host.getLens(), view = this.host.getView();
    if (this.frame) {
      for (const d of [this.pointHalos, this.pointDiscs, this.pointRings, this.previewPoints]) d.update(this.frame, view, lens);
      const basis = cameraBasis(view);
      for (const layer of this.dashLayers) {
        if (!layer.dashed) continue;
        const c = layer.center;
        const depth = Math.max(1e-3, (c.x - basis.eye[0]) * basis.forward[0] + (c.y - basis.eye[1]) * basis.forward[1] + (c.z - basis.eye[2]) * basis.forward[2]);
        layer.updateDashScale(pixelsPerWorld(lens, depth));
      }
    }
    if (this.notifyPending) {
      this.notifyPending = false;
      for (const l of [...this.listeners]) l();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    for (const l of this.lineLayers) { l.group.removeFromParent(); l.dispose(); }
    for (const m of [this.dimArrows, this.dimProblemArrows, this.previewArrows, ...Object.values(this.liveArrows), this.band, this.regionSelected, this.regionHover, this.haloSelected, this.haloHover]) m.dispose();
    this.fill.dispose(); // profile fill
    for (const d of [this.pointHalos, this.pointDiscs, this.pointRings, this.previewPoints]) { d.group.removeFromParent(); d.dispose(); }
  }

  // --- projection ---------------------------------------------------------------------------------------------------------

  private projector(): SketchProjector | null {
    if (!this.frame) return null;
    const v = this.host.getView(), lens = this.host.getLens();
    const key = [v.target[0], v.target[1], v.target[2], v.azimuth, v.elevation, v.distance, lens.width, lens.height, lens.fovY, this.contentVersion].join("|");
    if (this.projectorMemo?.key !== key) this.projectorMemo = { key, projector: makeProjector(v, lens, this.frame) };
    return this.projectorMemo.projector;
  }

  // --- styles ---------------------------------------------------------------------------------------------------------------

  private fullColourNow(): string {
    const s = this.host.getStyle();
    return fullColour(s.lines.sketchFull.color, s.sketch.fullBlue, this.options.colour);
  }

  private lineStyleOf(kind: LineKind): LineStyle {
    const s = this.host.getStyle();
    return kind === "sketchFull" ? { ...s.lines.sketchFull, color: this.fullColourNow() } : s.lines[kind];
  }

  private applyStyles(): void {
    const s = this.host.getStyle();
    for (const [kind, layer] of this.curveLayers) layer.applyStyle(this.lineStyleOf(kind));
    const uKind = this.frame ? axisKindOf(this.frame.u) : "axisX";
    const vKind = this.frame ? axisKindOf(this.frame.v) : "axisY";
    this.axisU.applyStyle(s.lines[uKind]);
    this.axisV.applyStyle(s.lines[vKind]);
    this.originCross.applyStyle({ ...s.lines.bodyEdge, width: 1.2 });
    this.dimLines.applyStyle(s.lines.dimLine);
    this.dimProblemLines.applyStyle({ ...s.lines.sketchOver, width: s.lines.dimLine.width });
    const preview = s.sketch.preview;
    this.previewSolid.applyStyle({ color: preview, width: s.lines.sketchUnder.width, dash: [] });
    this.previewConstruction.applyStyle({ color: preview, width: s.lines.construction.width, dash: s.lines.construction.dash });
    this.previewGuides.applyStyle({ color: preview, width: 1, dash: [5, 4] });
    this.previewHints.applyStyle({ color: preview, width: 1.4, dash: [] });
    const liveColour: Record<LiveTone, string> = { active: s.sketch.preview, quiet: s.sketch.liveQuiet, invalid: s.sketch.liveInvalid };
    for (const tone of Object.keys(liveColour) as LiveTone[]) {
      this.liveLines[tone].applyStyle({ color: liveColour[tone], width: s.lines.dimLine.width, dash: [] });
      this.liveArrows[tone].setColour(liveColour[tone]);
    }
    this.dimArrows.setColour(s.lines.dimLine.color);
    this.previewArrows.setColour(preview);
    this.dimProblemArrows.setColour(s.lines.sketchOver.color);
    this.updateFillColour();
    this.regionSelected.setColour(s.lines.selection.color);
    this.regionSelected.setOpacity(s.opacity.selection);
    this.regionHover.setColour(s.lines.hover.color);
    this.regionHover.setOpacity(s.opacity.hover);
    this.haloSelected.setColour(s.lines.selection.color);
    this.haloHover.setColour(s.lines.hover.color);
    // Translucent parts keep the intended look (encoded colours mixed) on the renderer's linear blending.
    this.haloSelected.setOpacity(linearAlpha(s.lines.selection.color, s.background, HALO_OPACITY));
    this.haloHover.setOpacity(linearAlpha(s.lines.hover.color, s.background, HALO_OPACITY));
    this.pointHalos.setOpacity(linearAlpha(s.lines.selection.color, s.background, HALO_OPACITY));
  }

  private updateFillColour(): void {
    const s = this.host.getStyle();
    this.fill.setColour(this.fullColourNow()); // profile fill
    this.fill.setOpacity(linearAlpha(this.fullColourNow(), s.background, PROFILE_FILL_OPACITY)); // profile fill
    this.band.setColour(s.sketch.band[this.options.colour]);
    this.band.setOpacity(linearAlpha(s.sketch.band[this.options.colour], s.background, BAND_OPACITY));
  }

  // --- content that changes with the sketch ---------------------------------------------------------------------------------

  private updateCurveLayers(_frame: Frame3): void {
    for (const [kind, layer] of this.curveLayers) {
      const found = this.curveSegs.find((c) => c.kind === kind);
      if (!found) layer.replaceGeometry({ positions: new Float32Array(0) });
      else layer.replaceGeometry({ positions: found.buffers.positions, distanceStart: found.buffers.distanceStart, distanceEnd: found.buffers.distanceEnd });
    }
  }

  private updatePointItems(): void {
    const s = this.host.getStyle();
    const outer = POINT_RADIUS_PX + POINT_STROKE_PX / 2;
    const stroke = (state: string) => (state === "full" ? this.fullColourNow() : state === "over" ? s.lines.sketchOver.color : s.lines.sketchUnder.color);
    // A point that is not fully determined is hollow (the colour of the view inside); determined and conflicting points are filled.
    this.pointRings.set(this.scene.points.map((p) => ({ u: p.u, v: p.v, radiusPx: outer, color: stroke(p.state) })));
    this.pointDiscs.set(this.scene.points.map((p) => ({ u: p.u, v: p.v, radiusPx: outer, color: p.state === "under" ? s.background : stroke(p.state) })));
  }

  /** The regions the highlight works on (none while a drag skips them); which loops or regions it marks is decided per mode. */
  private shownProfiles(view: SketchView): SketchView["profiles"] {
    return view.drag?.profilesSkipped ? [] : view.profiles;
  }

  private updateFill(view: SketchView, frame: Frame3): void { // profile fill
    // profile fill: the lines below are all of it on this side.
    this.fill.set(frame, this.options.highlight === "fill" ? filledProfiles(this.shownProfiles(view)) : []);
  }

  // --- content that depends on the scale -----------------------------------------------------------------------------------

  /** Rebuilds what is sized in pixels when the scale (or the content) changed. Returns the projector, null without a sketch. */
  private ensureScale(): SketchProjector | null {
    const proj = this.projector();
    if (!proj || !this.view || !this.frame) return proj;
    const lens = this.host.getLens();
    const diagMm = Math.hypot(lens.width, lens.height) * proj.mmPerPx;
    const mid = proj.toSketch(lens.width / 2, lens.height / 2) ?? { u: 0, v: 0 };
    const bucket = Math.max(diagMm * 0.25, 1e-6);
    const key = [this.contentVersion, Math.round(proj.pxPerMm * 1000), lens.width, lens.height, Math.round(mid.u / bucket), Math.round(mid.v / bucket), this.options.highlight, this.options.showDimensions, this.options.liveDimensions, this.options.colour].join("|");
    if (key === this.scaleKey) return proj;
    this.scaleKey = key;
    const frame = this.frame, view = this.view;
    const mm = proj.mmPerPx;

    // Dimensions.
    this.graphics = this.options.showDimensions ? dimensionGraphics(view.dimensions, this.scene, mm) : [];
    const normal = this.graphics.filter((g) => !g.problem), problem = this.graphics.filter((g) => g.problem);
    const segsOf = (list: DimensionGraphic[]) => list.flatMap((g) => g.segments);
    this.dimLines.replaceGeometry(toLayerGeometry(frame, segPolylines(segsOf(normal))));
    this.dimProblemLines.replaceGeometry(toLayerGeometry(frame, segPolylines(segsOf(problem))));
    const arrows = (list: DimensionGraphic[], target: FlatMesh) => this.setArrows(target, frame, list, mm);
    arrows(normal, this.dimArrows);
    arrows(problem, this.dimProblemArrows);

    // Axes and origin. The axes reach a bit beyond the view; they are rebuilt when the view moved far or zoomed.
    this.axisReach = diagMm * 1.2 + Math.max(Math.abs(mid.u), Math.abs(mid.v));
    const L = this.axisReach;
    this.axisU.replaceGeometry(toLayerGeometry(frame, [[[-L, 0], [L, 0]]]));
    this.axisV.replaceGeometry(toLayerGeometry(frame, [[[0, -L], [0, L]]]));
    const c = ORIGIN_CROSS_PX * mm;
    this.originCross.replaceGeometry(toLayerGeometry(frame, [[[-c, 0], [c, 0]], [[0, -c], [0, c]]]));

    // The highlight of determined regions: the band is sized in pixels, the fill was built with the sketch.
    if (this.options.highlight === "band") {
      const mesh = bandOfLoops(determinedLoops(this.shownProfiles(view)), BAND_WIDTH_PX * mm);
      this.band.set(frame, mesh.positions, mesh.indices);
    } else {
      this.band.clear();
    }

    this.rebuildPreview(frame, mm);
    this.highlightDirty = true;
    return proj;
  }

  /** The arrowheads of dimension graphics as triangles in a flat mesh. */
  private setArrows(target: FlatMesh, frame: Frame3, list: readonly DimensionGraphic[], mm: number): void {
    const tris = list.flatMap((g) => g.arrows.map((a) => arrowTriangle(a, mm)));
    const uv = new Float32Array(tris.length * 6);
    const idx = new Uint32Array(tris.length * 3);
    tris.forEach((t, i) => {
      for (let k = 0; k < 3; k++) { uv[i * 6 + k * 2] = t[k]![0]; uv[i * 6 + k * 2 + 1] = t[k]![1]; idx[i * 3 + k] = i * 3 + k; }
    });
    target.set(frame, uv, idx);
  }

  private rebuildPreview(frame: Frame3, mm: number): void {
    const p = this.preview;
    const lines = p ? previewPolylines(p) : { solid: [], construction: [] };
    // The dimension that is being placed: the graphics of a real dimension, drawn in the preview colour.
    const placing = p?.dimension
      ? dimensionGraphic(
          {
            id: "preview", kind: p.dimension.kind, refs: p.dimension.refs, value: { value: 0, unit: p.dimension.kind === "angle" ? "deg" : "mm" },
            driving: true, state: "ok", label: { x: p.dimension.label[0], y: p.dimension.label[1] },
            ...(p.dimension.reverse ? { reverse: p.dimension.reverse } : {}),
          },
          this.scene,
          mm,
        )
      : null;
    if (placing) for (const seg of placing.segments) lines.solid.push([seg[0], seg[1]]);
    this.setArrows(this.previewArrows, frame, placing ? [placing] : [], mm);
    // The values of the shape being drawn: the measuring graphics of a finished dimension, one colour per tone.
    this.liveGraphics = (this.options.liveDimensions === false ? [] : (p?.live ?? [])).map((item) => ({ tone: item.tone, graphic: liveDimensionGraphic(item.id, item.dim, mm, item.tone === "invalid") }));
    for (const tone of ["active", "quiet", "invalid"] as const) {
      const list = this.liveGraphics.filter((l) => l.tone === tone).map((l) => l.graphic);
      this.liveLines[tone].replaceGeometry(toLayerGeometry(frame, segPolylines(list.flatMap((g) => g.segments))));
      this.setArrows(this.liveArrows[tone], frame, list, mm);
    }
    this.previewSolid.replaceGeometry(toLayerGeometry(frame, lines.solid));
    this.previewConstruction.replaceGeometry(toLayerGeometry(frame, lines.construction));
    this.previewGuides.replaceGeometry(toLayerGeometry(frame, (p?.guides ?? []).map((g) => [g.a, g.b])));
    this.previewHints.replaceGeometry(toLayerGeometry(frame, segPolylines(hintSegments(p?.hints ?? [], mm))));
    const colour = this.host.getStyle().sketch.preview;
    this.previewPoints.set((p?.points ?? []).map((q) => ({ u: q[0], v: q[1], radiusPx: POINT_RADIUS_PX, color: colour })));
  }

  // --- hover and selection --------------------------------------------------------------------------------------------------

  private rebuildHighlights(proj: SketchProjector): void {
    this.highlightDirty = false;
    const frame = this.frame, view = this.view;
    if (!frame || !view) return;
    const mm = proj.mmPerPx;
    const half = (HALO_WIDTH_PX / 2) * mm;
    const s = this.host.getStyle();

    const hoverId = this.hover === null ? null : hitId(this.hover);
    const ids = [...this.selection];
    const kinds: { ids: string[]; ribbons: FlatMesh; region: FlatMesh; colour: string }[] = [
      { ids, ribbons: this.haloSelected, region: this.regionSelected, colour: s.lines.selection.color },
    ];
    if (hoverId !== null && !this.selection.has(hoverId)) kinds.push({ ids: [hoverId], ribbons: this.haloHover, region: this.regionHover, colour: s.lines.hover.color });
    this.haloHover.clear();
    this.regionHover.clear();

    const discs: { u: number; v: number; radiusPx: number; color: string }[] = [];
    for (const group of kinds) {
      const ribbons: RibbonMesh[] = [];
      const regions: RibbonMesh[] = [];
      for (const id of group.ids) {
        const curve = this.scene.curveById.get(id);
        if (curve) {
          const r = ribbonOfPolyline(curvePolyline(curve), curve.type === "circle", half);
          if (r) ribbons.push(r);
          continue;
        }
        const point = this.scene.pointById.get(id);
        if (point) {
          discs.push({ u: point.u, v: point.v, radiusPx: POINT_HALO_RADIUS_PX, color: group.colour });
          continue;
        }
        const dim = this.graphics.find((g) => g.id === id);
        if (dim) {
          for (const [a, b] of dim.segments) {
            const r = ribbonOfPolyline([a, b], false, half);
            if (r) ribbons.push(r);
          }
          continue;
        }
        const profile = view.profiles.find((p) => p.key === id);
        if (profile && !view.drag?.profilesSkipped) {
          regions.push({ positions: profile.fill.positions, indices: profile.fill.indices });
          continue;
        }
        if (id === "@origin") discs.push({ u: 0, v: 0, radiusPx: POINT_HALO_RADIUS_PX, color: group.colour });
        else if (id === "@axisU" || id === "@axisV") {
          const L = this.axisReach;
          const r = ribbonOfPolyline(id === "@axisU" ? [[-L, 0], [L, 0]] : [[0, -L], [0, L]], false, half);
          if (r) ribbons.push(r);
        }
      }
      const rm = mergeMeshes(ribbons);
      group.ribbons.set(frame, rm.positions, rm.indices);
      const rg = mergeMeshes(regions);
      group.region.set(frame, rg.positions, rg.indices);
    }
    this.pointHalos.set(discs);
  }
}

/** The id a hit is highlighted by: the id of a point, curve or dimension, the key of a region, "@origin" and "@axisU/V". */
export function hitId(hit: SketchHit): string | null {
  switch (hit.kind) {
    case "point": case "line": case "circle": case "dimension": return hit.id;
    case "region": return hit.key;
    case "origin": return "@origin";
    case "axis": return hit.axis === "u" ? "@axisU" : "@axisV";
  }
}

function hitKey(hit: SketchHit | null): string {
  return hit === null ? "" : `${hit.kind}:${hitId(hit)}`;
}

