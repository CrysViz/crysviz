import {StructureShip} from '../model/index.js'
import * as THREE from '../external/three/three.module.js';

export const bondLengths = {}

export const periodic ={
  wrapped:null,
  hash:null
}

//export const allAtoms=[]

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


//export const spinsData = [];

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
 // bondsGroup:null,
 // atomsGroup:null,
  latticeGroup:null,
 // spinGroup:null,
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
  matte:false,
  ForceMin:1e-4,
  ForceMax:2.5,
  BondMin:1.1,
  BondMax:4.5,
  autoRandomEnabled: false,
  powerMode: true,
  currentLatticeColor:null,
  defaultBackgroundColor:null,
  useDefaultColors:true,
  //defaultSpinColor:'#ff3366',
  //defaultSpinLength:1.0,
  //spinCoordSpace:'cart',
  //spinTextInput:'',
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
  showSecond:false,
  showSecondBonds:false,
  showComparisonInfo:false,
  showPeriodic:true,
  showPBCBonds:false, // Periodic image atoms + bonds across cell (off by default)
  useWasmMath:true, // Use compiled WASM for selected math kernels (false = pure JS fallback)
  useWasmPeriodic:false, // Use compiled WASM for periodicWrapped (false = pure JS fallback)
  backendViewerUpdateStride:4, // Update the viewer every N backend/NEP steps during relax/MD
  playerModeState: "none", 
  spinForceState: "none",
  structurePanelMode: "atoms",
  analysisState:"none",
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
