// The main window (focus layout): title row, toolbar with tabs and tool groups, the browser tree on
// the left, the 3D view with its context bar, axis navigator and navigation bar in the middle, the timeline at the bottom
// and the status bar. It talks to the model layer only (HalfCubeModel, SketchEditor); never to the engine client.
//
// Where the user is stays in the URL (screen, open sketch, settings dialog), so a reload (F5) brings them back to the same
// place; the working document survives in the tab's session storage (autosave.ts).
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { EngineSession } from "../../engine/index.ts";
import { useI18n } from "../../i18n/runtime.ts";
import type { OriginPlane, SketchFeature } from "../../document/types.ts";
import { problemText, type SketchEditor } from "../../model/index.ts";
import { useSettings } from "../../prefs/settings-runtime.ts";
import { cx } from "../../ui/cx.ts";
import { Glyph } from "../../ui/Glyph.tsx";
import { keysBelongToTarget } from "../../ui/typing-target.ts";
import { constraintLabel, describeDocumentId, dimensionLabel, describeSketchData } from "../sketch/describe.ts";
import { SketchHistory } from "../sketch/history.ts";
import { shapeName } from "../sketch/shape-name.ts";
import { useSketchReject } from "../sketch/reject.tsx";
import { SketchSession } from "../sketch/session.ts";
import { SketchMode } from "../sketch/SketchMode.tsx";
import { SketchToolbar } from "../sketch/SketchToolbar.tsx";
import type { SketchLayer, SketchLayerOptions } from "../../viewport/sketch/types.ts";
import { ViewportView } from "../../viewport/ViewportView.tsx";
import type { EntityRef, Viewport } from "../../viewport/index.ts";
import { BrowserTree } from "./BrowserTree.tsx";
import { ContextBar } from "./ContextBar.tsx";
import type { CommittedStep } from "./extrude-command.ts";
import { signedDistance } from "./extrude-form.ts";
import { ExtrudePanel, PickProfileHint } from "./ExtrudePanel.tsx";
import { useDocument, useExtrudeCommand, useModelView, useProfileCatalogue, useSketchView } from "./hooks.ts";
import { getMainModel, type DevHooks } from "./main-model.ts";
import { NavBar, type DisplayStyle, type DragMode } from "./NavBar.tsx";
import { useReportFailure, type Failure } from "./report.tsx";
import { SettingsDialog } from "./SettingsDialog.tsx";
import { StatusBar } from "./StatusBar.tsx";
import { Timeline } from "./Timeline.tsx";
import { entityOf, extrudeHandle, handleToDistance, offeredProfiles, profileRefOf } from "./profile-bridge.ts";
import { choosePreselect, profileNumber } from "./profile-catalogue.ts";
import { buildTimeline, problemSteps, type TimelineText } from "./timeline-model.ts";
import { TitleBar } from "./TitleBar.tsx";
import { Toolbar } from "./Toolbar.tsx";
import { buildTree, initiallyExpanded, type TreeRow, type TreeText } from "./tree-model.ts";
import { patchUrl, readUrlState, isSettingsTab, type SettingsTab } from "./url-state.ts";
import { OPEN_SETTINGS_EVENT } from "../../updates/actions.ts";
import { workStore } from "../../updates/work.ts";
import { bodyData, committedBodies, featureSketchData } from "./view-bridge.ts";

export interface MainWindowProps {
  /** The engine session, or null in scenes that run without an engine. */
  session: EngineSession | null;
  /** The engine answers requests right now. */
  engineReady: boolean;
  /** The loading screen's logo has arrived in the title row. */
  arrived: boolean;
  /** Overlays over the work area: the loading panel, demo scenes. */
  overlay?: ReactNode;
}

const DRAG_SENSITIVITY_ZOOM = 0.01;
const noSubscribe = () => () => undefined;
const noHistory = { canUndo: false, canRedo: false };

export function MainWindow({ session, engineReady, arrived, overlay }: MainWindowProps) {
  const { t, language } = useI18n();
  const settings = useSettings();
  const languageRef = useRef(language);
  useEffect(() => {
    languageRef.current = language;
  }, [language]);
  const report = useReportFailure();
  const model = useMemo(() => getMainModel(session), [session]);
  const doc = useDocument(model);
  const modelView = useModelView(model);

  const [viewport, setViewport] = useState<Viewport | null>(null);
  const [editor, setEditor] = useState<SketchEditor | null>(null);
  const sketchView = useSketchView(editor);
  const [pickingPlane, setPickingPlane] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(() => readUrlState().settings ?? null);

  const [treeExpanded, setTreeExpanded] = useState<ReadonlySet<string>>(() => new Set(initiallyExpanded));
  const [timelineExpanded, setTimelineExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [selectedTreeId, setSelectedTreeId] = useState<string | null>(null);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [selectedSubId, setSelectedSubId] = useState<string | null>(null);

  const catalogue = useProfileCatalogue(model, doc, editor?.sketchId ?? null, engineReady);
  const onExtrudeCommitted = useCallback((step: CommittedStep) => {
    setSelectedStepId(step.featureId);
    setSelectedTreeId(`body:${step.bodyId}`);
    setSelectedSubId(null);
  }, []);
  const { command: extrude, state: extrudeState } = useExtrudeCommand(model, language === "de", onExtrudeCommitted);
  const extruding = extrudeState.phase !== "idle";

  const [navMode, setNavMode] = useState<DragMode | null>(null);
  const [display, setDisplay] = useState<DisplayStyle>("shaded");
  const [grid, setGrid] = useState(true);
  const [showConstraints, setShowConstraints] = useState(true);
  const [showDimensions, setShowDimensions] = useState(true);
  const [sketchSession, setSketchSession] = useState<SketchSession | null>(null);
  const [history, setHistory] = useState<SketchHistory | null>(null);
  const rejectSketch = useSketchReject();
  const rejectRef = useRef(rejectSketch);
  useEffect(() => {
    rejectRef.current = rejectSketch;
  }, [rejectSketch]);
  // The sketch layer of the 3D view: draws the open sketch and tells the tools what lies under the pointer.
  const layer = useMemo<SketchLayer | null>(() => (viewport ? viewport.sketchLayer() : null), [viewport]);
  const layerOptions = useMemo<SketchLayerOptions>(
    () => ({ highlight: settings.sketchFill, colour: settings.sketchColour, showConstraints, showDimensions, liveDimensions: settings.fieldLook === "dimension" }),
    [settings.sketchFill, settings.sketchColour, settings.fieldLook, showConstraints, showDimensions],
  );
  const optionsRef = useRef(layerOptions);
  useEffect(() => {
    optionsRef.current = layerOptions;
  }, [layerOptions]);

  // ---- texts and derived lists ------------------------------------------------------------------------------------

  const planeLabels = useMemo<Record<OriginPlane, string>>(
    () => ({ xy: t("main.tree.planeXy"), xz: t("main.tree.planeXz"), yz: t("main.tree.planeYz") }),
    [t],
  );
  const treeText = useMemo<TreeText>(
    () => ({
      origin: t("main.tree.origin"),
      planes: planeLabels,
      axes: { x: t("main.tree.axisX"), y: t("main.tree.axisY"), z: t("main.tree.axisZ") },
      sketches: t("main.tree.sketches"),
      bodies: t("main.tree.bodies"),
    }),
    [t, planeLabels],
  );
  const timelineText = useMemo<TimelineText>(
    () => ({
      line: t("main.timeline.subLine"),
      rectangle: t("main.timeline.subRectangle"),
      construction: t("main.timeline.subConstruction"),
      circle: t("main.timeline.subCircle"),
      // The names the sketch itself shows (Rechteck 1, Linie 3, d3 · 40 mm), never an internal id.
      shape: (kind, number) => shapeName(t, { kind, number }),
      constructionNamed: (name) => t("main.timeline.subConstructionNamed", { name }),
      dimension: (d) => dimensionLabel(t, d, language === "de"),
      constraint: (sketch, kind, refs) => constraintLabel(t, describeSketchData(sketch), kind, refs),
    }),
    [t, language],
  );

  const pickingOrigin = pickingPlane;
  const expandedForTree = useMemo(() => {
    // While the user is choosing a plane the origin is open, so the three planes can be clicked in the tree as well.
    if (!pickingOrigin) return treeExpanded;
    return new Set([...treeExpanded, "origin"]);
  }, [treeExpanded, pickingOrigin]);

  const rows = useMemo(() => buildTree({ doc, steps: modelView.steps, expanded: expandedForTree, text: treeText }), [doc, modelView.steps, expandedForTree, treeText]);
  const draftId = extrudeState.phase === "dialog" && extrudeState.mode === "create" ? extrudeState.featureId : null;
  const draftName = extrudeState.name;
  const steps = useMemo(
    () => buildTimeline(doc, modelView.steps, timelineText, draftId && draftName ? { featureId: draftId, label: draftName } : null),
    [doc, modelView.steps, timelineText, draftId, draftName],
  );
  const failed = useMemo(() => problemSteps(modelView.steps), [modelView.steps]);

  const componentName = doc.components[0]?.name ?? "";
  const editingFeature = editor ? (doc.timeline.find((f) => f.id === editor.sketchId) as SketchFeature | undefined) : undefined;
  /** The extrusion whose dialog is open, whether it is new or an existing step being edited. */
  const extrudeEditingId = extrudeState.phase === "dialog" ? extrudeState.featureId : null;
  const pickedProfile = extrudeState.profile;
  const extrudeProfileLabel = useMemo(() => {
    if (!pickedProfile) return null;
    const found = profileNumber(catalogue, pickedProfile);
    const sketchName = found?.sketch ?? doc.timeline.find((f) => f.id === pickedProfile.sketchId)?.name ?? "";
    return t("main.extrude.profileChosen", { n: found?.n ?? "–", sketch: sketchName });
  }, [pickedProfile, catalogue, doc, t]);

  // ---- the sketch: start, open, finish ----------------------------------------------------------------------------

  const enterSketch = useCallback(
    (opened: SketchEditor) => {
      setEditor(opened);
      setSelectedStepId(opened.sketchId);
      setSelectedTreeId(`sketch:${opened.sketchId}`);
      setNavMode(null);
      // The view turns to the sketch plane once the layer has the sketch (see the session effect).
    },
    [],
  );

  const startSketch = useCallback(
    async (plane: OriginPlane) => {
      setPickingPlane(false);
      try {
        enterSketch(await model.startSketch(plane));
      } catch (error) {
        const failure: Failure = { title: t("main.errors.sketchStartTitle"), code: "HC-MAIN-001", text: t("main.errors.sketchStartText"), error };
        void report(failure);
      }
    },
    [model, enterSketch, report, t],
  );

  const openSketch = useCallback(
    async (featureId: string) => {
      if (editor || extrude.active) return;
      const feature = model.document.getSnapshot().timeline.find((f) => f.id === featureId);
      if (!feature || feature.type !== "sketch") return;
      setPickingPlane(false);
      try {
        enterSketch(await model.editSketch(featureId));
      } catch (error) {
        void report({ title: t("main.errors.sketchEditTitle"), code: "HC-MAIN-002", error });
      }
    },
    [editor, extrude, model, enterSketch, report, t],
  );

  // ---- the extrude command: start, edit ------------------------------------------------------------------------------

  const startExtrude = useCallback(() => {
    if (editor) return;
    if (extrude.getState().phase === "pick") {
      extrude.cancel();
      return;
    }
    if (extrude.active) return;
    setNavMode(null);
    setPickingPlane(false);
    try {
      extrude.begin(choosePreselect(catalogue, selectedStepId));
    } catch (error) {
      extrude.cancel();
      void report({ title: t("main.errors.extrudeStartTitle"), code: "HC-MAIN-004", error });
    }
  }, [editor, extrude, catalogue, selectedStepId, report, t]);

  const openExtrude = useCallback(
    (featureId: string) => {
      if (editor || extrude.active) return;
      setPickingPlane(false);
      setNavMode(null);
      try {
        extrude.edit(featureId);
      } catch (error) {
        void report({ title: t("main.errors.extrudeEditTitle"), code: "HC-MAIN-005", error });
      }
    },
    [editor, extrude, report, t],
  );

  const finishSketch = useCallback(async () => {
    if (!editor || finishing) return;
    setFinishing(true);
    try {
      await editor.finish();
      setEditor(null);
    } catch (error) {
      void report({ title: t("main.errors.sketchFinishTitle"), code: "HC-MAIN-003", error });
    } finally {
      setFinishing(false);
    }
  }, [editor, finishing, report, t]);

  // A reload while a sketch was open: open it again once the engine answers. A failure is shown in our own dialog (with the id from
  // the address and the technical error under the details) and the page starts without the sketch.
  const [sketchFromUrl] = useState(() => readUrlState().sketch);
  const restoreStarted = useRef(false);
  const [restored, setRestored] = useState(sketchFromUrl === undefined);
  useEffect(() => {
    const id = sketchFromUrl;
    if (restored || restoreStarted.current || !id || !engineReady || !viewport) return;
    restoreStarted.current = true;
    const feature = model.document.getSnapshot().timeline.find((f) => f.id === id);
    const opening =
      feature && feature.type === "sketch"
        ? model.editSketch(id).then(enterSketch)
        : Promise.reject(new Error(`The sketch "${id}" from the address is not in the document.`));
    opening.then(
      () => setRestored(true),
      (error: unknown) => {
        console.warn("The open sketch could not be restored after the reload; starting without it.", error);
        setRestored(true);
        void report(
          feature && feature.type === "sketch"
            ? { title: t("main.errors.sketchRestoreFailedTitle"), code: "HC-MAIN-007", text: t("main.errors.sketchRestoreFailedText", { name: feature.name }), error }
            : { title: t("main.errors.sketchRestoreMissingTitle"), code: "HC-MAIN-006", text: t("main.errors.sketchRestoreMissingText", { id }), error },
        );
      },
    );
  }, [restored, sketchFromUrl, engineReady, viewport, model, enterSketch, report, t]);

  // The session of the open sketch: tools, selection, typed values and the messages of refused edits.
  useEffect(() => {
    if (!editor || !layer) return;
    const opened = new SketchSession({
      editor,
      layer,
      options: optionsRef.current,
      reject: (rejection) => rejectRef.current(rejection),
      decimalComma: languageRef.current === "de",
    });
    setSketchSession(opened);
    layer.alignToSketch(true);
    const owned = new SketchHistory(model.document);
    setHistory(owned);
    return () => {
      opened.dispose();
      owned.dispose();
      setSketchSession(null);
      setHistory(null);
    };
  }, [editor, layer, model]);
  useEffect(() => {
    sketchSession?.setOptions(layerOptions);
  }, [sketchSession, layerOptions]);
  const historyState = useSyncExternalStore(history ? history.subscribe : noSubscribe, history ? history.getState : () => noHistory);

  // Dev channel only: the open editor and the 3D view are reachable for the end-to-end tests next to the model (see main-model.ts).
  useEffect(() => {
    const hooks = (window as unknown as DevHooks).__halfcube;
    if (hooks) {
      hooks.editor = editor;
      hooks.session = sketchSession;
      hooks.layer = layer;
      hooks.viewport = viewport;
      hooks.extrude = extrude;
    }
  }, [editor, sketchSession, layer, viewport, extrude]);

  // ---- the address bar -----------------------------------------------------------------------------------------------

  useEffect(() => {
    if (restored) patchUrl({ sketch: editor?.sketchId ?? null });
  }, [restored, editor]);
  useEffect(() => {
    patchUrl({ settings: settingsTab });
  }, [settingsTab]);

  // What a restart for an update would lose: HalfCube cannot save yet, so every step of the timeline counts (updates/work.ts).
  const untitled = t("main.title.untitled");
  const stepCount = doc.timeline.length;
  useEffect(() => {
    workStore.set({ name: untitled, steps: stepCount });
  }, [untitled, stepCount]);
  useEffect(() => () => workStore.set(null), []);

  // The update views ask for a settings tab ("Einstellungen für Updates"); the dialog's state lives here.
  useEffect(() => {
    const onOpenSettings = (event: Event) => {
      const tab = (event as CustomEvent<unknown>).detail;
      setSettingsTab(isSettingsTab(tab) ? tab : null);
    };
    window.addEventListener(OPEN_SETTINGS_EVENT, onOpenSettings);
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, onOpenSettings);
  }, []);

  // ---- choosing the plane of a new sketch ------------------------------------------------------------------------------

  useEffect(() => {
    if (!viewport || !pickingPlane) return;
    viewport.setOriginPlanesVisible(true);
    viewport.setPickKinds(["plane"]);
    const off = viewport.on("pick", (pick) => {
      if (pick?.ref.kind === "plane") void startSketch(pick.ref.plane);
    });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPickingPlane(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      off();
      window.removeEventListener("keydown", onKey);
      viewport.setOriginPlanesVisible(false);
      viewport.setPickKinds(null);
      viewport.setHover(null);
    };
  }, [viewport, pickingPlane, startSketch]);

  const hoverPlane = useCallback(
    (plane: OriginPlane | null) => {
      const ref: EntityRef | null = plane ? { kind: "plane", plane } : null;
      viewport?.setHover(ref);
    },
    [viewport],
  );

  // ---- what the 3D view shows ------------------------------------------------------------------------------------------

  useEffect(() => {
    viewport?.setBodies(committedBodies(modelView));
  }, [viewport, modelView]);

  useEffect(() => {
    if (!viewport) return;
    const finished = doc.timeline
      .filter((f): f is SketchFeature => f.type === "sketch" && f.visible && f.id !== editor?.sketchId)
      .map(featureSketchData);
    // The open sketch is drawn by the sketch layer (sketch/session.ts); the view itself only draws the finished ones.
    viewport.setSketches(finished);
  }, [viewport, doc, editor]);

  // ---- the extrude command in the 3D view: areas to pick, the preview body, the drag arrow ------------------------------------

  const previewBodies = useMemo(() => modelView.bodies.filter((b) => b.preview).map(bodyData), [modelView]);
  useEffect(() => {
    // Shown for as long as the engine's answer holds a preview body: after OK or Cancel it goes away with the answer for the
    // committed document, so the body never flashes out in between.
    viewport?.setPreview(previewBodies.length > 0 ? { bodies: previewBodies } : null);
  }, [viewport, previewBodies]);

  // An existing extrusion keeps its sketch: only the areas of that sketch are offered while it is edited.
  const offerOnly = extrudeState.mode === "edit" ? extrudeState.sketchId : null;
  useEffect(() => {
    if (!viewport || !extruding) return;
    viewport.setProfiles(offeredProfiles(catalogue, offerOnly));
    viewport.setPickKinds(["profile"]);
    const off = viewport.on("pick", (pick) => {
      const ref = pick ? profileRefOf(pick.ref) : null;
      if (ref) extrude.pick(ref);
    });
    return () => {
      off();
      viewport.setProfiles(null);
      viewport.setPickKinds(null);
      viewport.setSelection([]);
      viewport.setHover(null);
    };
  }, [viewport, extruding, catalogue, offerOnly, extrude]);
  useEffect(() => {
    if (!viewport || !extruding) return;
    viewport.setSelection(pickedProfile ? [entityOf(pickedProfile)] : []);
  }, [viewport, extruding, pickedProfile, catalogue, offerOnly]);

  // The arrow shows the dialog's distance and is dragged with the mouse; it is replaced, not cleared and set again, so a drag goes on.
  const symmetric = extrudeState.form.extent === "symmetric";
  const symmetricRef = useRef(symmetric);
  useEffect(() => {
    symmetricRef.current = symmetric;
  }, [symmetric]);
  useEffect(() => {
    if (!viewport) return;
    const entry = pickedProfile ? catalogue.find((e) => e.sketchId === pickedProfile.sketchId) : undefined;
    const area = entry?.profiles.find((p) => p.key === pickedProfile?.regionId);
    if (extrudeState.phase !== "dialog" || !entry || !area || !extrudeState.distance.ok) {
      viewport.setExtrudeHandle(null);
      return;
    }
    viewport.setExtrudeHandle(extrudeHandle(entry, area, signedDistance(extrudeState.form, extrudeState.distance.value).value, symmetric));
  }, [viewport, catalogue, pickedProfile, extrudeState.phase, extrudeState.form, extrudeState.distance, symmetric]);
  useEffect(() => {
    if (!viewport) return;
    return viewport.on("extrudeHandle", (distance) => extrude.dragHandle(handleToDistance(distance, symmetricRef.current)));
  }, [viewport, extrude]);

  // Esc cancels the command from anywhere in the window (a dialog on top, such as the settings, keeps its own Esc).
  useEffect(() => {
    if (!extruding) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.getElementById("root")?.hasAttribute("inert")) return;
      event.preventDefault();
      extrude.cancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [extruding, extrude]);
  // After an engine restart a preview that did not come is asked for again.
  useEffect(() => {
    if (engineReady) extrude.engineReady();
  }, [engineReady, extrude]);

  useEffect(() => {
    viewport?.setGridVisible(grid);
  }, [viewport, grid]);
  useEffect(() => {
    viewport?.setHiddenEdgesVisible(display === "shadedHidden");
  }, [viewport, display]);
  useEffect(() => {
    viewport?.setOriginVisible(true);
  }, [viewport]);

  // ---- navigation modes: a drag with the left button orbits, pans or zooms while a mode is on -----------------------------

  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  useEffect(() => {
    if (!navMode) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setNavMode(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navMode]);

  // ---- tree, timeline, history -----------------------------------------------------------------------------------------

  const toggle = (set: ReadonlySet<string>, id: string): Set<string> => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };

  const selectRow = (row: TreeRow) => {
    setSelectedTreeId(row.id);
    setSelectedStepId(row.featureId ?? null);
    setSelectedSubId(null);
  };

  const selectedLabel = useMemo(() => {
    const row = rows.find((r) => r.id === selectedTreeId);
    if (row) return row.label;
    const step = steps.find((s) => s.featureId === selectedStepId);
    return step?.label ?? null;
  }, [rows, steps, selectedTreeId, selectedStepId]);

  const showProblems = () => {
    const failures: Failure[] = failed.map((s) => {
      const name = doc.timeline.find((f) => f.id === s.featureId)?.name ?? s.featureId;
      const problem = s.problem;
      let text = problem?.message ?? "";
      if (problem) {
        try {
          text = problemText(t, problem, (id) => describeDocumentId(t, doc, id, language === "de"));
        } catch {
          text = problem.message;
        }
      }
      return {
        title: `${name}: ${text}`,
        code: `HC-STEP-${(problem?.code ?? s.state).toUpperCase()}`,
        ...(problem ? { error: new Error(problem.message) } : {}),
      };
    });
    void report(failures);
  };

  // Inside a sketch undo and redo reach back only as far as the steps made in it (history.ts); outside it is the document's.
  const canUndo = editor ? historyState.canUndo : !extruding && model.document.canUndo;
  const canRedo = editor ? historyState.canRedo : !extruding && model.document.canRedo;
  const undo = useCallback(() => {
    if (extrude.active) return; // a running extrusion is confirmed or cancelled first
    if (history) {
      if (history.undo()) sketchSession?.resetTool();
    } else model.undo();
  }, [history, sketchSession, model, extrude]);
  const redo = useCallback(() => {
    if (extrude.active) return;
    if (history) {
      if (history.redo()) sketchSession?.resetTool();
    } else model.redo();
  }, [history, sketchSession, model, extrude]);
  const undoRef = useRef(undo);
  const redoRef = useRef(redo);
  useEffect(() => {
    undoRef.current = undo;
    redoRef.current = redo;
  }, [undo, redo]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.defaultPrevented) return;
      // Text fields and dialogs keep Ctrl+Z; a checkbox of the sketch palette does not (it stays focused after a click).
      if (keysBelongToTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === "z" && !event.shiftKey) undoRef.current();
      else if (key === "y" || (key === "z" && event.shiftKey)) redoRef.current();
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const sketchLabel = editingFeature ? { name: editingFeature.name, planeLabel: planeLabels[editingFeature.plane.plane] } : null;

  return (
    <div className="flex h-full flex-col bg-bg text-fg" data-testid="main-window" aria-label={t("main.windowLabel")}>
      <TitleBar
        arrived={arrived}
        documentName={t("main.title.untitled")}
        unsaved={model.document.changeCount > 0}
        canUndo={canUndo}
        canRedo={canRedo}
        undoLimit={editor ? t("main.title.undoAtSketchStart") : extruding ? t("main.title.undoInCommand") : undefined}
        onUndo={undo}
        onRedo={redo}
        onSettings={() => setSettingsTab((tab) => tab ?? "display")}
      />
      <Toolbar
        tab={editor ? "sketch" : "body"}
        engineReady={engineReady}
        pickingPlane={pickingPlane}
        onSketch={() => {
          setNavMode(null);
          setPickingPlane((on) => !on);
        }}
        extruding={extruding}
        extrudeUnavailable={!engineReady ? t("main.toolbar.engineNotReady") : catalogue.length === 0 && !extruding ? t("main.toolbar.noProfile") : null}
        onExtrude={startExtrude}
        onFinishSketch={() => void finishSketch()}
        finishing={finishing}
        sketchTools={<SketchToolbar session={sketchSession} />}
      />
      <div className="relative flex min-h-0 flex-1" data-testid="work-area">
        <BrowserTree
          rows={rows}
          selectedId={selectedTreeId}
          pickingPlane={pickingPlane}
          editingFeatureId={editor?.sketchId ?? extrudeEditingId}
          onToggle={(id) => setTreeExpanded((s) => toggle(s, id))}
          onSelect={selectRow}
          onPickPlane={(plane) => void startSketch(plane)}
          onOpenSketch={(id) => void openSketch(id)}
          onOpenBody={openExtrude}
          onHoverPlane={hoverPlane}
        />
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <ContextBar componentName={componentName} sketch={sketchLabel} />
          <div
            className={cx("relative min-h-0 flex-1", navMode && "cursor-grab")}
            data-nav-mode={navMode ?? undefined}
            onPointerDownCapture={(event) => {
              if (!navMode || !viewport || event.button !== 0) return;
              if ((event.target as Element).closest("[data-testid='axis-navigator'],[data-overlay]")) return;
              event.preventDefault();
              event.stopPropagation();
              event.currentTarget.setPointerCapture(event.pointerId);
              drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
            }}
            onPointerMove={(event) => {
              const d = drag.current;
              if (!d || d.id !== event.pointerId || !viewport) return;
              const dx = event.clientX - d.x;
              const dy = event.clientY - d.y;
              d.x = event.clientX;
              d.y = event.clientY;
              if (navMode === "orbit") viewport.orbitBy(dx, dy);
              else if (navMode === "pan") viewport.panBy(dx, dy);
              else if (navMode === "zoom") viewport.zoomBy(Math.exp(dy * DRAG_SENSITIVITY_ZOOM));
            }}
            onPointerUp={(event) => {
              if (drag.current?.id !== event.pointerId) return;
              drag.current = null;
              if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onPointerCancel={() => {
              drag.current = null;
            }}
          >
            <ViewportView className="h-full w-full" axisLabels={settings.axisLabels} wheelZoom={settings.wheelZoom} onViewport={setViewport} />
            {pickingPlane ? (
              <div
                role="status"
                data-overlay=""
                data-testid="pick-plane-hint"
                className="absolute top-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-ctl border border-line-strong bg-surface px-3 py-1.5 text-[12.5px] font-medium shadow-card"
              >
                <span className="text-[16px] text-primary">
                  <Glyph name="plane" />
                </span>
                {t("main.context.pickPlane")}
                <span aria-hidden="true" className="h-4 w-px bg-line" />
                <kbd className="mono rounded-sm border border-line-strong px-1.5 text-[11px] text-muted">{t("main.context.pickPlaneKey")}</kbd>
              </div>
            ) : null}
            {extrudeState.phase === "pick" ? <PickProfileHint /> : null}
            {extrudeState.phase === "dialog" ? <ExtrudePanel command={extrude} state={extrudeState} profileLabel={extrudeProfileLabel} doc={doc} /> : null}
            {editor && sketchView && layer && sketchSession && sketchLabel ? (
              <SketchMode
                session={sketchSession}
                layer={layer}
                view={sketchView}
                options={layerOptions}
                name={sketchLabel.name}
                planeLabel={sketchLabel.planeLabel}
                colour={settings.sketchColour}
                fieldLook={settings.fieldLook}
                onShowConstraints={setShowConstraints}
                onShowDimensions={setShowDimensions}
                onFinish={() => void finishSketch()}
                finishing={finishing}
              />
            ) : null}
            <NavBar mode={navMode} onMode={setNavMode} onFit={() => viewport?.fitAll()} display={display} onDisplay={setDisplay} grid={grid} onGrid={setGrid} />
          </div>
        </div>
        {overlay}
      </div>
      <Timeline
        steps={steps}
        labels={settings.timelineLabels}
        componentName={componentName}
        expanded={timelineExpanded}
        selectedStepId={selectedStepId}
        selectedSubId={selectedSubId}
        editingId={editor?.sketchId ?? extrudeEditingId}
        onToggle={(id) => setTimelineExpanded((s) => toggle(s, id))}
        onSelectStep={(id) => {
          setSelectedStepId(id);
          setSelectedSubId(null);
          setSelectedTreeId(rows.find((r) => r.featureId === id && r.kind === "sketch")?.id ?? null);
        }}
        onSelectSub={(id, sub) => {
          setSelectedStepId(id);
          setSelectedSubId(`${id}/${sub}`);
        }}
        onOpenSketch={(id) => void openSketch(id)}
        onOpenExtrude={openExtrude}
      />
      <StatusBar
        selection={selectedLabel}
        editing={
          editingFeature
            ? t("main.status.sketchOpen", { name: editingFeature.name })
            : extrudeState.phase === "dialog" && extrudeState.name
              ? t("main.status.stepOpen", { name: extrudeState.name })
              : null
        }
        problemCount={failed.length}
        onProblems={showProblems}
      />
      <SettingsDialog tab={settingsTab} onTab={setSettingsTab} onClose={() => setSettingsTab(null)} />
    </div>
  );
}

