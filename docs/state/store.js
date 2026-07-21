import {StructureShip} from '../model/index.js'

export const bondLengths = {}

// Per-element coordination-number data for the Coordination Number
// histogram (docs/ui/AnalysisPanels/CoordinationHistogram.js): element ->
// [{ cn, atomIndex }, ...], one entry per atom of that element. Populated
// alongside bondLengths in docs/render/BondsFracUpdateModule.js.
export const coordinationNumbers = {}

export const periodic ={
  wrapped:null,
  hash:null
}

export const usedIDs = new Set();

export const fileBrowser = {
  fileData:[],
  selectedRow:null,
  selectedRowIndex:0,
  selectedStructure:null,
  // Shared engine behind both the classic Comparison panel (ui/ComparisonPanel.js,
  // general.compareModeOn, exactly one entry) and the Multi-Structure Overlay
  // panel (ui/OverlayPanel.js, general.overlayModeOn, any number of entries) —
  // the two modes are mutually exclusive (see syncOverlayFromCheckboxes in
  // ui/FileBrowswerPanel.js), so there is only ever one active consumer of this
  // array at a time. Each entry: { key (stable string id, also used as the
  // render mesh registry key in groups.overlayMeshes), row (the <tr> element,
  // the source of truth — rowIndex is re-derived from it), structure, opacity
  // (0-1, independent per overlay), showBonds (bool) }.
  overlayEntries:[],
  stepInput:null,
}

export const structureShip = new StructureShip();

export const highlightHover ={
   hoveredAtom:null,
   currentlyHighlightedAtom:null,
   currentlyHighlightedRow:null,
   currentlyHighlightedRows:[],
   currentlyHighlightedBond:null,
   currentlyHighlightedPolyhedron:null,
   // Instance ids currently glowing (recorded by SelectAndHighlightModule) so the
   // ray/path tracers can draw them as a post-present overlay and clear them
   // without a full mesh rebuild (which would restart the accumulation).
   currentlyHighlightedAtomInstances:[],
   currentlyHighlightedBondInstances:[]
};

export const atomSelection = {
  selectedAtoms: [],
  subscribers: new Set(),
};

export const measurements ={
  measureLines: [],           // Array to store multiple measurement lines
  measureLabels: [],          // Array to store multiple measurement labels
  selectedAtoms: []
};


export const app = {
  clock:null,
  angularVelocity:null,
  renderer: null,
  pipeline: null, // active rendering pipeline instance (render/pipeline/index.js)
  scene: null,
  camera: null,
  controls: null,
  labelRenderer:null,
  gizmoScene:null,
  gizmoRenderer:null,
  gizmoCamera:null,
  useOrthographicCamera:true,
  defaultZoomScale:0.75,
  orthographicFrustumSize:null,
  keyLight:null,
  // When true, an offscreen capture (PNG export, render/ImageExportModule.js)
  // owns the renderer: the AnimateModule loop skips its pipeline/gizmo/label
  // passes so the export is the SOLE render driver. Without this the animate
  // loop's interactive tracer frames fight the export's paced renders and reset
  // the accumulation (the "4/8/4" progress oscillation). Set around the whole
  // capture and cleared in captureSceneToPng's finally.
  offscreenRenderHold:false,
};

export const groups = {
  polyhedraGroup:null,
  latticeGroup:null,
  atomsMesh: null,
  ghostAtomsMesh: null, // render/GhostAtomsModule.js — hidden-atom ghosts, hide mode only
  bondsMesh: null,
  // Structure Overlay module: one { atomsMesh, bondsMesh } per fileBrowser.overlayEntries
  // entry, keyed by that entry's `key`. See render/CompAtomsFracUpdateModule.js /
  // CompBondsFracUpdateModule.js (build/update/dispose) and MaterialStyles.js
  // (cel-hull outline width) for the other places that iterate this map.
  overlayMeshes: new Map(),
  forcesShaftMesh: null,
  forcesTipMesh: null,
  spinShaftMesh: null,
  spinTipMesh: null,
  fieldGroup: null,
  fieldMeshPos: null,
  fieldMeshNeg: null,
  activeField: null,
  isosurfaceGroup: null,
  groundMesh: null, // persistent raster ground-plane disc (render/GroundPlaneModule.js); a scene fixture drawn by every raster/preview frame, visually matched to the tracers' analytic disc
};


// Defaults for everything the Visual window's Rendering section controls —
// the single source for both `general`'s initial values (spread below) and
// the "Reset rendering" button (ui/ColorPanel.js resetRenderingSettings).
export const RENDERING_DEFAULTS = {
  renderStyle: 'metallic', // 'metallic' | 'matte' | 'cel' — atom/bond material style
  renderPipeline: 'depthpeel', // active rendering pipeline id; depthpeel self-optimizes to a plain forward pass when the scene has no transparency (DepthPeelPass fast path)
  showAllRenderPipelines: false, // HIDDEN (config-only, no GUI): list superseded/debug pipelines in the rendering dropdown
  depthPeelLayers: 5, // peel passes for the 'depthpeel' pipeline (1-10; more = deeper transparency, slower)
  rtResolutionScale: 0.95, // raytrace/pathtrace pipelines: internal resolution as a fraction of the canvas
  rtTiledRender: true, // raytrace/pathtrace: render each sample in scissored tiles (one/frame) to keep the shared GPU responsive; untiled half-res while the camera moves
  rtReflectivity: 0.15, // raytrace/pathtrace pipelines: extra mirror reflectivity on opaque surfaces (0-1)
  rtRasterPreview: true, // raytrace/pathtrace: while interacting, show cheap depth-peeled preview frames; resume tracing after rest
  rtBackgroundMatch: true, // both tracers: pin the traced backdrop to the exact picked background color (inverse tone-map on primary misses); off = classic look, backdrop tone-mapped with the scene
  rtToneMapLegacy: false, // both tracers: legacy Reinhard tone mapping (the original muted tracer look) instead of exposure x ACES (raster parity)
  rtPreviewRestDelay: 0.5, // HIDDEN (config-only, no GUI): raytrace/pathtrace seconds of no interaction before the tracer resumes (raster-preview rest delay)
  ptDenoise: true, // 'pathtrace' pipeline: edge-aware denoiser on the screen output
  ptLightSoftness: 0.3, // both tracers: light softness (0 = hard shadows, 1 = very soft; PT area-light radius / RT shadow-ray cone)
  rtDofAperture: 0, // both tracers: depth-of-field aperture in world units (0 = off)
  rtDofFocus: 1, // both tracers: focus distance as a factor of the camera->target distance
  // Ground plane (all pipelines): the tracers draw an analytic disc; the raster
  // pipelines + preview frames draw a visually-matched raster disc mesh via
  // render/GroundPlaneModule.js. Keys keep their rt* names for persistence
  // compatibility (they predate the raster mesh); rtGroundReflect is tracer-only.
  rtGroundPlane: false, // all pipelines: ground plane on/off (raster disc + tracer shadow catcher)
  rtGroundPattern: 'solid', // 'solid' | 'checker' | 'grid'
  rtGroundColor1: null, // hex or null = follow the background color
  rtGroundColor2: null, // hex or null = auto (darkened color1)
  rtGroundScale: 2, // pattern tile size in world units (Å)
  rtGroundOffset: 0.75, // distance from the structure bottom to the plane (all pipelines)
  rtGroundSize: 2.5, // ground disc radius in multiples of the structure radius (all pipelines)
  rtGroundReflect: 0, // ground mirror fraction (0 = matte ... 1 = mirror floor); TRACER-ONLY
  rtLightIntensity: 1.2, // both tracers: key-light intensity multiplier
  rtAmbient: 0.3, // both tracers: ambient/fill light strength (RT ambient term / PT sky bounce)
  rtSaturation: 1, // both tracers: post-tone-map saturation grade (output pass; 1 = neutral)
  celOutlineMode: 'screen', // cel outlines: 'screen' (post-process) | 'hull' (inverted-hull geometry)
  celOutlineWidth: 0.025, // screen-space outline width in world units (0 = off)
  celHullWidth: 0.025, // hull outline width in world units, atoms/bonds (0 = off)
  celHullPolyWidth: 0.025, // hull outline width in world units, polyhedra
};

export const general = {
  ...RENDERING_DEFAULTS,
  polyEdgeWidth: 1, // polyhedra edge line thickness in pixels (fat lines; 1 = classic hairline)
  ForceMin:1e-4,
  ForceMax:2.5,
  BondMin:1.1,
  BondMax:4.5,
  autoRandomEnabled: false,
  // moyo's symmetry tolerance (symprec) in Å — the Symmetry panel's Tolerance
  // box starts here and writes back, so the value survives panel rebuilds and
  // structure switches, and every internal analysis uses the same number the
  // user sees (ui/SymmetryEditModule.js's defaultSymprec()).
  symmetryTolerance: 0.01,
  powerMode: true,
  currentLatticeColor:null,
  defaultBackgroundColor:null,
  useDefaultColors:true,
  // "Element Materials Map" (Visual → Colors): per-species tracer-material
  // presets. 'crysviz' = defaults/material_defaults.js crysvizMaterialMap,
  // 'standard' = no presets (plain standard material everywhere). Resolved by
  // Structure.getDefaultElementMaterial below manual atomMaterials edits.
  elementMaterialsMap:'crysviz',
  // Sparse per-element overrides from the Custom User Settings panel (loaded
  // JSON or picked interactively) - element -> 0xRRGGBB / element -> radius
  // in Å. Only elements the user has actually touched are present; anything
  // else falls back to the built-in scheme (see
  // defaults/color_texture_defaults.js's getElementDefaultColor and
  // defaults/radii_defaults.js's getElementRadius).
  customColorMap:{},
  customAtomicRadii:{},
  // Bookkeeping-only sparse record of which bond pairs the user has
  // explicitly overridden via the Custom User Settings panel (for JSON
  // export/persistence) - the actual live values also live in bondLengths
  // below, which is what the render pipeline consults.
  customBondLengths:{},
  bondLengths:{},
  defaultBondLengths:{},
  bondVisibility:{},
  // Per-element atom visibility (Atoms tab header checkbox): element -> bool;
  // undefined/true = shown. Hidden elements are zero-scaled (also unpickable).
  atomVisibility:{},
  // Per-element spin-arrow visibility (Spins panel toggles): element -> bool.
  // Was written by SpinPanel without ever being initialized (latent crash).
  speciesVisibility:{},
  // Per-pair bond cut-plane immunity (Bonds tab header toggle): "El1-El2" ->
  // bool; true = the pair's bonds are never culled by cut planes.
  bondCutImmunity:{},
  // Incremented on every buildBondObjects() run; expanded per-bond row lists in the
  // Bonds tab compare against it to know their cached rows are stale.
  bondsBuildCounter:0,
  // Same for polyhedra: incremented whenever the displayed polyhedra group is
  // replaced (async rebuild swap or clear), used by the Poly tab's lazy lists.
  polyhedraBuildCounter:0,
  bondRadius:0.08,
  forceScale: 1.0,
  forceRadius: 0.08,
  spinScale: 1.0,
  spinRadius: 0.08,
  // Spin colormap range (Spins panel min/max inputs; read with ||-defaults).
  spinMin: 0,
  spinMax: 2,
  // Spins panel Color Map dropdown selection, mirroring forceColorMap below
  // (persisted so a panel rebuild — file change, collapse/reopen — restores
  // the user's last choice instead of resetting to "None").
  spinColorMap: 'none',
  // Spin arrow LENGTH normalization (Spins panel "log length" toggle),
  // independent of spinColorScale — same one-directional lock as
  // forceLengthLogScale above (render/SpinModule.js's normalizeMag()).
  spinLengthLogScale: false,
  // Force colormap range (Forces panel min/max inputs; read with ||-defaults).
  forceMin: 0,
  forceMax: 2,
  // Force colormap normalization: 'linear' | 'log' (Forces panel Log Scale toggle).
  forceColorScale: 'linear',
  // Custom legend text for the Forces color bar (ForcePanel.js), falls back
  // to "Force (eV/Å)" when unset.
  forceLegendText: null,
  // Spin colormap normalization: 'linear' | 'log' (Spins panel Log Scale
  // toggle), same role as forceColorScale above but for SpinModule.js.
  spinColorScale: 'linear',
  // Custom legend text for the Spins color bar (SpinPanel.js), falls back
  // to "Spin (μB)" when unset.
  spinLegendText: null,
  // Atoms "Force" mode colormap normalization: 'linear' | 'log' (ColorPanel.js
  // Log Scale toggle for the atom color bar).
  atomColorScale: 'linear',
  // Custom legend text for the Atoms color bar (ColorPanel.js), falls back
  // to "Atom Force (eV/Å)" when unset.
  atomLegendText: null,
  // Bonds "Length" mode colormap normalization: 'linear' | 'log' (ColorPanel.js
  // Log Scale toggle for the bond color bar).
  bondColorScale: 'linear',
  // Custom legend text for the Bonds color bar (ColorPanel.js), falls back
  // to "Bond Length (Å)" when unset.
  bondLegendText: null,
  // Force arrow LENGTH normalization (Forces panel "log length" toggle),
  // independent of forceColorScale above — but turning it on also forces
  // forceColorScale to 'log' and locks that toggle, since a log-length arrow
  // next to a linear color scale would disagree about what a given force
  // magnitude looks like. See render/ForceModule.js's normalizeMag().
  forceLengthLogScale: false,
  // Forces panel Color Map dropdown selection (persisted so trajectory/MD
  // playback and structure switches redraw with the user's last choice —
  // there is no "None" option, forces always render through a colormap).
  forceColorMap: 'heatmap',
  // Force/Spin color bar layout (ui/ColorBarWidget.js, ui/ColorBarDrag.js):
  // orientation and floating position live only inside that widget's own
  // closures, so a panel rebuild (file change, collapse/reopen, colormap
  // switch) throws them away unless captured here first. Captured in
  // ForcePanel.js/SpinPanel.js right before the live instance is torn down,
  // restored when the next instance is built. *FloatPos holds an anchor
  // ({edgeX, offsetX, edgeY, offsetY} — offsets from #view's edges, from
  // ColorBarDrag.js's getAnchor()/floatAtAnchor()), not raw left/top: #view
  // can shift during a file reload's own transient layout changes between
  // capture and restore, and a raw pixel target wouldn't track that.
  forceColorBarOrientation: 'horizontal',
  forceColorBarFloating: false,
  forceColorBarFloatPos: null,
  spinColorBarOrientation: 'horizontal',
  spinColorBarFloating: false,
  spinColorBarFloatPos: null,
  // Same trio for the Atoms ("Force" mode) and Bonds ("Length" mode) color
  // bars in ColorPanel.js, which now share the same ColorBarWidget.js as
  // Forces/Spins. ForceMin/ForceMax and BondMin/BondMax (above) already hold
  // the atom/bond range state; these three just cover layout/position.
  atomColorBarOrientation: 'horizontal',
  atomColorBarFloating: false,
  atomColorBarFloatPos: null,
  bondColorBarOrientation: 'horizontal',
  bondColorBarFloating: false,
  bondColorBarFloatPos: null,
  // Same trio for the Planes panel's colorbar (PlanesPanel.js).
  planeColorBarOrientation: 'horizontal',
  planeColorBarFloating: false,
  planeColorBarFloatPos: null,
  // Side the legend/tick labels render on, independent of orientation: the
  // "far" edge (below the bar in horizontal, right of it in vertical — the
  // original/default) or the "near" edge (above/left). Shared by all four
  // color bars via the hamburger menu's Flip Side item.
  forceColorBarFlipSide: false,
  spinColorBarFlipSide: false,
  atomColorBarFlipSide: false,
  bondColorBarFlipSide: false,
  planeColorBarFlipSide: false,
  // Length (px) a floating color bar's drag handle resizes to — shared by
  // all four bars (resizing any one resizes them all, ColorBarWidget.js's
  // setSize broadcasting via ColorBarRegistry.js), rather than a separate
  // size per bar. null uses the widget's own default.
  colorBarSize: null,
  atomSize:1.0,
  mainOpacity:1.0,
  showAtoms:true,
  showBonds:true,
  showLattice:true,
  showPolyhedra:false,
  showAxes:true,
  // Shaft radius of the a/b/c axes-gizmo arrows, in gizmo-scene units
  // (WindowAndSceneControls.initAxesGizmo; arrow length is 1).
  axesLineWidth:0.015,
  // Position of the draggable gizmo+legend overlay (GizmoDrag.js), captured
  // as an edge anchor relative to #view — same scheme as the color bars'
  // *ColorBarFloatPos fields — or null to use the CSS default (bottom-left).
  gizmoPos: null,
  // When true, the a/b/c letters render as billboarded sprites at each
  // arrow's tip inside the gizmo's own 3D scene instead of in the separate
  // #axesLegend box (WindowAndSceneControls.initAxesGizmo).
  gizmoLabelsOnArrows: false,
  // Side length in px of the #axesGizmo box (ui/GizmoDrag.js's resize
  // handle), or null to use the CSS default (--gizmo-size, theme.css).
  gizmoSize: null,
  // Cylinder radius of the unit-cell outline edges, in world units (Å)
  // (LatticeModule.createLatticeLines).
  latticeLineWidth:0.015,
  showComparisonInfo:false,
  showPeriodic:true,
  // Atoms tab: edit all periodic-image copies of an atom together. When false
  // the list shows one row per on-screen copy and edits apply per copy
  // (structure.atomImageStyles). Wyckoff mode is unaffected.
  linkPeriodicCopies:true,
  // Tolerance (fractional coords) for treating an atom as sitting on a cell
  // face/edge/corner when generating periodic image copies. Real (e.g. relaxed
  // / DFT-output) structures carry small numerical offsets from 0/1, so this
  // must be much looser than machine eps or boundary atoms get missed.
  periodicFaceTol:1e-3,
  showPBCBonds:false, // Periodic image atoms + bonds across cell (off by default)
  completePolyhedra:false, // Show the out-of-cell atoms needed to complete the polyhedra
  useWasmMath:true, // Use compiled WASM for selected math kernels (false = pure JS fallback)
  useWasmPeriodic:true, // Use compiled WASM for periodicWrapped (false = pure JS fallback)
  useWasmPolyhedra:true, // Use compiled WASM for computePolyhedra (false = pure JS fallback)
  useWasmBonds:true, // Use compiled WASM (cell list) for neighbour-bond pair finding (false = JS O(n²))
  serialPolyhedraAlgorithm:false, // true = single-threaded WASM; false = parallel over Web Workers
  backendViewerUpdateStride:1, // Update the viewer every N backend/NEP steps during relax/MD
  backendTrajectorySaveStride:4, // Save a trajectory snapshot every N steps during relax/MD
  // Console profile of the MD/relax loop: when true, runMDSimulation prints a
  // per-run breakdown (force eval vs integration vs viewer vs rAF wait, ms and
  // % of wall clock) plus steps/s. Set general.mdProfile = true from the
  // console before starting a run. Off by default — the timers themselves are
  // cheap, but the logging is noise for anyone not chasing frame rate.
  mdProfile:false,
  // Run the NEP potential in workers/nepWorker.js instead of on the main
  // thread during MD. Set false to force the in-thread path (the worker also
  // holds its own copy of the 14.9 MB model, so it costs memory).
  mdWorker:true,
  // Feature activation flags, set by the toggles in the unified "Features"
  // window (ui/panels/defaultPanels.js) — NOT by panel expand state. When a
  // flag is off the corresponding feature panel is greyed out.
  forcesActive: false, // "Show Forces" toggle draws force arrows
  // Force histogram (ui/AnalysisPanels/ForceHistogram.js) "Live during MD"
  // toggle: redraw the histogram every MD/relax step instead of only when
  // idle (stats computation isn't free, hence opt-in).
  forceStatsLive: false,
  spinsActive: false, // "Show Spins" toggle draws spin arrows
  fieldActive: true, // "Show Volumetric Field" toggle draws the isosurface
  comparisonActive: false, // "Show Lattice Comparison" keeps the lattice popup synced (shared by both panels below)
  // Master "Enable Comparison" toggle (classic Comparison panel, ui/ComparisonPanel.js):
  // exactly one checked file-browser row becomes the comparison structure, with
  // the Main/Comp crossfade slider. Mutually exclusive with overlayModeOn below
  // (turning one on turns the other off) — both drive fileBrowser.overlayEntries
  // via the same checkboxes, so only one can interpret them at a time. See
  // ui/FileBrowswerPanel.js's syncOverlayFromCheckboxes.
  compareModeOn: false,
  // Comparison panel's "Show Comparison Bonds" toggle — the sole entry's
  // showBonds default (and live value, since there's only ever one entry).
  showSecondBond: true,
  // Master "Enable Overlay" toggle (Multi-Structure Overlay panel,
  // ui/OverlayPanel.js): any number of checked rows become independent overlay
  // entries, each with its own opacity/bonds toggle in a scrollable table.
  overlayModeOn: false,
  structurePanelMode: "atoms",
  backendState:"none",
  atomisticPotential:"nep",
  currentSupercell: null,
  modifiedLattice: null, // this needs to be part of the structure object 
  sharedStructureLoaded:false,
  bondsColor: "elements",
  solidBondColor: "#ffffff", // Bonds "Solid Color" mode picker value
  bondsColorMap: null, // Bonds "Length" mode colormap id (was misspelled `abondsColorMap`)
  atomsColor: "elements",
  atomColorMap: null, // Atoms "Force" mode colormap id (was misspelled `atomsColorMaps`)
  atomCutPlanes: [],
};



export const mode = {
  measureMode:'none', // 'none', 'distance', 'angle', 'hide', 'restore'
  overlayMode:'none', // 'none', comparison, trajectory_force,  trajectory_spin
};


// Optional style defaults
export const polyStyle = {
  FACE_OPACITY: 0.80,
};
