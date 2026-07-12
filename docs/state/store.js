import {StructureShip} from '../model/index.js'

export const bondLengths = {}

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
  comparisonRow:null,
  comparisonRowIndex:-1,
  comparisonStructure:null,
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
  bondsMesh: null,
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
  powerMode: true,
  currentLatticeColor:null,
  defaultBackgroundColor:null,
  useDefaultColors:true,
  // "Element Materials Map" (Visual → Colors): per-species tracer-material
  // presets. 'crysviz' = defaults/material_defaults.js crysvizMaterialMap,
  // 'standard' = no presets (plain standard material everywhere). Resolved by
  // Structure.getDefaultElementMaterial below manual atomMaterials edits.
  elementMaterialsMap:'crysviz',
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
  atomSize:1.0,
  mainOpacity:1.0,
  compOpacity:1.0,
  showAtoms:true,
  showBonds:true,
  showLattice:true,
  showPolyhedra:false,
  showAxes:true,
  // Shaft radius of the a/b/c axes-gizmo arrows, in gizmo-scene units
  // (WindowAndSceneControls.initAxesGizmo; arrow length is 1).
  axesLineWidth:0.015,
  // Cylinder radius of the unit-cell outline edges, in world units (Å)
  // (LatticeModule.createLatticeLines).
  latticeLineWidth:0.015,
  showSecond:false,
  showSecondBond:false, // comparison-structure bonds visibility (was misspelled `showSecondBonds`)
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
  // Feature activation flags, set by the toggles in the unified "Features"
  // window (ui/panels/defaultPanels.js) — NOT by panel expand state. When a
  // flag is off the corresponding feature panel is greyed out.
  forcesActive: false, // "Show Forces" toggle draws force arrows
  spinsActive: false, // "Show Spins" toggle draws spin arrows
  fieldActive: true, // "Show Volumetric Field" toggle draws the isosurface
  comparisonActive: false, // "Show Lattice Comparison" keeps the popup synced
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
  measureMode:'none', // 'none', 'distance', 'angle', 'delete' 
  overlayMode:'none', // 'none', comparison, trajectory_force,  trajectory_spin
};


// Optional style defaults
export const polyStyle = {
  FACE_OPACITY: 0.80,
};
