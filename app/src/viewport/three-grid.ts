// The ground grid and the origin axes. The grid is one large quad in the grid plane (the XY plane, or the sketch plane while a
// sketch is shown) whose fragment shader draws the lines analytically: anti-aliased lines of a fixed width in pixels, a fine
// up to five nested levels of lines (every line of a coarser level is also a line of the finer ones), the X and Y axes as two more
// lines. There is no lattice of line geometry, so the grid has no edge and nothing is rebuilt while the zoom changes: the spacing,
// opacity and look of each level are uniforms that follow the zoom continuously (see gridLevels), so zooming in subdivides the cells
// without a switch. Lines of a level also fade out where they would be closer than a few pixels (far away, at grazing angles) and the
// whole grid fades out at the quad's far end, so no moire and no edge show.
// The lines are anti-aliased from their distance in device pixels (per axis, from the camera, not from screen derivatives) and are
// blended with the colour factors only: the canvas alpha must stay 1 (see the blend setup below), or thin lines break into dots.
// The axes are a quiet reference (axis-style.ts): thin and pale at rest, thicker and in full colour under the pointer, fading out with
// the distance from the origin and hidden together with the grid. The Z axis is a vertical line through the origin made of bands of
// different opacity (a line material has one opacity), so it fades like the other two. The grid is display only: it never snaps or catches anything.
import * as THREE from "three/webgpu";
import { abs, cameraPosition, clamp, dot, float, floor, length, max, min, mix, positionLocal, positionWorld, select, smoothstep, uniform, vec2, vec3, vec4 } from "three/tsl";
import type { Lens, ViewState } from "./camera.ts";
import { axesShown, axisFade, axisFadeRange, axisLook, AXIS_FADE_END, type AxisIndex } from "./axis-style.ts";
import { DENSE_FULL_PX, DENSE_NONE_PX, gridCamera, gridLayout, MAX_GRID_LEVELS, REACH_FADE_START } from "./grid-math.ts";
import type { Frame3 } from "./sketch/frame.ts";
import { LineLayer } from "./three-lines.ts";
import type { ViewportStyle } from "./style.ts";

/** The Z axis is drawn in this many bands (per direction) of different opacity. */
const Z_BANDS = 14;

/** Smallest pixel footprint the shader divides by (a plane seen exactly edge-on has none). */
const EPS = 1e-9;

type Num = THREE.Node<"float">;
type Color3 = THREE.Node<"vec3">;

const scratch = new THREE.Color();
/** A CSS colour as linear RGB in a vector (the working colour space; the renderer converts on output). */
function setRgb(target: THREE.Vector3, css: string): void {
  scratch.set(css);
  target.set(scratch.r, scratch.g, scratch.b);
}

export class GridView {
  readonly group = new THREE.Group();
  /** Holds the grid quad: it lies in the XY plane, or in the sketch plane while a sketch is shown (setFrame). */
  private readonly gridGroup = new THREE.Group();
  private readonly quad: THREE.Mesh;
  private readonly material = new THREE.NodeMaterial();
  /** The Z axis as bands from the origin outwards (both directions in each), each with its own opacity. */
  private zBands: { layer: LineLayer; fade: number }[] = [];
  private zKey = "";
  private axisHover: AxisIndex | null = null;
  private styled: ViewportStyle | null = null;
  private frame: Frame3 | null = null;
  /** Distance from the eye out to which the grid is drawn (for the far plane), 0 while nothing is shown. */
  reach = 0;
  gridVisible = true;
  originVisible = true;

  private readonly u = {
    half: uniform(1),
    center: uniform(new THREE.Vector2(0, 0)),
    reach: uniform(1),
    eye: uniform(new THREE.Vector3()),
    forward: uniform(new THREE.Vector3(0, 0, -1)),
    stepX: uniform(new THREE.Vector3(1, 0, 0)),
    stepY: uniform(new THREE.Vector3(0, 1, 0)),
    /** The levels of lines: spacing (mm), opacity and look (0 = fine line, 1 = coarse line), finest first. */
    levels: Array.from({ length: MAX_GRID_LEVELS }, () => ({ spacing: uniform(1), opacity: uniform(0), major: uniform(0), coarser: uniform(0) })),
    gridOn: uniform(1),
    axesOn: uniform(1),
    minorColor: uniform(new THREE.Vector3()),
    majorColor: uniform(new THREE.Vector3()),
    axisXColor: uniform(new THREE.Vector3()),
    axisYColor: uniform(new THREE.Vector3()),
    minorWidth: uniform(1),
    majorWidth: uniform(1),
    axisXWidth: uniform(1),
    axisYWidth: uniform(1),
    axisXOpacity: uniform(1),
    axisYOpacity: uniform(1),
    axisXBoost: uniform(1),
    axisYBoost: uniform(1),
    /** Distances from the origin (mm) where the axes start to fade and are gone. */
    fadeStart: uniform(1),
    fadeEnd: uniform(2),
  };

  constructor() {
    const u = this.u;
    // Plane coordinates relative to the quad's middle (mm) and what one pixel is worth along each of them (mm per device
    // pixel). The footprint is worked out from the camera, not from screen-space derivatives: those are one value per
    // 2 x 2 pixels and make thin lines break up near the horizon. The same formula is pixelFootprint in grid-math.ts.
    const local = positionLocal.xy.mul(u.half);
    const q = vec3(local.x.sub(u.eye.x), local.y.sub(u.eye.y), u.eye.z.negate());
    const qn = select(q.z.lessThan(0), float(-1), float(1)).mul(max(abs(q.z), 1e-6));
    const depth = dot(q, u.forward);
    const along = (step: Color3) => step.sub(q.mul(step.z.div(qn))).mul(depth);
    const moveX = along(u.stepX);
    const moveY = along(u.stepY);
    const perPixel = vec2(max(length(vec2(moveX.x, moveY.x)), EPS), max(length(vec2(moveX.y, moveY.y)), EPS));

    // Share of a pixel that a line of `width` px covers when its centre is `distancePx` away (lineCoverage in grid-math.ts). A line
    // thinner than one pixel is drawn one pixel wide and paler by the same ratio: that keeps it unbroken instead of dashed.
    const coverage = (distancePx: Num, width: Num) => {
      const drawn = max(width, 1);
      return clamp(drawn.mul(0.5).add(0.5).sub(distancePx), 0, 1).mul(width.div(drawn));
    };
    // 1 for lines that are far apart on the screen, 0 for lines that would only flicker.
    const dense = (spacingPx: Num) => smoothstep(DENSE_NONE_PX, DENSE_FULL_PX, spacingPx);
    // One level of the lattice: lines at every multiple of `spacing`. The centre is a multiple of the coarsest spacing, so the
    // pattern relative to it is the pattern in the plane.
    // Every `coarser`-th line (when it is not 0) belongs to the next coarser level, which draws it: this level leaves it out.
    const level = (spacing: Num, width: Num, coarser: Num) => {
      const across = (v: Num, pp: Num) => {
        const cells = v.div(spacing);
        const nearest = floor(cells.add(0.5));
        const offset = abs(cells.sub(nearest)).mul(spacing);
        const ratio = max(coarser, 1);
        const every = nearest.div(ratio);
        const isCoarserLine = select(coarser.greaterThan(0.5), select(abs(every.sub(floor(every.add(0.5)))).lessThan(0.01), float(1), float(0)), float(0));
        return coverage(offset.div(pp), width).mul(dense(spacing.div(pp))).mul(float(1).sub(isCoarserLine));
      };
      return max(across(local.x, perPixel.x), across(local.y, perPixel.y));
    };
    // A single line through the plane origin, `at` being the quad centre's coordinate along the line's normal.
    const axis = (v: Num, at: Num, pp: Num, width: Num) => coverage(abs(v.add(at)).div(pp), width);

    // 1 near the origin, 0 at the end of the fade (axisFade in axis-style.ts), by the distance along the axis.
    const alongFade = (along: Num, boost: Num) => min(float(1), float(1).sub(smoothstep(u.fadeStart, u.fadeEnd, abs(along))).mul(boost));
    const eyeDistance = length(positionWorld.sub(cameraPosition));
    const farFade = float(1).sub(smoothstep(u.reach.mul(REACH_FADE_START), u.reach, eyeDistance));

    // Finest level first, so the coarser lines lie over the finer ones. Each level looks like a fine line, a coarse line or
    // something in between, by its place on the way from one to the other.
    const layers: { color: Color3; alpha: Num }[] = [
      ...u.levels.map((lv) => ({
        color: mix(u.minorColor, u.majorColor, lv.major) as Color3,
        alpha: level(lv.spacing, mix(u.minorWidth, u.majorWidth, lv.major), lv.coarser).mul(lv.opacity).mul(u.gridOn),
      })),
      // The X axis is the line v = 0, the Y axis the line u = 0.
      { color: u.axisXColor, alpha: axis(local.y, u.center.y, perPixel.y, u.axisXWidth).mul(u.axesOn).mul(u.axisXOpacity).mul(alongFade(local.x.add(u.center.x), u.axisXBoost)) },
      { color: u.axisYColor, alpha: axis(local.x, u.center.x, perPixel.x, u.axisYWidth).mul(u.axesOn).mul(u.axisYOpacity).mul(alongFade(local.y.add(u.center.y), u.axisYBoost)) },
    ];
    // Lay the levels over each other (the axes on top), then take the fade towards the far end.
    let colour: Color3 = vec3(0, 0, 0);
    let alpha: Num = float(0);
    for (const layer of layers) {
      colour = layer.color.mul(layer.alpha).add(colour.mul(float(1).sub(layer.alpha)));
      alpha = layer.alpha.add(alpha.mul(float(1).sub(layer.alpha)));
    }
    this.material.fragmentNode = vec4(colour.div(max(alpha, 1e-5)), alpha.mul(farFade));

    const m = this.material;
    m.side = THREE.DoubleSide;
    m.depthWrite = false;
    // Blended over what is drawn already, but kept in the opaque pass: that way it is drawn in order with the line layers (the
    // sketch lines, which come later, must lie over it) and not after all of them.
    m.transparent = false;
    m.blending = THREE.CustomBlending;
    m.blendEquation = THREE.AddEquation;
    m.blendSrc = THREE.SrcAlphaFactor;
    m.blendDst = THREE.OneMinusSrcAlphaFactor;
    // The alpha channel is left as it is. Without this the colour factors are used for it too, the frame's alpha drops to
    // 1 - a + a * a under every line pixel, and the browser composites the canvas over the page behind it: the lines come out
    // much paler than their coverage (about coverage cubed) and the soft edge of a thin line all but vanishes, so it breaks into dots.
    m.blendSrcAlpha = THREE.ZeroFactor;
    m.blendDstAlpha = THREE.OneFactor;

    const geometry = new THREE.PlaneGeometry(2, 2);
    this.quad = new THREE.Mesh(geometry, m);
    this.quad.renderOrder = 10;
    this.quad.frustumCulled = false;
    this.gridGroup.matrixAutoUpdate = false;
    this.gridGroup.add(this.quad);
    this.group.add(this.gridGroup);
  }

  /** Puts the grid into a plane (the sketch plane); null puts it back into the XY plane. The world axes are then left to the sketch layer. */
  setFrame(frame: Frame3 | null): void {
    this.frame = frame;
    const m = this.gridGroup.matrix;
    if (frame) {
      m.set(
        frame.u[0], frame.v[0], frame.normal[0], frame.origin[0],
        frame.u[1], frame.v[1], frame.normal[1], frame.origin[1],
        frame.u[2], frame.v[2], frame.normal[2], frame.origin[2],
        0, 0, 0, 1,
      );
    } else {
      m.identity();
    }
    this.gridGroup.matrixWorldNeedsUpdate = true;
  }

  /** True while the axes are drawn: with the grid, not in a sketch plane, and when the origin is shown. */
  get axesVisible(): boolean {
    return axesShown(this.gridVisible, this.originVisible, this.frame !== null);
  }

  /** The axis the pointer is on (0 X, 1 Y, 2 Z) or null; it is drawn thicker and in its full colour. Returns true when that changed. */
  setAxisHover(axis: AxisIndex | null): boolean {
    if (this.axisHover === axis) return false;
    this.axisHover = axis;
    this.styled = null;
    this.zKey = "";
    return true;
  }

  /** Sets what depends on the view: spacing, the quad's place and size, the axes. Cheap: only uniforms and a transform change. */
  update(view: ViewState, lens: Lens, style: ViewportStyle, pixelRatio: number): void {
    const showAxes = this.axesVisible;
    // The axes show only with the grid, so the grid decides whether anything of this is drawn.
    const shown = this.gridVisible;
    this.group.visible = shown;
    this.updateZAxis(style, view.distance, showAxes);
    // The reach also sets the far plane of the camera: it is kept while the grid is hidden, so that switching the grid on and off does
    // not change the depth range (and with it the depth precision of everything else that is drawn).
    const layout = gridLayout(view, lens, this.frame);
    this.reach = layout.reach;
    if (!shown) return;

    const u = this.u;
    u.half.value = layout.half;
    u.center.value.set(layout.centerU, layout.centerV);
    // Levels the zoom does not need are switched off (opacity 0); their spacing stays a valid number.
    u.levels.forEach((lv, i) => {
      const level = layout.levels[i];
      lv.spacing.value = level ? level.spacing : layout.snap;
      lv.opacity.value = level ? level.opacity : 0;
      lv.major.value = level ? level.major : 1;
      lv.coarser.value = level ? level.coarser : 0;
    });
    u.reach.value = layout.reach;
    const camera = gridCamera(view, lens, this.frame, layout, pixelRatio);
    u.eye.value.set(...camera.eye);
    u.forward.value.set(...camera.forward);
    u.stepX.value.set(...camera.stepX);
    u.stepY.value.set(...camera.stepY);
    u.gridOn.value = this.gridVisible ? 1 : 0;
    u.axesOn.value = showAxes ? 1 : 0;
    const fade = axisFadeRange(view.distance);
    u.fadeStart.value = fade.start;
    u.fadeEnd.value = fade.end;
    this.quad.position.set(layout.centerU, layout.centerV, 0);
    this.quad.scale.set(layout.half, layout.half, 1);
    // The geometry is a square of side 2: the vertex positions the shader reads are -1..1 and it scales them by `half`.
    if (style !== this.styled) {
      this.styled = style;
      this.applyStyle(style);
    }
  }

  /** Colours and widths into the uniforms. */
  private applyStyle(style: ViewportStyle): void {
    const l = style.lines;
    const u = this.u;
    setRgb(u.minorColor.value, l.gridMinor.color);
    setRgb(u.majorColor.value, l.gridMajor.color);
    setRgb(u.axisXColor.value, l.axisX.color);
    setRgb(u.axisYColor.value, l.axisY.color);
    u.minorWidth.value = l.gridMinor.width;
    u.majorWidth.value = l.gridMajor.width;
    const x = axisLook(l.axisX, this.axisHover === 0), y = axisLook(l.axisY, this.axisHover === 1);
    u.axisXWidth.value = x.width;
    u.axisYWidth.value = y.width;
    u.axisXOpacity.value = x.opacity;
    u.axisYOpacity.value = y.opacity;
    u.axisXBoost.value = x.fadeBoost;
    u.axisYBoost.value = y.fadeBoost;
  }

  /**
   * The Z axis runs through the origin in both directions, out to the end of its fade, in bands of different opacity: band i covers the
   * stretch from i/N to (i+1)/N of that length (each in both directions) and has the opacity the fade has in its middle. The bands are
   * built once; their length follows the zoom through the scale of the group, and the fade keeps the same shape at every zoom.
   */
  private updateZAxis(style: ViewportStyle, viewDistance: number, shown: boolean): void {
    if (this.zBands.length === 0) {
      const bands = Z_BANDS;
      for (let i = 0; i < bands; i++) {
        const a = i / bands, b = (i + 1) / bands;
        const layer = new LineLayer({ positions: new Float32Array([0, 0, a, 0, 0, b, 0, 0, -a, 0, 0, -b]) }, { renderOrder: 12 });
        this.group.add(layer.group);
        // The same opacity as the shader's fade at this distance from the origin, in units of the view distance.
        const middle = ((i + 0.5) / bands) * AXIS_FADE_END;
        this.zBands.push({ layer, fade: axisFade(middle, 1) });
      }
      this.zKey = "";
    }
    for (const band of this.zBands) band.layer.visible = shown && band.fade > 0.01;
    if (!shown) return;
    const z = style.lines.axisZ;
    const hovered = this.axisHover === 2;
    const key = `${z.color}|${z.width}|${hovered}`;
    if (key !== this.zKey) {
      this.zKey = key;
      const look = axisLook(z, hovered);
      for (const band of this.zBands) {
        band.layer.applyStyle({ ...z, width: look.width });
        band.layer.setOpacity(look.opacity * Math.min(1, band.fade * look.fadeBoost));
      }
    }
    // The length of the whole axis, from the origin to the end of the fade, in mm.
    for (const band of this.zBands) band.layer.group.scale.set(1, 1, axisFadeRange(viewDistance).end);
  }

  /** Forces the style to be applied again at the next update (after a style change). */
  invalidate(): void {
    this.zKey = "";
    this.styled = null;
  }

  dispose(): void {
    this.quad.geometry.dispose();
    this.material.dispose();
    for (const band of this.zBands) {
      band.layer.group.removeFromParent();
      band.layer.dispose();
    }
    this.zBands = [];
  }
}
