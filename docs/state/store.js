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
   currentlyHighlightedBond:null
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


export const general = {
  renderStyle: 'metallic', // 'metallic' | 'matte' | 'cel' — atom/bond material style
  celOutlineWidth: 0.05, // world-units black outline around atoms/bonds in cel style (0 = off)
  celOutlinePolyWidth: 0.05, // same, for polyhedra (separate control)
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
  bondRadius:0.08,
  forceScale: 1.0,
  forceRadius: 0.08,
  spinScale: 1.0,
  spinRadius: 0.08,
  atomSize:1.0,
  mainOpacity:1.0,
  compOpacity:1.0,
  showAtoms:true,
  showBonds:true,
  showLattice:true,
  showPolyhedra:false,
  showAxes:true,
  showSecond:false,
  showSecondBonds:false,
  showComparisonInfo:false,
  showPeriodic:true,
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
  abondsColorMap: null,
  atomsColor: "elements",
  atomsColorMaps: null,
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
