import {StructureShip} from './classes/StructureShip.js'
import * as THREE from './backend/three/three.module.js';
export const bondLengths = {}

export const allAtoms=[]

export const fileBrowser = { 
  fileData:[],
  selectedRow:null, 
  selectedRowIndex:0,
  selectedStructure:null,
  stepInput:null,
}  

export const structureShip = new StructureShip();

export const highlightHover ={
   hoveredAtom:null,
   currentlyHighlightedAtom:null,
   currentlyHighlightedRow:null,
   currentlyHighlightedBond:null
};

export const measurements ={
  measureLines: [],           // Array to store multiple measurement lines
  measureLabels: [],          // Array to store multiple measurement labels
  selectedAtoms: []
};


export const spinsData = [];

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
  bondsGroup:null,
  atomsGroup:null,
  latticeGroup:null,
  spinGroup:null,
  atomsMesh: null,
  bondsMesh: null,
}


export const general = {  
  matte:false,
  ForceMin:1e-4,
  ForceMax:2.5,
  BondMin:1.1,
  BondMax:4.5,
  autoRandomEnabled: false,
  powerMode: false,
  currentLatticeColor:null,
  defaultBackgroundColor:null,
  currentLatticeColor:null,
  userColorOverrides:[],  // userColorOverrides and individualAtomColors need to be overwritten with the new colors in the object containing the atoms
  individualAtomColors:[],
  useDefaultColors:true,
  //defaultSpinColor:'#ff3366',
  //defaultSpinLength:1.0,
  //spinCoordSpace:'cart',
  //spinTextInput:'',
  bondLengths:{},
  defaultBondLengths:{},
  bondVisibility:{},
  bondRadius:0.08,
  atomSize:1.0,
  structure2OpacityValue: 0.5,
  mainOpacity:1.0,
  secondOpacity:1.0,
  showBonds:true,
  showLattice:true,
  showPolyhedra:false,
  showSecond:false,
  showComparisonInfo:false,
  showPeriodic:true,
  showPBCBonds:false, // Periodic image atoms + bonds across cell (off by default)
  playerModeState: "none", 
  spinForceState: "none",
  analysisState:"none",
  backendState:"none",
  currentSupercell: null,
  modifiedLattice: null, // this needs to be part of the structure object 
  sharedStructureLoaded:false,
  bondsColor: null,
  bondsColorMap: null,
  atomsColor: null,
  atomsColorMaps: null,
};



export const mode = {
  measureMode:'none', // 'none', 'distance', 'angle', 'delete' 
  overlayMode:'none', // 'none', comparison, trajectory_force,  trajectory_spin
};


// Default complex structure (Ba2YCu3O7) - high-Tc superconductor with 4 elements to test collapsible composition
export const defaultPOSCAR1 = `Ba2YCu3O7 - YBCO Superconductor
1.0
3.82 0.00 0.00
0.00 3.89 0.00
0.00 0.00 11.68
Ba Y Cu O
2 1 3 7
Direct
0.5 0.5 0.184
0.5 0.5 0.816
0.5 0.5 0.5
0.0 0.0 0.356
0.0 0.0 0.644
0.0 0.5 0.0
0.5 0.0 0.0
0.0 0.5 0.378
0.5 0.0 0.378
0.0 0.5 0.622
0.5 0.0 0.622
0.0 0.0 0.159
0.0 0.0 0.841`;
export const defaultPOSCAR = `
From DOI: 10.1126/sciadv.aay8361
1.0
        4.6090002060         0.0000000000         0.0000000000
        0.0000000000         4.6090002060         0.0000000000
        0.0000000000         0.0000000000         4.6090002060
   Sr    C    B
    2    6    6
Direct
     0.500000000         0.500000000         0.500000000
     0.000000000         0.000000000         0.000000000
     0.000000000         0.250000000         0.500000000
     0.000000000         0.750000000         0.500000000
     0.500000000         0.000000000         0.250000000
     0.500000000         0.000000000         0.750000000
     0.250000000         0.500000000         0.000000000
     0.750000000         0.500000000         0.000000000
     0.250000000         0.000000000         0.500000000
     0.750000000         0.000000000         0.500000000
     0.500000000         0.250000000         0.000000000
     0.500000000         0.750000000         0.000000000
     0.000000000         0.500000000         0.250000000
     0.000000000         0.500000000         0.750000000`;




// Atomic data
export const atomicRadii = {
  H: 0.8, He: 1.0, Li: 1.28, Be: 0.96, B: 0.84, C: 0.76, N: 0.71, O: 0.66, F: 0.57, Ne: 0.58,
  Na: 1.66, Mg: 1.41, Al: 1.21, Si: 1.11, P: 1.07, S: 1.05, Cl: 1.02, Ar: 1.06,
  K: 2.03, Ca: 1.76, Sc: 1.70, Ti: 1.60, V: 1.53, Cr: 1.39, Mn: 1.39, Fe: 1.32, Co: 1.26, Ni: 1.24,
  Cu: 1.32, Zn: 1.22, Ga: 1.22, Ge: 1.20, As: 1.19, Se: 1.20, Br: 1.20, Kr: 1.16,
  Rb: 2.20, Sr: 1.95, Y: 1.90, Zr: 1.75, Nb: 1.64, Mo: 1.54, Tc: 1.47, Ru: 1.46, Rh: 1.42, Pd: 1.39,
  Ag: 1.45, Cd: 1.44, In: 1.42, Sn: 1.39, Sb: 1.39, Te: 1.38, I: 1.39, Xe: 1.40,
  Cs: 2.44, Ba: 2.15, La: 2.07, Ce: 2.04, Pr: 2.03, Nd: 2.01, Pm: 1.99, Sm: 1.98, Eu: 1.98, Gd: 1.96,
  Tb: 1.94, Dy: 1.92, Ho: 1.92, Er: 1.89, Tm: 1.90, Yb: 1.87, Lu: 1.87,
  Hf: 1.75, Ta: 1.70, W: 1.62, Re: 1.51, Os: 1.44, Ir: 1.41, Pt: 1.36, Au: 1.36, Hg: 1.32,
  Tl: 1.45, Pb: 1.46, Bi: 1.48, Po: 1.40, At: 1.50, Rn: 1.50
}; // atomic radii in angstroms

export const jmolColorMap = {
  H: 0xffffff, He: 0xd9ffff, Li: 0xcc80ff, Be: 0xc2ff00, B: 0xffb5b5, C: 0x909090, N: 0x3050f8, O: 0xff0d0d,
  F: 0x90e050, Ne: 0xb3e3f5, Na: 0xab5cf2, Mg: 0x8aff00, Al: 0xbfa6a6, Si: 0xf0c8a0, P: 0xff8000, S: 0xffff30,
  Cl: 0x1ff01f, Ar: 0x80d1e3, K: 0x8f40d4, Ca: 0x3dff00, Sc: 0xe6e6e6, Ti: 0xbfc2c7, V: 0xa6a6ab, Cr: 0x8a99c7,
  Mn: 0x9c7ac7, Fe: 0xe06633, Co: 0xf090a0, Ni: 0x50d050, Cu: 0xc88033, Zn: 0x7d80b0, Ga: 0xc28f8f, Ge: 0x668f8f,
  As: 0xbd80e3, Se: 0xffa100, Br: 0xa62929, Kr: 0x5cb8d1, Rb: 0x702eb0, Sr: 0x00ff00, Y: 0x94ffff, Zr: 0x94e0e0,
  Nb: 0x73c2c9, Mo: 0x54b5b5, Tc: 0x3b9e9e, Ru: 0x248f8f, Rh: 0x0a7d8c, Pd: 0x006985, Ag: 0xc0c0c0, Cd: 0xffd98f,
  In: 0xa67573, Sn: 0x668080, Sb: 0x9e63b5, Te: 0xd47a00, I: 0x940094, Xe: 0x429eb0, Cs: 0x57178f, Ba: 0x00c900,
  La: 0x70d4ff, Ce: 0xffffc7, Pr: 0xd9ffc7, Nd: 0xc7ffc7, Pm: 0xa3ffc7, Sm: 0x8fffc7, Eu: 0x61ffc7, Gd: 0x45ffc7,
  Tb: 0x30ffc7, Dy: 0x1fffc7, Ho: 0x00ff9c, Er: 0x00e675, Tm: 0x00d452, Yb: 0x00bf38, Lu: 0x00ab24, Hf: 0x4dc2ff,
  Ta: 0x4da6ff, W: 0x2194d6, Re: 0x267dab, Os: 0x266696, Ir: 0x175487, Pt: 0xd0d0e0, Au: 0xffd123, Hg: 0xb8b8d0,
  Tl: 0xa6544d, Pb: 0x575961, Bi: 0x9e4fb5, Po: 0xab5c00, At: 0x754f45, Rn: 0x428296
};


export function getAtomVisSettings(opacity=1.0) {
  // Convert to THREE.Color
  if (general.matte) {
    return {
      transparent: opacity !== 1.0,
      roughness: 1.0,
      metalness: 0.3,
      clearcoat: 0.5,
      clearcoatRoughness: 1.0,
    };
  } else {
    return {
      opacity,
      transparent: opacity !== 1.0,
      roughness: 0.2,
      metalness: 0.3,
      clearcoat: 0.5,
      clearcoatRoughness: 0.2,
    };
  }
};

export function  getBondVisSettings(color,opacity=1) {
    if (general.matte){
     return {
      color,
      opacity,
      transparent: opacity !== 1.0,
      roughness: 1.0,
      metalness: 0.3,
      clearcoat: 0.5,
      clearcoatRoughness: 1.0,
    };
  }
  else{
    return {
      color,
      opacity,
      transparent: opacity !== 1.0,
      roughness: 0.2,
      metalness: 0.3,
      clearcoat: 0.5,
      clearcoatRoughness: 0.2,
    };
  }
};




export function getLatticeVisSettings(color) {
    return{
    color: color,
    transparent: false,
    opacity: 1.0,
    linewidth: 3
    };
  };


export const defaultColorMap = {
  H:  0xffcccc,
  D:  0xccccff,
  He: 0xfce9d0,
  Li: 0x87e07a,
  Be: 0x5ef6c1,
  B:  0x20a332,
  C:  0x814839,
  N:  0xb1bad6,
  O:  0xff0300,
  F:  0xb1bad6,
  Ne: 0xff37b4,
  Na: 0xf9dd3d,
  Mg: 0xfce27a,
  Al: 0x81b3d6,
  Si: 0x1b3bfa,
  P:  0xc18fa3,
  S:  0xffff00,
  Cl: 0x31fc03,
  Ar: 0xd2ffa4,
  K:  0xa123f7,
  Ca: 0x5b96bd,
  Sc: 0xb57dab,
  Ti: 0x789efb,
  V:  0xe60000,
  Cr: 0x00009e,
  Mn: 0xa90b9f,
  Fe: 0xb5b271,
  Co: 0x0000af,
  Ni: 0xb8b9bd,
  Cu: 0x223fdc,
  Zn: 0x8f8f81,
  Ga: 0x9fb4b7,
  Ge: 0x7f6faa,
  As: 0x75d057,
  Se: 0x9acf0f,
  Br: 0x7e3102,
  Kr: 0xf9c1f4,
  Rb: 0xff0099,
  Sr: 0x00ff26,
  Y:  0x679960,
  Zr: 0x00ff00,
  Nb: 0x4cbc76,
  Mo: 0xb4868f,
  Tc: 0xcdafca,
  Ru: 0xcfb7ad,
  Rh: 0xcdbfab,
  Pd: 0xc1c4b9,
  Ag: 0xb8b9bd,
  Cd: 0xf3f4dc,
  In: 0xd680bb,
  Sn: 0x9b8fba,
  Sb: 0xd78250,
  Te: 0xadd42f,
  I:  0x8e1f8b,
  Xe: 0x9aa1f8,
  Cs: 0x0efcb9,
  Ba: 0x1ee05a,
  La: 0x5ac431,
  Ce: 0xd1fc06,
  Pr: 0xfce21c,
  Nd: 0xfc8e07,
  Pm: 0x0000f5,
  Sm: 0xfc063e,
  Eu: 0xfb04d5,
  Gd: 0xc00eff,
  Tb: 0x7100fe,
  Dy: 0x3117fe,
  Ho: 0x072fae,
  Er: 0x497323,
  Tm: 0x0000e0,
  Yb: 0x273fe4,
  Lu: 0x26fed0,
  Hf: 0xb3b369,
  Ta: 0xb79af5,
  W:  0x8e8690,
  Re: 0xb3b17e,
  Os: 0xc9b179,
  Ir: 0xc9cfc7,
  Pt: 0xccc5c0,
  Au: 0xfeb236,
  Hg: 0xd3b8cc,
  Tl: 0x968a6d,
  Pb: 0x53545b,
  Bi: 0xd22fc7,
  Po: 0x0000ff,
  At: 0x0000ff,
  Rn: 0xffff00,
  Fr: 0x000000,
  Ra: 0x6eaa59,
  Ac: 0x648f73,
  Th: 0x26fe78,
  Pa: 0x28fb35,
  U:  0x7aa1aa,
  Np: 0x4c4c4c,
  Pu: 0x4c4c4c,
  Am: 0x4c4c4c,
  XX: 0x4c4c4c
};

// Optional style defaults
export const polyStyle = {
  FACE_OPACITY: 0.80,
};
