// Pixel-width lines with dash patterns on three.js's fat-line approach (Line2NodeMaterial, instanced screen-space quads),
// which runs on the WebGPU backend and on the WebGL2 fallback alike. One LineLayer is one set of segments drawn in one
// style; a dash pattern with several dashes is drawn as several passes of the same segments (see dashPasses).
//
// Dash lengths are in screen pixels: the dash phase is the length along the line (mm) times the pixels per mm at the
// layer's distance from the camera, which the viewport updates before every frame (updateDashScale).
import * as THREE from "three/webgpu";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineSegments2 } from "three/addons/lines/webgpu/LineSegments2.js";
import { dashPasses, type LineStyle } from "./style.ts";

export interface LayerGeometry {
  /** x0 y0 z0 x1 y1 z1 per segment. */
  positions: Float32Array;
  /** Dash phase at the start and end of each segment, mm. Without it, dashes cannot be drawn. */
  distanceStart?: Float32Array;
  distanceEnd?: Float32Array;
  /** r g b r g b per segment (linear colour at both ends); the material colour is then white. */
  colors?: Float32Array;
}

export interface LayerOptions {
  renderOrder: number;
  /** Draws only where something solid is in front (the hidden edges of a body). */
  behindSolids?: boolean;
  /** Pixels added to the width (a highlight is thicker than the line it marks). */
  extraWidth?: number;
  /** Lines of a sketch lie in a plane that bodies may share: they are pulled towards the camera a little. */
  polygonOffset?: boolean;
  /** Drawn over everything, whatever is in front (a manipulator: the extrude arrow). Goes into the transparent pass so it also lies over translucent bodies. */
  onTop?: boolean;
}

/** Builds the segment geometry of a layer. */
export function buildLineGeometry(g: LayerGeometry): LineSegmentsGeometry {
  const geometry = new LineSegmentsGeometry();
  geometry.setPositions(g.positions);
  if (g.colors) geometry.setColors(g.colors);
  if (g.distanceStart && g.distanceEnd) {
    const n = g.positions.length / 6;
    const interleaved = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      interleaved[i * 2] = g.distanceStart[i]!;
      interleaved[i * 2 + 1] = g.distanceEnd[i]!;
    }
    const buffer = new THREE.InstancedInterleavedBuffer(interleaved, 2, 1);
    geometry.setAttribute("instanceDistanceStart", new THREE.InterleavedBufferAttribute(buffer, 1, 0));
    geometry.setAttribute("instanceDistanceEnd", new THREE.InterleavedBufferAttribute(buffer, 1, 1));
  }
  return geometry;
}

const EMPTY_POSITIONS = new Float32Array(6);

export class LineLayer {
  readonly group = new THREE.Group();
  /** Where the layer is, for the dash scale (distance from the camera). */
  readonly center = new THREE.Vector3();
  private geometry: LineSegmentsGeometry;
  private readonly hasColors: boolean;
  private hasDistances: boolean;
  /** False while the layer has no segments: it is then hidden (a fat line cannot be empty). */
  private hasContent: boolean;
  private shown = true;
  private materials: { material: THREE.Line2NodeMaterial; dashed: boolean }[] = [];
  private meshes: LineSegments2[] = [];
  private style: LineStyle | null = null;
  /** 1 = opaque. Below 1 the layer is blended (a faded axis); the hair-thin edges stay smooth by alpha-to-coverage only while it is opaque. */
  private opacity = 1;
  segmentCount: number;

  private readonly options: LayerOptions;

  constructor(geometry: LayerGeometry, options: LayerOptions) {
    this.options = options;
    this.hasContent = geometry.positions.length >= 6;
    this.geometry = buildLineGeometry(this.hasContent ? geometry : { positions: EMPTY_POSITIONS });
    this.hasColors = geometry.colors !== undefined;
    this.hasDistances = geometry.distanceStart !== undefined;
    this.segmentCount = geometry.positions.length / 6;
    this.updateCenter(geometry.positions);
    this.group.visible = this.hasContent;
  }

  /** A layer without segments yet; fill it with replaceGeometry. Dashes need the distances, so say so up front. */
  static empty(options: LayerOptions, withDistances = false): LineLayer {
    return new LineLayer(withDistances ? { positions: new Float32Array(0), distanceStart: new Float32Array(0), distanceEnd: new Float32Array(0) } : { positions: new Float32Array(0) }, options);
  }

  /** The centre of the segments' bounds, for the dash scale. */
  private updateCenter(p: Float32Array): void {
    if (p.length < 6) return;
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    for (let i = 0; i + 2 < p.length; i += 3) box.expandByPoint(v.set(p[i]!, p[i + 1]!, p[i + 2]));
    box.getCenter(this.center);
  }

  /**
   * Replaces the segments in place: the materials stay, so nothing is recompiled. For content that changes often (a sketch
   * that is dragged, a highlight that follows the pointer). The layer keeps its kind of data (colours, distances).
   */
  replaceGeometry(geometry: LayerGeometry): void {
    const had = this.hasContent;
    this.hasContent = geometry.positions.length >= 6;
    this.segmentCount = geometry.positions.length / 6;
    this.group.visible = this.hasContent && this.shown;
    if (!this.hasContent) return;
    this.hasDistances = geometry.distanceStart !== undefined;
    const next = buildLineGeometry(geometry);
    for (const mesh of this.meshes) mesh.geometry = next;
    // A layer that has never had content has no meshes' real geometry yet: the old geometry is the placeholder.
    this.geometry.dispose();
    this.geometry = next;
    this.updateCenter(geometry.positions);
    if (!had && this.style) this.applyStyle(this.style);
  }

  /** Applies a style: colour, width and dashes. Builds the line objects on first use and when the dash pattern changes. */
  applyStyle(style: LineStyle): void {
    const passes = this.hasDistances ? dashPasses(style.dash) : [];
    const wanted = passes.length === 0 ? 1 : passes.length;
    const dashedNow = passes.length > 0;
    const rebuild = this.materials.length !== wanted || (this.materials[0]?.dashed ?? false) !== dashedNow;
    if (rebuild) this.disposeMeshes();
    const width = style.width + (this.options.extraWidth ?? 0);
    for (let i = 0; i < wanted; i++) {
      let entry = this.materials[i];
      if (!entry) {
        const material = new THREE.Line2NodeMaterial({
          color: this.hasColors ? new THREE.Color().setScalar(1) : style.color,
          linewidth: width,
          worldUnits: false,
          vertexColors: this.hasColors,
          dashed: dashedNow,
        });
        material.alphaToCoverage = true;
        material.depthWrite = false;
        if (this.options.polygonOffset) {
          material.polygonOffset = true;
          material.polygonOffsetFactor = -2;
          material.polygonOffsetUnits = -2;
        }
        if (this.options.behindSolids) material.depthFunc = THREE.GreaterDepth;
        if (this.options.onTop) {
          material.depthTest = false;
          material.transparent = true;
        }
        entry = { material, dashed: dashedNow };
        this.materials.push(entry);
        const mesh = new LineSegments2(this.geometry, material);
        mesh.renderOrder = this.options.renderOrder;
        this.meshes.push(mesh);
        this.group.add(mesh);
      }
      const m = entry.material;
      if (!this.hasColors) m.color.set(style.color);
      m.linewidth = width;
      this.applyOpacity(m);
      const pass = passes[i];
      if (pass) {
        m.dashSize = pass.dash;
        m.gapSize = pass.gap;
        m.dashOffset = pass.offset;
      }
    }
    this.style = style;
  }

  /**
   * A fat-line material is opaque (it uses no blending) and, when it is marked transparent, mixes itself with a copy of what is behind
   * it and writes a partial alpha into the canvas, which the page behind then shines through. A faded line is therefore blended the way
   * the grid is: kept in the opaque pass, colour factors only, the alpha channel left alone.
   */
  private applyOpacity(m: THREE.Line2NodeMaterial): void {
    const faded = this.opacity < 1;
    m.opacity = this.opacity;
    m.alphaToCoverage = !faded;
    const blending = faded ? THREE.CustomBlending : THREE.NoBlending;
    if (m.blending !== blending) {
      m.blending = blending;
      m.needsUpdate = true;
    }
    if (faded) {
      m.blendEquation = THREE.AddEquation;
      m.blendSrc = THREE.SrcAlphaFactor;
      m.blendDst = THREE.OneMinusSrcAlphaFactor;
      m.blendSrcAlpha = THREE.ZeroFactor;
      m.blendDstAlpha = THREE.OneFactor;
    }
  }

  /** How opaque the layer is, 0..1 (see `opacity`). */
  setOpacity(opacity: number): void {
    if (opacity === this.opacity) return;
    this.opacity = opacity;
    for (const e of this.materials) this.applyOpacity(e.material);
  }

  get dashed(): boolean {
    return (this.style?.dash.length ?? 0) >= 2 && this.hasDistances;
  }

  /** Pixels per mm at the layer's distance from the camera; keeps dashes the same length on the screen at any zoom. */
  updateDashScale(pxPerMm: number): void {
    for (const e of this.materials) if (e.dashed) e.material.scale = pxPerMm;
  }

  set visible(v: boolean) {
    this.shown = v;
    this.group.visible = v && this.hasContent;
  }

  private disposeMeshes(): void {
    for (const mesh of this.meshes) this.group.remove(mesh);
    for (const e of this.materials) e.material.dispose();
    this.meshes = [];
    this.materials = [];
  }

  dispose(): void {
    this.disposeMeshes();
    this.geometry.dispose();
  }
}
