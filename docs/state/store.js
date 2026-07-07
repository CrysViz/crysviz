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
   currentlyHighlightedPolyhedron:null
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
};


// Defaults for everything the Visual window's Rendering section controls —
// the single source for both `general`'s initial values (spread below) and
// the "Reset rendering" button (ui/ColorPanel.js resetRenderingSettings).
export const RENDERING_DEFAULTS = {
  renderStyle: 'metallic', // 'metallic' | 'matte' | 'cel' — atom/bond material style
  renderPipeline: 'forward', // active rendering pipeline id (render/pipeline/index.js registry)
  depthPeelLayers: 5, // peel passes for the 'depthpeel' pipeline (1-10; more = deeper transparency, slower)
  rtResolutionScale: 0.75, // raytrace/pathtrace pipelines: internal resolution as a fraction of the canvas
  rtReflectivity: 0.15, // raytrace/pathtrace pipelines: extra mirror reflectivity on opaque surfaces (0-1)
  ptDenoise: true, // 'pathtrace' pipeline: edge-aware denoiser on the screen output
  ptLightSoftness: 0.3, // both tracers: light softness (0 = hard shadows, 1 = very soft; PT area-light radius / RT shadow-ray cone)
  rtDofAperture: 0, // both tracers: depth-of-field aperture in world units (0 = off)
  rtDofFocus: 1, // both tracers: focus distance as a factor of the camera->target distance
  rtGroundPlane: false, // both tracers: background-colored ground plane (shadow catcher)
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
  backendViewerUpdateStride:4, // Update the viewer every N backend/NEP steps during relax/MD
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
