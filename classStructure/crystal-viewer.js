// external  imports
import * as THREE from 'three';
import { ConvexGeometry } from 'https://unpkg.com/three@0.160.0/examples/jsm/geometries/ConvexGeometry.js';
import { CSS2DRenderer, CSS2DObject } from 'https://unpkg.com/three@0.160.0/examples/jsm/renderers/CSS2DRenderer.js';




// import from the old file structure that need to be combined and ported to the new structure
import { setupSecondStructureInput } from './modules/secondStructureModule.js';
import { parseOUTCAR} from './modules/ReadOutcarModule.js';
import { setupStructureInput, isLikelyCIFContent, parsePOSCAR} from './modules/StructureInputModule.js';

// ........................................................................................................
// Import Modules
//
// These modules should contain all the functions related to specific functionalities
//
// .........................................................................................................
import { updateAngleDisplays, setupAxisControls} from './modules/cameraAngleControl.js';
import { createColorPicker } from './modules/ColorPickerModule.js';
import { animation_update} from './modules/AnimateModule.js'; // animate function is not really an animation, but the function that runs the frames. 
import { shareStructure,createShareButton,loadSharedStructure} from './modules/ShareModule.js'
import {getBondCutoff,updateBonds} from './modules/BondsModule.js'
import { periodicWrapped, updateLattice,recomputeLatticeDirs,latticeDirsNorm,fracToCart,cartToFrac} from '../modules/LatticeModule.js'
import { Structure} from './classes/Structure.js';
import { StructureData} from './classes/StructureData.js';
import { updateSpins} from './modules/SpinModule.js'
import {updateAtoms,createAtomMesh} from './modules/AtomsModule.js';
import { parseCIF} from './modules/ReaderModule.js';
import {createSupercell} from './modules/SuperCellModule.js';
import {getElementColor,loadColorOverrides,loadIndividualAtomColors,getIndividualAtomColor,
        getElementDisplayColor,getDefaultElementColor,clearAllIndividualColorsForElement,
        setElementColorOverride,clearElementColorOverride,setIndividualAtomColor,
        createPieDot,clearIndividualAtomColor } from './modules/ColorModule.js';
import {updateAllMeasurements, addAngleMeasurement, clearAllMeasurements,drawMeasureGraphics,
        addDistanceMeasurement, updateMeasurementMarkers,clearMeasureGraphics,clearMeasure} from './modules/MeasurementModule.js' // not all imports might be needed in this file

import {HighlightAtom,clearHighlightAtom,highlightAtomIn3D,clearAllHighlights,highlightAtomInStructurePanel } from './modules/SelectAndHighlightModule.js';

// .........................................................................................................
// Import Panels
//
// Panel files should contain all the functions related to a specific panels 
//
// // .........................................................................................................
import {initCamera, initRenderer, initLabelRenderer,initControls,resizeRenderer,
  initAxesGizmo, disposeGroup, switchCameraType, setViewDirection,resetView,collapseAllAtomExpansions
} from './panels/WindowAndSceneControls.js'
import {loadAboutContent, openAboutPanel, closeAboutPanel} from './panels/AboutPanel.js';
import {createSpinControls} from './panels/SpinPanel.js';
import { createLatticeComparisonPanel }from './panels/LatticeComparisonPanel.js'
import {resetBondLengths, createBondLengthControls} from './panels/BondLengthPanel.js';
import {createCompositionRow,renderComposition} from './panels/StructureInfoPanel.js';


// .........................................................................................................
// import utils needs to moce to the "share" functionality. This is currently broken.
// .........................................................................................................
import {
  captureCompleteState,
  createCompleteShareableURL,
  createLegacyShareableURL,
  restoreCompleteState,
  generatePOSCARString,
} from './utils/shareutils.js'; 
// .........................................................................................................
// store.js contains all state and default variables, e.g. three,js related, colors, default structure, etc.
//
//  This is currently necessary as classes are not yet fully adapter. structureData, originalStructureData,spinsData are global variables for now and should be replaced 
//  with the proper classes. However, this already solved some problems with camera and controls getting redefined as a side effect of some functions of the viewing angle
//  control. The rest of the singletons should be preserved. 
// .........................................................................................................
import { highlightHover,app,structureData,originalStructureData,spinsData, groups, general,measurements, 
         mode,defaultPOSCAR, polyStyle, defaultColorMap, jmolColorMap, atomicRadii,getAtomVisSettings,
         getBondVisSettings,getLatticeVisSettings} from './store.js';


// ........................................................................................................
//
// Some thing need to be globally defiend here. There should only be status variables left. 
// Nothing should be defined here. Use store, classes, panels or modules for new definitions!
// ........................................................................................................

const view = document.getElementById('view');
const status = document.getElementById('status');
const setStatus = (s) => {
  if (status) status.textContent = s;
  console.log('[viewer]', s);
};

// ........................................................................................................
//
//These will not be kept as sson as classes and therefore trajectories are workgin
// ........................................................................................................

let polyhedraGroup;
let atomsGroup2, bondsGroup2, latticeGroup2,spinGroup2;
let structureData2 = null;

function addSecondStructure(opacity=1.0) {

  function updateAtomCoordinates(atomIndex, newCoords, _structureData) {
    if (!_structureData || !_structureData.positions || atomIndex >= _structureData.positions.length) {
      console.error('Invalid atom index or structure data');
      return;
    }
    // Update the coordinates in the structure data
    _structureData.positions[atomIndex] = [...newCoords];
    console.log(`Updated atom ${atomIndex} coordinates to: ${newCoords.join(', ')}`);
    return _structureData
  }

  disposeGroup(atomsGroup2);

  if (!general.showSecond) return;
    atomsGroup2 = new THREE.Group();
  
  const _structureData = structureData2
  console.log("added second")

  const wrapped = periodicWrapped(_structureData.positions, _structureData.elements);
  const wrappedCart = fracToCart(wrapped.frac, _structureData.lattice);
  for (let i = 0; i < wrappedCart.length; i++) {
    const originalIndex = wrapped.srcIndex ? wrapped.srcIndex[i] : i;
    const atomMesh = createAtomMesh(wrapped.elements[i], wrappedCart[i], originalIndex,opacity);
    atomMesh.userData.sourceIndex = originalIndex;
    atomsGroup2.add(atomMesh);
  }


  if (general.showComparisonInfo===true) {
       const latticeCompPanel =  createLatticeComparisonPanel( structureData.lattice, _structureData.lattice)
       if (latticeCompPanel){
        document.body.appendChild(latticeCompPanel);
        latticeCompPanel.style.display = "block";
        console.log("Added latticeCompPanel") 
        }
        else{
          console.log("latticeCompPanel not defined")
        }
  }
  app.scene.add(atomsGroup2);
}


function NewupdatePolyhedra() {
  const DEBUG = true;

  if (polyhedraGroup) disposeGroup(polyhedraGroup);
  polyhedraGroup = new THREE.Group();
  if (!general.showPolyhedra) { app.scene.add(polyhedraGroup); return; }

  // --- Style ---
  const FACE_OPACITY = 0.7;
  const EDGE_OPACITY = 1.0
  const FACE_FALLBACK_COLOR = 0x00aaff;
  const EDGE_COLOR = 0x006c99;
  const EDGE_ANGLE = 18;
  const DOUBLE_SIDE = true;
  const DEPTH_WRITE = false;
  const POLY_OFFSET = true;
  const POLY_OFFSET_FACTOR = 1;
  const POLY_OFFSET_UNITS = 1;

  // --- Behavior ---
  const CENTERED_CNs_DESC = [12,10,8,7,6,5,4];
  const ALLOW_CAGES = true;
  const CAGE_TARGET_NS_DESC = [20,12,10,8,6,4];
  const CAGE_BFS_DEPTH = 5;
  const MAX_EDGE_SPREAD = 1.30;
  const MIN_THICKNESS_RATIO = 0.08;

  const ConvexGeomCtor = (typeof ConvexGeometry !== 'undefined') ? ConvexGeometry : (THREE.ConvexGeometry || null);
  if (!ConvexGeomCtor) { console.error('[updatePolyhedra] ConvexGeometry missing'); scene.add(polyhedraGroup); return; }

  // --- Helpers ---
  function thicknessRatio(points) {
    const mean = points.reduce((acc,p)=>acc.add(p), new THREE.Vector3()).multiplyScalar(1/points.length);
    const rel = points.map(p=>p.clone().sub(mean));
    let xx=0,xy=0,xz=0,yy=0,yz=0,zz=0;
    for(const v of rel){ const x=v.x,y=v.y,z=v.z; xx+=x*x; xy+=x*y; xz+=x*z; yy+=y*y; yz+=y*z; zz+=z*z; }
    const n=Math.max(1,rel.length); xx/=n; xy/=n; xz/=n; yy/=n; yz/=n; zz/=n;
    const m00=xx,m01=xy,m02=xz,m11=yy,m12=yz,m22=zz;
    const p1=m01*m01+m02*m02+m12*m12;
    let eMin=0,eMax=0;
    if(p1<=1e-18){ const e=[m00,m11,m22].sort((a,b)=>a-b); eMin=e[0]; eMax=e[2]; }
    else {
      const q=(m00+m11+m22)/3;
      let p2=(m00-q)*(m00-q)+(m11-q)*(m11-q)+(m22-q)*(m22-q)+2*p1;
      const p=Math.sqrt(p2/6);
      const b00=(m00-q)/p,b01=m01/p,b02=m02/p,b10=m01/p,b11=(m11-q)/p,b12=m12/p,b20=m02/p,b21=m12/p,b22=(m22-q)/p;
      const detB = b00*(b11*b22-b12*b21)-b01*(b10*b22-b12*b20)+b02*(b10*b21-b11*b20);
      const r = Math.max(-1,Math.min(1,detB/2));
      const phi = Math.acos(r)/3;
      const eig1 = q+2*p*Math.cos(phi);
      const eig3 = q+2*p*Math.cos(phi+2*Math.PI/3);
      const eig2 = 3*q-eig1-eig3;
      const ev=[eig1,eig2,eig3].sort((a,b)=>a-b);
      eMin=ev[0]; eMax=ev[2];
    }
    return eMin/Math.max(1e-12,eMax);
  }

  function edgeSpreadOK(geom) {
    if(!geom) return false;
    const egeom=new THREE.EdgesGeometry(geom,EDGE_ANGLE);
    const pos=egeom.getAttribute('position');
    let minL=Infinity,maxL=0;
    for(let i=0;i<pos.count;i+=2){
      const a=new THREE.Vector3().fromBufferAttribute(pos,i);
      const b=new THREE.Vector3().fromBufferAttribute(pos,i+1);
      const L=a.distanceTo(b);
      minL=Math.min(minL,L); maxL=Math.max(maxL,L);
    }
    egeom.dispose();
    if(!isFinite(minL)||minL<=1e-9) return false;
    return maxL/minL<=MAX_EDGE_SPREAD;
  }

  function pickSpreadSubset(points,N){
    if(points.length<N) return null;
    let aIdx=0,bIdx=1,best=-1;
    for(let i=0;i<points.length;i++) for(let j=i+1;j<points.length;j++){ const d=points[i].distanceToSquared(points[j]); if(d>best){best=d;aIdx=i;bIdx=j;} }
    const chosenIdx=[aIdx,bIdx];
    while(chosenIdx.length<N){
      let bestIdx=-1,bestScore=-Infinity;
      for(let i=0;i<points.length;i++){ if(chosenIdx.includes(i)) continue; let minD=Infinity; for(const j of chosenIdx){ const d=points[i].distanceToSquared(points[j]); if(d<minD) minD=minD; } if(minD>bestScore){ bestScore=minD; bestIdx=i; } }
      if(bestIdx<0) break;
      chosenIdx.push(bestIdx);
    }
    if(chosenIdx.length<N) return null;
    return chosenIdx.map(k=>points[k]);
  }

  function pointInsideConvexGeometry(p,geom,eps=1e-6){
    if(!geom) return false;
    const pos=geom.getAttribute('position');
    const idx=geom.getIndex();
    if(!pos) return false;
    const pc=new THREE.Vector3();
    for(let i=0;i<pos.count;i++) pc.add(new THREE.Vector3().fromBufferAttribute(pos,i));
    pc.multiplyScalar(1/pos.count);
    const triCount=idx?idx.count/3:pos.count/3;
    for(let t=0;t<triCount;t++){
      const i0=idx?idx.getX(3*t):3*t,i1=idx?idx.getX(3*t+1):3*t+1,i2=idx?idx.getX(3*t+2):3*t+2;
      const a=new THREE.Vector3().fromBufferAttribute(pos,i0),b=new THREE.Vector3().fromBufferAttribute(pos,i1),c=new THREE.Vector3().fromBufferAttribute(pos,i2);
      const n=b.clone().sub(a).cross(c.clone().sub(a));
      if(n.lengthSq()<1e-18) continue;
      const outward=Math.sign(n.dot(a.clone().sub(pc)))||1;
      n.multiplyScalar(outward);
      if(n.dot(new THREE.Vector3().subVectors(p,a))>eps) return false;
    }
    return true;
  }

  // --- Build wrapped positions, adjacency, per-center images ---
  const wrapped = periodicWrapped(structureData.positions, structureData.elements);
  const wrappedCart = fracToCart(wrapped.frac,structureData.lattice);
  const Wpos = wrappedCart.map(p=>new THREE.Vector3(p[0],p[1],p[2]));
  const Welem = wrapped.elements;
  const Wsrc = wrapped.srcIndex;
  const L = structureData.lattice;
  const a = new THREE.Vector3(...L[0]), b=new THREE.Vector3(...L[1]), c=new THREE.Vector3(...L[2]);

  const shifts=[];
  for(let dx=-1;dx<=1;dx++) for(let dy=-1;dy<=1;dy++) for(let dz=-1;dz<=1;dz++) shifts.push([dx,dy,dz]);

  const adjacency = new Map();
  function addBond(u,v){ if(!adjacency.has(u)) adjacency.set(u,new Set()); if(!adjacency.has(v)) adjacency.set(v,new Set()); adjacency.get(u).add(v); adjacency.get(v).add(u); }

  const perCenterImages = new Map();
  for(let i=0;i<Wpos.length;i++){
    const pi=Wpos[i],ei=Welem[i],srcI=Wsrc[i];
    const bonded=[];
    for(let j=0;j<Wpos.length;j++){ if(i===j) continue; const pj=Wpos[j],ej=Welem[j],srcJ=Wsrc[j]; const cutoff=getBondCutoff(ei,ej); if(cutoff<=1e-3) continue;
      for(const [dx,dy,dz] of shifts){ const shiftVec=new THREE.Vector3().addScaledVector(a,dx).addScaledVector(b,dy).addScaledVector(c,dz); const q=pj.clone().add(shiftVec); const d=q.distanceTo(pi); if(d>cutoff||d<1e-4) continue; addBond(srcI,srcJ); bonded.push({pos:q,srcJ,shift:[dx,dy,dz],d,wi:j}); } 
    } 
    perCenterImages.set(i,bonded);
  }

  const wrappedIdxBySrc = new Map();
  for(let wi=0;wi<Wsrc.length;wi++){ const s=Wsrc[wi]; if(!wrappedIdxBySrc.has(s)) wrappedIdxBySrc.set(s,[]); wrappedIdxBySrc.get(s).push(wi); }

  if(DEBUG) console.info('[poly DEBUG] Wpos.length=',Wpos.length,'uniqueSrcs=',new Set(Wsrc).size,'adjacencyEntries=',adjacency.size);

  // --- Candidates generation (centered and cage) ---
  const candidates=[];

  // Centered polyhedra
  for(let i=0;i<Wpos.length;i++){
    const imgs=perCenterImages.get(i)||[];
    if(imgs.length<3) continue;
    for(const N of CENTERED_CNs_DESC){ if(imgs.length<N) continue;
      const nearest=imgs.slice().sort((u,v)=>u.d-v.d).slice(0,N);
      const posList=nearest.map(o=>o.pos);
      let geom;
      try{ geom=new ConvexGeomCtor(posList); } catch{ continue; }
      if(!edgeSpreadOK(geom)||thicknessRatio(posList)<MIN_THICKNESS_RATIO){ geom.dispose(); continue; }
      candidates.push({kind:'centered',centerWrappedIdx:i,centerPos:Wpos[i],colorElem:Welem[i],posList,posListSrcs:nearest.map(o=>o.srcJ),geom});
      break;
    }
  }

  // Cage polyhedra
  if(ALLOW_CAGES){
    for(let seedWi=0;seedWi<Wpos.length;seedWi++){
      const seedSrc=Wsrc[seedWi]; const seedElem=Welem[seedWi];
      let pool=[{wi:seedWi,pos:Wpos[seedWi],src:seedSrc}];
      // Simple BFS limited to CAGE_BFS_DEPTH
      const visited=new Set([seedSrc]); let q=[seedSrc]; let depth=0;
      while(q.length>0 && depth<CAGE_BFS_DEPTH){ const nextQ=[]; for(const u of q){ const nb=adjacency.get(u)||[]; for(const v of nb){ if(!visited.has(v)){ visited.add(v); const idxs=wrappedIdxBySrc.get(v)||[]; for(const wi of idxs) pool.push({wi,pos:Wpos[wi],src:v}); nextQ.push(v); } } } q=nextQ; depth++; }
      if(pool.length<4) continue;
      const centroid=pool.reduce((acc,o)=>acc.add(o.pos),new THREE.Vector3()).multiplyScalar(1/pool.length);
      const dists=pool.map(o=>o.pos.distanceTo(centroid)).sort((a,b)=>a-b);
      for(const N of CAGE_TARGET_NS_DESC){
        const band=pool.slice(0,N);
        const posList=band.map(o=>o.pos);
        let geom;
        try{ geom=new ConvexGeomCtor(posList); } catch{ continue; }
        if(!edgeSpreadOK(geom)||thicknessRatio(posList)<MIN_THICKNESS_RATIO){ geom.dispose(); continue; }
        candidates.push({kind:'cage',posList,colorElem:seedElem,posListSrcs:band.map(o=>o.src),geom});
        break;
      }
    }
  }

  // --- Sorting candidates: larger N first, centered over cages ---
  candidates.sort((A,B)=>{ if(A.posList.length!==B.posList.length) return B.posList.length-A.posList.length; if(A.kind!==B.kind) return (A.kind==='centered'? -1:1); return 0; });

  const acceptedCenterWrappedKeys=new Set();
  const acceptedHulls=[];

  const sharedEdgeMat=new THREE.LineBasicMaterial({color:EDGE_COLOR,transparent:true,opacity:EDGE_OPACITY});

  for(const cand of candidates){
    // Avoid nesting
    let inside=false;
    for(const g of acceptedHulls){ if(pointInsideConvexGeometry(cand.posList[0],g)) inside=true; }
    if(inside){ if(cand.geom && cand.geom.dispose) cand.geom.dispose(); continue; }

    const faceColor=(typeof getElementColor==='function')? getElementColor(cand.colorElem): FACE_FALLBACK_COLOR;
    const mat=new THREE.MeshStandardMaterial({color:faceColor,transparent:true,opacity:FACE_OPACITY,metalness:0,roughness:1,side:DOUBLE_SIDE?THREE.DoubleSide:THREE.FrontSide,depthWrite:DEPTH_WRITE,polygonOffset:POLY_OFFSET,polygonOffsetFactor:POLY_OFFSET?POLY_OFFSET_FACTOR:0,polygonOffsetUnits:POLY_OFFSET?POLY_OFFSET_UNITS:0});

    const mesh=new THREE.Mesh(cand.geom,mat);
    mesh.userData={type:'polyhedron',mode:cand.kind,cn:cand.posList.length,vertexSrcs:cand.posListSrcs};
    mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(cand.geom,EDGE_ANGLE),sharedEdgeMat));
    polyhedraGroup.add(mesh);

    acceptedHulls.push(cand.geom);
    if(cand.kind==='centered'&&typeof cand.centerWrappedIdx==='number') acceptedCenterWrappedKeys.add(`wi:${cand.centerWrappedIdx}`);
  }

  app.scene.add(polyhedraGroup);
  if(DEBUG) console.info('[poly DEBUG] total candidates rendered:',polyhedraGroup.children.length);
}

function updatePolyhedra() {
  // ---------- TOGGLE ----------
  if (polyhedraGroup) disposeGroup(polyhedraGroup);
  polyhedraGroup = new THREE.Group();
  if (!general.showPolyhedra) {
    app.scene.add(polyhedraGroup);
    return; // IMPORTANT: nothing drawn when hidden
  }

  // ---------- STYLE ----------
  const FACE_OPACITY = 0.80;
  const EDGE_OPACITY = Math.min(1, FACE_OPACITY + 0.35);
  const FACE_FALLBACK_COLOR = 0x00aaff;
  const EDGE_COLOR = 0x006c99;
  const EDGE_ANGLE = 18;
  const DOUBLE_SIDE = true;
  const DEPTH_WRITE = false;
  const POLY_OFFSET = true;
  const POLY_OFFSET_FACTOR = 1;
  const POLY_OFFSET_UNITS = 1;

  // ---------- BEHAVIOR ----------
  // Centered CNs (largest-first prioritization is achieved later via candidate sort)
  const CENTERED_CNs_DESC = [12, 10, 8, 7, 6, 5, 4];

  // Cages (uncentered): **includes N = 20 dodecahedra**
  const ALLOW_CAGES = true;
  const CAGE_TARGET_NS_DESC = [20, 12, 10, 8, 6, 4]; // 20 first for dodecahedron cages
  const CAGE_BFS_DEPTH = 5; // a bit deeper to ensure we hit full N=20 shells

  // Mild distortion tolerance (applies to both centered and cages)
  const MAX_EDGE_SPREAD = 1.30;      // max(edge)/min(edge) ≤ 1.30  (~30%)
  const MIN_THICKNESS_RATIO = 0.08;  // very lenient anti-flatness (e_min / e_max)

  // Minimal induced degree per cage size (tune as needed)
function minVertexDegreeForCageSize(N) {
  if (N === 12) return 5; // B12 icosahedral cage in boron carbide
  if (N === 20) return 3; // 20-vertex dodecahedron (degree 3)
  if (N === 10) return 3;
  if (N === 8)  return 3;
  if (N === 6)  return 3;
  if (N === 4)  return 2;
  return 3;
}

  // ---------- SAFETY ----------
  const ConvexGeomCtor = (typeof ConvexGeometry !== 'undefined')
    ? ConvexGeometry
    : (THREE && THREE.ConvexGeometry ? THREE.ConvexGeometry : null);
  if (!ConvexGeomCtor) {
    console.error('[updatePolyhedra] ConvexGeometry missing. Load examples/jsm/geometries/ConvexGeometry.js');
    app.scene.add(polyhedraGroup);
    return;
  }

  // ---------- Helpers ----------
  function thicknessRatio(points) {
    const mean = points.reduce((acc,p)=>acc.add(p), new THREE.Vector3()).multiplyScalar(1/points.length);
    const rel  = points.map(p=>p.clone().sub(mean));
    let xx=0,xy=0,xz=0, yy=0,yz=0, zz=0;
    for (const v of rel) { const x=v.x,y=v.y,z=v.z; xx+=x*x; xy+=x*y; xz+=x*z; yy+=y*y; yz+=y*z; zz+=z*z; }
    const n = Math.max(1, rel.length);
    xx/=n; xy/=n; xz/=n; yy/=n; yz/=n; zz/=n;
    const m00=xx, m01=xy, m02=xz, m11=yy, m12=yz, m22=zz;
    const p1 = m01*m01 + m02*m02 + m12*m12;
    let eMin=0,eMax=0;
    if (p1 <= 1e-18) { const e=[m00,m11,m22].sort((a,b)=>a-b); eMin=e[0]; eMax=e[2]; }
    else {
      const q=(m00+m11+m22)/3;
      let p2=(m00-q)*(m00-q)+(m11-q)*(m11-q)+(m22-q)*(m22-q)+2*p1;
      const p=Math.sqrt(p2/6);
      const b00=(m00-q)/p, b01=m01/p,   b02=m02/p;
      const b10=m01/p,   b11=(m11-q)/p, b12=m12/p;
      const b20=m02/p,   b21=m12/p,     b22=(m22-q)/p;
      const detB = b00*(b11*b22-b12*b21)-b01*(b10*b22-b12*b20)+b02*(b10*b21-b11*b20);
      const r = Math.max(-1, Math.min(1, detB/2));
      const phi = Math.acos(r)/3;
      const eig1 = q + 2*p*Math.cos(phi);
      const eig3 = q + 2*p*Math.cos(phi + 2*Math.PI/3);
      const eig2 = 3*q - eig1 - eig3;
      const ev=[eig1,eig2,eig3].sort((a,b)=>a-b);
      eMin=ev[0]; eMax=ev[2];
    }
    return eMin / Math.max(1e-12, eMax);
  }

  function edgeSpreadOK(geom) {
    const egeom = new THREE.EdgesGeometry(geom, EDGE_ANGLE);
    const pos = egeom.getAttribute('position');
    let minL = Infinity, maxL = 0;
    for (let i=0; i<pos.count; i+=2) {
      const a = new THREE.Vector3().fromBufferAttribute(pos, i);
      const b = new THREE.Vector3().fromBufferAttribute(pos, i+1);
      const L = a.distanceTo(b);
      if (L < minL) minL = L;
      if (L > maxL) maxL = L;
    }
    egeom.dispose();
    if (!isFinite(minL) || minL <= 1e-9) return false;
    return (maxL / minL) <= MAX_EDGE_SPREAD;
  }

  function pointInsideConvexGeometry(p, geom, eps=1e-6) {
    const pos = geom.getAttribute('position');
    const idx = geom.getIndex();
    if (!pos) return false;
    const pc = new THREE.Vector3();
    for (let i=0;i<pos.count;i++) pc.add(new THREE.Vector3().fromBufferAttribute(pos, i));
    pc.multiplyScalar(1/pos.count);
    const triCount = idx ? idx.count/3 : pos.count/3;
    for (let t=0; t<triCount; t++) {
      const i0 = idx ? idx.getX(3*t+0) : 3*t+0;
      const i1 = idx ? idx.getX(3*t+1) : 3*t+1;
      const i2 = idx ? idx.getX(3*t+2) : 3*t+2;
      const a = new THREE.Vector3().fromBufferAttribute(pos, i0);
      const b = new THREE.Vector3().fromBufferAttribute(pos, i1);
      const c = new THREE.Vector3().fromBufferAttribute(pos, i2);
      const n = b.clone().sub(a).cross(c.clone().sub(a));
      if (n.lengthSq() < 1e-18) continue;
      const outward = Math.sign(n.dot(a.clone().sub(pc))) || 1;
      n.multiplyScalar(outward);
      const s = n.dot(new THREE.Vector3().subVectors(p, a));
      if (s > eps) return false;
    }
    return true;
  }

  function bfs(adjacency, srcStart, depthMax) {
    const visited = new Map(); // src -> depth
    const q = [[srcStart, 0]];
    visited.set(srcStart, 0);
    while (q.length) {
      const [u,d] = q.shift();
      if (d === depthMax) continue;
      for (const v of (adjacency.get(u) || [])) {
        if (!visited.has(v)) { visited.set(v, d+1); q.push([v,d+1]); }
      }
    }
    return visited;
  }

  // Spherical farthest-point sampling: pick N vertices well spread (angle-based)
  function pickSpreadSubset(points, N) {
    if (points.length < N) return null;
    let aIdx = 0, bIdx = 1, best = -1;
    for (let i=0;i<points.length;i++) for (let j=i+1;j<points.length;j++) {
      const d = points[i].distanceToSquared(points[j]);
      if (d > best) { best = d; aIdx=i; bIdx=j; }
    }
    const chosenIdx = [aIdx, bIdx];
    while (chosenIdx.length < N) {
      let bestIdx=-1, bestScore=-Infinity;
      for (let i=0;i<points.length;i++) {
        if (chosenIdx.includes(i)) continue;
        let minD = Infinity;
        for (const j of chosenIdx) {
          const d = points[i].distanceToSquared(points[j]);
          if (d < minD) minD = d;
        }
        if (minD > bestScore) { bestScore = minD; bestIdx = i; }
      }
      if (bestIdx < 0) break;
      chosenIdx.push(bestIdx);
    }
    if (chosenIdx.length < N) return null;
    return chosenIdx.map(k => points[k]);
  }

  function quantile(sortedArr, q) {
    if (!sortedArr.length) return 0;
    const i = (sortedArr.length - 1) * q;
    const i0 = Math.floor(i), i1 = Math.min(sortedArr.length - 1, i0 + 1);
    const t = i - i0;
    return sortedArr[i0] * (1 - t) + sortedArr[i1] * t;
  }


  function inducedDegreeOK(selSrcs, minDeg) {
    const set = new Set(selSrcs);
    for (const u of selSrcs) {
      const nb = adjacency.get(u) || new Set();
      let deg = 0;
      for (const v of nb) if (set.has(v) && v !== u) deg++;
      if (deg < minDeg) return false;
    }
    return true;
  }

  // ---------- Build bond graph + per-center bonded images (with shifts) ----------
  const wrapped = periodicWrapped(structureData.positions, structureData.elements);
  const wrappedCart = fracToCart(wrapped.frac, structureData.lattice);
  const Wpos  = wrappedCart.map(p => new THREE.Vector3(p[0], p[1], p[2]));
  const Welem = wrapped.elements;
  const Wsrc  = wrapped.srcIndex;

  const L = structureData.lattice;
  const a = new THREE.Vector3(L[0][0], L[0][1], L[0][2]);
  const b = new THREE.Vector3(L[1][0], L[1][1], L[1][2]);
  const c = new THREE.Vector3(L[2][0], L[2][1], L[2][2]);

  const maxCutoff = Math.max(0.0, ...Object.values(general.bondLengths || { dummy: 0.0 }));
  const ax = Math.max(1, Math.min(2, Math.ceil(maxCutoff / Math.max(a.length(), 1e-6))));
  const by = Math.max(1, Math.min(2, Math.ceil(maxCutoff / Math.max(b.length(), 1e-6))));
  const cz = Math.max(1, Math.min(2, Math.ceil(maxCutoff / Math.max(c.length(), 1e-6))));
  const shifts = [];
  for (let dx=-ax; dx<=ax; dx++)
    for (let dy=-by; dy<=by; dy++)
      for (let dz=-cz; dz<=cz; dz++)
        shifts.push([dx,dy,dz]);

  /** @type {Map<number, Set<number>>} */
  const adjacency = new Map();
  function addBond(u, v) {
    if (!adjacency.has(u)) adjacency.set(u, new Set());
    if (!adjacency.has(v)) adjacency.set(v, new Set());
    adjacency.get(u).add(v); adjacency.get(v).add(u);
  }

  /** @type {Map<number, Array<{pos:THREE.Vector3, srcJ:number, shift:[number,number,number], d:number}>>} */
  const perCenterImages = new Map();
  for (let i=0; i<Wpos.length; i++) {
    const pi = Wpos[i], ei = Welem[i], srcI = Wsrc[i];
    const bonded = [];
    for (let j=0; j<Wpos.length; j++) {
      if (j === i) continue;
      const pj = Wpos[j], ej = Welem[j], srcJ = Wsrc[j];
      const cutoff = getBondCutoff(ei, ej);
      if (cutoff <= 1e-3) continue;
      for (const [dx,dy,dz] of shifts) {
        const shiftVec = new THREE.Vector3().addScaledVector(a,dx).addScaledVector(b,dy).addScaledVector(c,dz);
        const q = pj.clone().add(shiftVec);
        const d = q.distanceTo(pi);
        if (d > cutoff || d < 1e-4) continue;
        addBond(srcI, srcJ);
        bonded.push({ pos: q, srcJ, shift:[dx,dy,dz], d });
      }
    }
    perCenterImages.set(i, bonded);
  }

  // Map src -> list of wrapped indices (to identify cage vertex images)
  const wrappedIdxBySrc = new Map();
  for (let wi=0; wi<Wsrc.length; wi++) {
    const s = Wsrc[wi];
    if (!wrappedIdxBySrc.has(s)) wrappedIdxBySrc.set(s, []);
    wrappedIdxBySrc.get(s).push(wi);
  }

  // ---------- Build candidates ----------
  /** @type {Array<{
   *   kind: 'centered'|'cage',
   *   colorElem: string,
   *   centerWrappedIdx?: number,
   *   centerSrc?: number,
   *   centerPos?: THREE.Vector3,
   *   posList: THREE.Vector3[],
   *   vertexSrcList: number[],
   *   vertexWrappedIdxList?: number[],              // cages
   *   vertexImageList?: Array<{src:number, shift:[number,number,number]}>, // centered
   *   refPoint: THREE.Vector3,
   * }>} */
  const candidates = [];

  // ---- Centered (one per center; try largest CNs first) ----
  for (let i=0; i<Wpos.length; i++) {
    const centerPos = Wpos[i], centerElem = Welem[i], centerSrc = Wsrc[i];
    const imgs = perCenterImages.get(i) || [];
    if (imgs.length < 3) continue;

    for (const N of CENTERED_CNs_DESC) {
      if (imgs.length < N) continue;

      const nearest = imgs.slice().sort((u,v)=>u.d - v.d).slice(0, N);
      const allPos = imgs.map(o=>o.pos);
      const spreadPos = (imgs.length > N) ? (pickSpreadSubset(allPos, N) || []) : nearest.map(o=>o.pos);

      const variants = [];
      variants.push(nearest);
      if (spreadPos.length === N) {
        // map spread positions back to entries
        const spreadEntries = spreadPos.map(p => {
          let best=null, bestD=Infinity;
          for (const o of imgs) {
            const dd = p.distanceToSquared(o.pos);
            if (dd < bestD) { bestD = dd; best = o; }
          }
          return best;
        });
        const nearestSet = new Set(nearest.map(o=>o.pos));
        if (spreadEntries.some(o => !nearestSet.has(o.pos))) variants.push(spreadEntries);
      }

      let acceptedVariant = null;
      for (const variant of variants) {
        const posList = variant.map(o=>o.pos);
        let geom;
        try { geom = new ConvexGeomCtor(posList); } catch { continue; }
        const okSpread = edgeSpreadOK(geom);
        const okThick  = thicknessRatio(posList) >= MIN_THICKNESS_RATIO;
        if (okSpread && okThick) { acceptedVariant = { posList, variant }; geom.dispose(); break; }
        geom.dispose();
      }

      if (acceptedVariant) {
        candidates.push({
          kind: 'centered',
          colorElem: centerElem,
          centerWrappedIdx: i,
          centerSrc,
          centerPos,
          posList: acceptedVariant.posList,
          vertexSrcList: acceptedVariant.variant.map(o=>o.srcJ),
          vertexImageList: acceptedVariant.variant.map(o=>({ src:o.srcJ, shift:o.shift })),
          refPoint: centerPos.clone(),
        });
        break; // only one centered candidate per center (largest-first)
      }
    }
  }

  // ---- Cages (uncentered): includes N=20 dodecahedra; largest-first ----
  if (ALLOW_CAGES) {
    function buildPoolForSeed(seedSrc, depthMax) {
      const reach = bfs(adjacency, seedSrc, depthMax);
      const pool = [];
      for (const s of reach.keys()) {
        const idxs = wrappedIdxBySrc.get(s) || [];
        for (const wi of idxs) pool.push({ wi, pos: Wpos[wi], src: Wsrc[wi] });
      }
      return pool;
    }

    for (let seedWi=0; seedWi<Wpos.length; seedWi++) {
      const seedSrc = Wsrc[seedWi];
      const seedElem = Welem[seedWi];

      // expand pool up to depth until we have plenty of candidates for N=20
      let depth = 3;
      let pool = buildPoolForSeed(seedSrc, depth);
      while (pool.length < 40 && depth < CAGE_BFS_DEPTH) { // heuristic ≥2×N
        depth++;
        pool = buildPoolForSeed(seedSrc, depth);
      }
      if (pool.length < 4) continue;

      // reference: centroid of pool (better shell center)
      const centroid = pool.reduce((acc,o)=>acc.add(o.pos), new THREE.Vector3()).multiplyScalar(1/pool.length);
      const dists = pool.map(o => o.pos.distanceTo(centroid)).sort((a,b)=>a-b);
      const q30 = quantile(dists, 0.30), q70 = quantile(dists, 0.70);
      const q25 = quantile(dists, 0.25), q75 = quantile(dists, 0.75);
      const q20 = quantile(dists, 0.20), q80 = quantile(dists, 0.80);

      for (const N of CAGE_TARGET_NS_DESC) {
        // band widths (narrow → wide)
        const bands = [
          [q30, q70],
          [q25, q75],
          [q20, q80],
        ];
        let builtThisN = false;

        for (const [lo, hi] of bands) {
          const band = pool.filter(o => {
            const r = o.pos.distanceTo(centroid);
            return r >= lo && r <= hi;
          });
          if (band.length < N) continue;

          // Hull of band → extract hull vertices → possibly reduce to N by spread
          let geomBand;
          try { geomBand = new ConvexGeomCtor(band.map(o=>o.pos)); } catch { geomBand = null; }
          if (!geomBand) continue;
          geomBand.computeVertexNormals();

          const posAttr = geomBand.getAttribute('position');
          const hullPts = [];
          for (let k=0;k<posAttr.count;k++) hullPts.push(new THREE.Vector3().fromBufferAttribute(posAttr, k));

          // Unique nearest mapping back to band entries
          const chosenMap = new Map(); // band index -> band entry
          for (const hp of hullPts) {
            let bi=-1, best=Infinity;
            for (let j=0; j<band.length; j++) {
              const dd = hp.distanceToSquared(band[j].pos);
              if (dd < best) { best=dd; bi=j; }
            }
            if (bi>=0 && !chosenMap.has(bi)) chosenMap.set(bi, band[bi]);
          }
          let verts = Array.from(chosenMap.values()); // {wi,pos,src}[]

          if (verts.length !== N) {
            if (verts.length < N) { geomBand.dispose(); continue; }
            // reduce to N by spread
            const subset = pickSpreadSubset(verts.map(o=>o.pos), N);
            if (!subset) { geomBand.dispose(); continue; }
            verts = subset.map(p => {
              let best=null, bestD=Infinity;
              for (const o of band) {
                const dd = p.distanceToSquared(o.pos);
                if (dd < bestD) { bestD = dd; best = o; }
              }
              return best;
            });
          }

          // Build candidate hull on selected N verts
          const posList = verts.map(o=>o.pos);
          let geom;
          try { geom = new ConvexGeomCtor(posList); } catch { geom = null; }
          if (!geom) { geomBand.dispose(); continue; }
 
          geom.computeVertexNormals();

          // ---- CAGE acceptance: induced-degree rule instead of hull-edges-as-bonds ----

          // 1) Mild shape sanity (keep your existing checks)
          const okSpread = edgeSpreadOK(geom);                   // max(edge)/min(edge) ≤ 1.30
          const okThick  = thicknessRatio(posList) >= 0.08;      // very lenient anti-flatness
          if (!(okSpread && okThick)) { geom.dispose(); continue; }

          // 2) Induced-degree in the selected vertex set (B12 needs 5)
          const minDeg = minVertexDegreeForCageSize(posList.length);
          if (!inducedDegreeOK(selSrcs, minDeg)) { 
            geom.dispose(); continue; 
          }
          // 3) Accept cage candidate (push into candidates with posList/selSrcs/refPoint as you already do)


          // Accept candidate cage
          candidates.push({
            kind: 'cage',
            colorElem: seedElem,
            posList,
            vertexSrcList: selSrcs,
            vertexWrappedIdxList: verts.map(o=>o.wi),
            refPoint: posList.reduce((acc,p)=>acc.add(p), new THREE.Vector3()).multiplyScalar(1/posList.length),
          });

          geom.dispose();
          geomBand.dispose();
          builtThisN = true;
          break; // move to next N (largest-first, one per band here)
        } // bands
        // (optionally keep building more cages per seed/N; current strategy keeps it moderate)
        if (builtThisN) continue;
      } // Ns
    } // seeds
  } // cages enabled

  // ---------- Global constraints & render ----------
  // Image-level center-not-corner:
  //  - The exact wrapped center image cannot appear as a vertex image elsewhere.
  const acceptedCenterWrappedKeys = new Set(); // 'wi:<wrappedIndex>'
  const acceptedHulls = []; // keep geometries for inside tests (do not dispose)

  // Priority: larger N first; then centered over cages

  candidates.sort((A, B) => {
    const nA = A.posList.length, nB = B.posList.length;
    if (nA !== nB) return nB - nA; // larger first

    // For large shells, prefer cages (so they aren't blocked by centered selections)
    if (nA >= 12 && A.kind !== B.kind) {
      return (A.kind === 'cage' ? -1 : 1);
    }

    // Otherwise your previous preference (centered first)
    if (A.kind !== B.kind) return (A.kind === 'centered' ? -1 : 1);

    return 0;
  });


  const sharedEdgeMat = new THREE.LineBasicMaterial({
    color: EDGE_COLOR, transparent: true, opacity: EDGE_OPACITY,
  });

  for (const cand of candidates) {
    // Image-level center-not-corner
    if (cand.kind === 'cage' && cand.vertexWrappedIdxList) {
      // A cage must not use an already-accepted center image as a vertex
      const conflict = cand.vertexWrappedIdxList.some(wi => acceptedCenterWrappedKeys.has(`wi:${wi}`));
      if (conflict) continue;
    }

    // Build final hull
    let geom;
    try { geom = new ConvexGeomCtor(cand.posList); } catch { continue; }
    geom.computeVertexNormals();

    // No nesting: reference point not inside any accepted hull
    let inside = false;
    for (const g of acceptedHulls) {
      if (pointInsideConvexGeometry(cand.refPoint, g, 1e-6)) { inside = true; break; }
    }
    if (inside) { geom.dispose(); continue; }

    // Render
    const faceColor = (typeof getElementColor === 'function') ? getElementColor(cand.colorElem) : FACE_FALLBACK_COLOR;
    const mat = new THREE.MeshStandardMaterial({
      color: faceColor,
      transparent: true,
      opacity: FACE_OPACITY,
      metalness: 0.0,
      roughness: 1.0,
      side: DOUBLE_SIDE ? THREE.DoubleSide : THREE.FrontSide,
      depthWrite: DEPTH_WRITE,
      polygonOffset: POLY_OFFSET,
      polygonOffsetFactor: POLY_OFFSET ? POLY_OFFSET_FACTOR : 0,
      polygonOffsetUnits: POLY_OFFSET ? POLY_OFFSET_UNITS : 0,
    });

    const mesh = new THREE.Mesh(geom, mat);
    mesh.userData = {
      type: 'polyhedron',
      mode: cand.kind,
      cn: cand.posList.length,
      centerWrappedIdx: (cand.kind === 'centered') ? cand.centerWrappedIdx : undefined,
      centerSrcIndex:   (cand.kind === 'centered') ? cand.centerSrc : undefined,
      centerElement:    (cand.kind === 'centered') ? cand.colorElem : undefined,
      vertexSrcs: cand.vertexSrcList,
    };

    const egeom = new THREE.EdgesGeometry(geom, EDGE_ANGLE);
    mesh.add(new THREE.LineSegments(egeom, sharedEdgeMat));
    polyhedraGroup.add(mesh);

    // Update constraint sets
    if (cand.kind === 'centered' && typeof cand.centerWrappedIdx === 'number') {
      acceptedCenterWrappedKeys.add(`wi:${cand.centerWrappedIdx}`);
    }
    acceptedHulls.push(geom); // keep for future inside tests
  }

  app.scene.add(polyhedraGroup);
}


function openBackgroundColorPicker(dot) {
  // Remove any existing picker first
  //
  let currentHex=null
  document.querySelectorAll(".spin-color-picker").forEach(p => p.remove());
  if (app.scene.background) currentHex = "#" + app.scene.background.getHexString();
  let selectedHex = currentHex;


  function getLuminance(hex) {
  // Convert hex to RGB
  const c = hex.startsWith("#") ? hex.substring(1) : hex;
  const r = parseInt(c.substring(0, 2), 16) / 255;
  const g = parseInt(c.substring(2, 4), 16) / 255;
  const b = parseInt(c.substring(4, 6), 16) / 255;

  // Perceived luminance formula
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function getContrastingBorder(hex) {
  const lum = getLuminance(hex);
  return lum > 0.5 ? "#333333" : "#ffffff"; // dark border for light bg, white for dark bg
}

  // --- Create main picker container ---
  const pickerPanel = document.createElement("div");
  pickerPanel.className = "spin-color-picker";
  Object.assign(pickerPanel.style, {
    position: "absolute",
    background: "rgba(26,26,26,0.8)",
    border: "1px solid #ccc",
    padding: "10px",
    borderRadius: "8px",
    boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
    zIndex: 9999,
  });

  // --- Create the color picker using existing helper ---
  const { element: pickerElement } = createColorPicker(currentHex, (hex) => {
    selectedHex = hex;
    let contrastColor = `${getContrastingBorder(selectedHex)}`

    dot.style.border = `2px solid ${contrastColor}`
    general.currentLatticeColor = contrastColor
    updateLattice(contrastColor)
    app.scene.background = new THREE.Color(hex);   // live preview in scene
  });


  //dot.style.border = `2px solid ${getContrastingBorder(selectedHex)}`;

  // --- Apply / Reset Buttons ---
  const buttonRow = document.createElement("div");
  Object.assign(buttonRow.style, {
    display: "flex",
    justifyContent: "space-between",
    marginTop: "10px",
    gap: "8px"
  });

  const resetBtn = document.createElement('button');
  resetBtn.textContent = 'Reset';
  resetBtn.className = 'reset-btn';
  resetBtn.style.cssText = 'height: 32px';
  resetBtn.style.background = general.defaultBackgroundColor;

  const applyBtn = document.createElement('button');
  applyBtn.textContent = 'Apply';
  applyBtn.className = 'btn-mini highlight';
  applyBtn.style.cssText = 'height: 32px';


  buttonRow.appendChild(resetBtn);
  buttonRow.appendChild(applyBtn);

  pickerPanel.appendChild(pickerElement);
  pickerPanel.appendChild(buttonRow);
  document.body.appendChild(pickerPanel);

  // --- Position near the dot ---
  const rect = dot.getBoundingClientRect();
  let topPosition = rect.top + window.scrollY + 60;
  let bottomSpace = window.innerHeight - (rect.top + window.scrollY + 24 + pickerPanel.offsetHeight);
  if (bottomSpace < 40) topPosition = window.innerHeight - pickerPanel.offsetHeight - 65;

  pickerPanel.style.left = `${rect.left + window.scrollX - 200}px`;
  pickerPanel.style.top = `${topPosition}px`;

  // --- Close picker helper ---
  const closePicker = () => {
    pickerPanel.remove();
    document.removeEventListener("mousedown", outsideClick);
  };

  const outsideClick = (e) => {
    if (!pickerPanel.contains(e.target) && e.target !== dot) closePicker();
  };

  document.addEventListener("mousedown", outsideClick);
  pickerPanel.addEventListener("mousedown", (e) => e.stopPropagation());

  // --- Apply button behavior ---
  applyBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    dot.style.border = `2px solid ${getContrastingBorder(selectedHex)}`;
    app.scene.background = new THREE.Color(selectedHex); // lock in color
    closePicker();
  });

  // --- Reset button behavior ---
  resetBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    closePicker();
    const isDarkMode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
   if (isDarkMode )
    {
    app.scene.background = new THREE.Color(0x021302)
    general.currentLatticeColor = 0xE7E7E7;
    dot.style.border = `2px solid #E7E7E7`
    updateLattice()
   }
   else if (!isDarkMode )
   {
    app.scene.background = new THREE.Color(0xE7E7E7);
    general.currentLatticeColor = 0x021302
    dot.style.border = `2px solid #021302`
    updateLattice()
   }

  });
}


function createBackgroundControl() {
  const dot = document.getElementById("backgroundDot");
  if (!dot) {
    console.error("No element found with ID 'backgroundDot'");
    return;
  }

  let currentBackground = app.scene.background

  // Make it visible and clickable
  dot.style.position = "fixed";
  dot.style.zIndex = "999";
  dot.style.pointerEvents = "auto";
  dot.style.borderRadius = "50%";
  dot.style.cursor = "pointer";

  // Attach click listener directly
  dot.addEventListener("click", () => {
    openBackgroundColorPicker(dot); // uncomment when scene is ready
  });
}

function updateOther() {
  renderComposition();
  clearMeasureGraphics();

  measurements.measureLines.forEach(line => app.scene.add(line));
  measurements.measureLabels.forEach(label => app.scene.add(label));

  recomputeLatticeDirs();
  updateAllMeasurements();
}


export function updateVisualization(options = {}) {
  const {
    reRenderAtoms = true,
    reRenderBonds = true,
    reRenderLattice = true,
    reRenderOther = true,
    sOpactiy = general.secondOpacity,
    mOpacity = general.mainOpacity
  } = options;

  if (!structureData) {
    console.log('No structureData available, returning early');
    return;
  }

  if (reRenderAtoms) {
    updateAtoms(mOpacity);
    if (atomsGroup2){
      addSecondStructure(sOpactiy)
     }
  }

  if (reRenderBonds) { 
    disposeGroup();
    updateBonds();
  }
  if (reRenderLattice) updateLattice(general.currentLatticeColor);
  if (reRenderOther) updateOther();
}


async function loadStructure(content, fileName = '', isDefault = false) {
  try {

    console.log("")
    const lower = (fileName || '').toLowerCase();
    const contentString = typeof content === 'string' ? content : '';
    const treatAsCIF = lower.endsWith('.cif') ||
                      lower.includes('.cif') ||
                      /(^|\W)cif(\W|$)/.test(lower) ||
                      isLikelyCIFContent(contentString);

     const treatAsOUTCAR = lower.endsWith('.vasp.out') ||
                      lower.includes('.vasp.out') ||
                      lower.includes('outcar');
    let parsed;
    let parsedSpinsData
    if (treatAsCIF) {
      console.log("This is probably a CIF file")

      parsed = await parseCIF(contentString);
    } 
    
    else if (treatAsOUTCAR){
      console.log("This is probably an OUTCAR file");
      ({ structure: parsed, spin: parsedSpinsData } = await parseOUTCAR(contentString));

    if (spinsData?.length != null) {
      spinsData.length = 0;
    }
    spinsData.push(...parsedSpinsData);

    }
    else {
      console.log("This is probably a POSCAR file")
      parsed = await parsePOSCAR(contentString);
    }

  // Ensure the fields exist and are the right typed arrays
    //

    structureData.positions = parsed.positions ?? null;
    structureData.elements  = parsed.elements  ?? null;
    structureData.lattice   = parsed.lattice   ?? null;
    structureData.supercell = parsed.supercell ?? {nx:1,ny:1,nz:1};

    console.log("after load",structureData)


    // keep a deep copy for restore (fractional positions + arrays)
    //
    let parseOriginalStructureData = JSON.parse(JSON.stringify(structureData));
    originalStructureData.positions = parseOriginalStructureData.positions
    originalStructureData.elements = parseOriginalStructureData.elements
    originalStructureData.lattice = parseOriginalStructureData.lattice
    originalStructureData.supercell= parseOriginalStructureData.supercell


    loadColorOverrides();
    loadIndividualAtomColors();
    if (isDefault) {
      setStatus(`Default structure: ${structureData.elements.length} atoms`);
    } else {
      setStatus(`Loaded: ${structureData.elements.length} atoms`);
    }

    document.getElementById('structureControls').style.display = 'block';
    document.getElementById('bondControlsGroup').style.display = 'block';
    document.getElementById('spinControlsGroup').style.display = 'block';

    createBondLengthControls();
    createSpinControls();
    createBackgroundControl();
    createShareButton();
    updateVisualization();
    if (spinsData != null){
      updateSpins(1.0);
      //populateSpinViewer();
    }
    // Rebuild camera with size/distance based on structure and zoom scale
    switchCameraType();
    //resetView();
    clearMeasure();
    resizeRenderer(app.orthographicFrustumSize);

  } catch (error) {
    setStatus(`Error: ${error.message}`);
    console.error(error);
  }
}

async function loadSecondStructure(content, fileName = '', isDefault = false) {
  try {
    const lower = (fileName || '').toLowerCase();
    const contentString = typeof content === 'string' ? content : '';
    const treatAsCIF = lower.endsWith('.cif') ||
                      lower.includes('.cif') ||
                      /(^|\W)cif(\W|$)/.test(lower) ||
                      isLikelyCIFContent(contentString);

    if (treatAsCIF) {
      structureData2 = await parseCIF(contentString);
    } else {
      structureData2 = parsePOSCAR(contentString);
    }
    loadColorOverrides();
    loadIndividualAtomColors();
    if (isDefault) {
      setStatus(`Default structure: ${structureData.elements.length} atoms`);
    } else {
      setStatus(`Loaded: ${structureData.elements.length} atoms`);
    }
    addSecondStructure();
    if (structureData2){
    }
    general.structure2OpacityValue=0.5

  } catch (error) {
    setStatus(`Error: ${error.message}`);
    console.error(error);
  }
}

function loadDefaultStructure() {
  // Don't load default structure if we've already loaded a shared structure
  if (general.sharedStructureLoaded) {
    console.log('Skipping default structure load - shared structure already loaded');
    return;
  }

  setStatus('Loading default NaCl structure...');
  setTimeout(() => {
    loadStructure(defaultPOSCAR, 'POSCAR', true);
  }, 100);
}

function init() {

  app.scene = new THREE.Scene();

  const isDarkMode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  if (isDarkMode) {
    console.log("The user prefers a dark theme.");
    app.scene.background = new THREE.Color(0x021302)
    general.defaultBackgroundColor = 0x021302
    general.currentLatticeColor = 0xE7E7E7
   } else {
    console.log("The user prefers a light theme.");
    app.scene.background = new THREE.Color(0xE7E7E7);
    general.defaultBackgroundColor = 0xE7E7E7
    general.currentLatticeColor = 0x021302
   };

  console.log(`picked lattice color ${general.currentLatticeColor}`);
  //
  //


  //get all things related to the main view window from WindowAndSceneControls.js
  initCamera(app.useOrthographicCamera);

  initRenderer();

  initLabelRenderer();

  initControls();

  resizeRenderer(app.orthographicFrustumSize);


  // not even sure what this does??

  const atomTooltip = document.createElement('div');
  atomTooltip.className = 'atom-tooltip';
  atomTooltip.setAttribute('aria-hidden', 'true');
  view.appendChild(atomTooltip);

  // init Angle display windows
  
  ['x', 'y', 'z'].forEach(axis => setupAxisControls(axis));

  updateAngleDisplays();


  initAxesGizmo();



  const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
  app.scene.add(ambientLight);

  // Single main directional light - positioned relative to camera
  app.keyLight = new THREE.DirectionalLight(0xffffff, 5.0);
  app.keyLight.castShadow = false;
  app.scene.add(app.keyLight);

  // Click Atom

  let raycaster = new THREE.Raycaster();
  let mouse = new THREE.Vector2();

  function hideAtomTooltip() {
    if (!atomTooltip) return;
    atomTooltip.classList.remove('visible');
    atomTooltip.setAttribute('aria-hidden', 'true');
    highlightHover.hoveredAtom = null;
  }

  function updateAtomTooltip(event) {
    if (!groups.atomsGroup || !groups.atomsGroup.children.length || !atomTooltip) {
      hideAtomTooltip();
      return;
    }

    const rect = app.renderer.domElement.getBoundingClientRect();
    const clientX = event.clientX;
    const clientY = event.clientY;
    if (clientX == null || clientY == null) {
      hideAtomTooltip();
      return;
    }

    const x = ((clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((clientY - rect.top) / rect.height) * 2 + 1;
    mouse.set(x, y);
    raycaster.setFromCamera(mouse, app.camera);

    const hits = raycaster.intersectObjects(groups.atomsGroup.children, true);
    if (!hits.length) {
      hideAtomTooltip();
      return;
    }
    const hit = hits[0].object;
    const element = hit?.userData?.element || hit?.parent?.userData?.element || null;
    const sourceIndex = hit?.userData?.sourceIndex ?? hit?.parent?.userData?.sourceIndex ?? null;

    if (!element) {
      hideAtomTooltip();
      return;
    }

    // Build list of all atom indices for this element
    const elementAtomIndices = [];
    for (let i = 0; i < structureData.elements.length; i++) {
      if (structureData.elements[i] === element) {
        elementAtomIndices.push(i);
      }
    }

    if (highlightHover.hoveredAtom !== hit) {
      highlightHover.hoveredAtom = hit;

      if (sourceIndex == null) {
        atomTooltip.textContent = `${element}`;
      } else {
        // compute atom number within this element type
        const elementLocalIndex = elementAtomIndices.indexOf(sourceIndex) + 1; // +1 for 1-based display
        const displayIndex = elementLocalIndex || sourceIndex; // fallback if not found
        atomTooltip.textContent = `${element} ${displayIndex}`;
      }
    }


    atomTooltip.style.left = `${clientX - rect.left}px`;
    atomTooltip.style.top = `${clientY - rect.top}px`;
    atomTooltip.classList.add('visible');
    atomTooltip.setAttribute('aria-hidden', 'false');
  }

  app.renderer.domElement.addEventListener('mousemove', updateAtomTooltip);
  app.renderer.domElement.addEventListener('mouseleave', hideAtomTooltip);
  app.renderer.domElement.addEventListener('touchstart', hideAtomTooltip, { passive: true });

  function onClickPick(event){
    // Only handle clicks if a mode is enabled
    if (mode.measureMode === 'none') return;

    // Prevent default behavior to avoid conflicts with pan/zoom
    event.preventDefault();
    event.stopPropagation();

    // Note: Double-click detection is handled by separate onDoubleClickAtom function

    // Handle both mouse and touch events with better error checking
    let clientX, clientY;

    if (event.type === 'touchend' || event.type === 'touchstart') {
      // For touch events, use the appropriate touch list
      const touchList = event.type === 'touchstart' ? event.touches : event.changedTouches;
      if (touchList && touchList.length > 0) {
        clientX = touchList[0].clientX;
        clientY = touchList[0].clientY;
      } else {
        console.warn('Touch event without touch coordinates');
        return;
      }
    } else {
      clientX = event.clientX;
      clientY = event.clientY;
    }

    if (clientX === undefined || clientY === undefined) {
      console.warn('Could not get event coordinates');
      return;
    }

    const rect = app.renderer.domElement.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((clientY - rect.top) / rect.height) * 2 + 1;

    mouse.set(x, y);
    raycaster.setFromCamera(mouse,app.camera);
    if(!groups.atomsGroup) return;

    const hits = raycaster.intersectObjects(groups.atomsGroup.children, true);
    if (!hits.length) {
      // Clicked on empty space - reset selection
      measurements.selectedAtoms.forEach(atom => clearHighlightAtom(atom));
      measurements.selectedAtoms = [];
      clearMeasureGraphics();
      return;
    }

    const hit = hits[0].object;

    // Don't select the same atom twice
    if (measurements.selectedAtoms.includes(hit)) return;

    // Add atom to selection
    measurements.selectedAtoms.push(hit);
    HighlightAtom(hit, measurements.selectedAtoms.length === 1 ? 0xff0000 : measurements.selectedAtoms.length === 2 ? 0x0000ff : 0x00ff00);

    // Handle actions based on mode
    if (mode.measureMode === 'distance' && measurements.selectedAtoms.length === 2) {
      // Distance measurement complete
      addDistanceMeasurement(measurements.selectedAtoms[0], measurements.selectedAtoms[1]);

      // Clear selection
      measurements.selectedAtoms.forEach(atom => clearHighlightAtom(atom));
      measurements.selectedAtoms = [];
      clearMeasureGraphics();
    } else if (mode.measureMode === 'angle' && measurements.selectedAtoms.length === 3) {
      // Angle measurement complete
      addAngleMeasurement(measurements.selectedAtoms[0], measurements.selectedAtoms[1], measurements.selectedAtoms[2]);

      // Clear selection
      measurements.selectedAtoms.forEach(atom => clearHighlightAtom(atom));
      measurements.selectedAtoms = [];
      clearMeasureGraphics();
    } else if (mode.measureMode === 'delete') {
      const idx = hit.userData.sourceIndex;
      if (idx !== undefined && idx >= 0 && idx < structureData.positions.length) {
        // Remove atom from structure
        structureData.positions.splice(idx, 1);
        structureData.elements.splice(idx, 1);
        // Clean selections and graphics
        measurements.selectedAtoms.forEach(atom => clearHighlightAtom(atom));
        measurements.selectedAtoms = [];
        clearMeasureGraphics();
        // Rebuild controls and view
        createBondLengthControls();
        createSpinControls();
        createBackgroundControl();
        updateVisualization();
      }
      return; // nothing else to do in delete mode
    }

    drawMeasureGraphics();
  }

  // Double-click handler for atom highlighting feature
  function onDoubleClickAtom(event) {
    event.preventDefault();
    event.stopPropagation();

    // Handle both mouse and touch events
    let clientX, clientY;
    if (event.changedTouches && event.changedTouches.length > 0) {
      clientX = event.changedTouches[0].clientX;
      clientY = event.changedTouches[0].clientY;
    } else {
      clientX = event.clientX;
      clientY = event.clientY;
    }

    const rect = app.renderer.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2();
    mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;

    // Raycast to find clicked atom
    raycaster.setFromCamera(mouse, app.camera);
    const hits = raycaster.intersectObjects(groups.atomsGroup.children, true);

    if (hits.length > 0) {
      const hit = hits[0];
      const atomMesh = hit.object;

      // Skip ghost atoms
      if (atomMesh.userData.isGhost) return;

      const element = atomMesh.userData.element;
      const sourceIndex = atomMesh.userData.sourceIndex;

      // Double-clicked atom detected

      // Highlight the clicked atom in the structure panel
      highlightAtomInStructurePanel(element, sourceIndex);

      // Add visual glow to the 3D atom
      highlightAtomIn3D(atomMesh);
    }
  }

  // Add event listeners - use touchstart instead of touchend for better responsiveness
  app.renderer.domElement.addEventListener('click', onClickPick);

  // Add double-click listener for atom highlighting feature
  app.renderer.domElement.addEventListener('dblclick', onDoubleClickAtom);


  // Add single click listener to clear highlights when clicking empty space
  app.renderer.domElement.addEventListener('click', (event) => {
    // Only clear highlights if no measurement mode is active
    if (mode.measureMode === 'none') {
      // Small delay to avoid conflicts with double-click
      setTimeout(() => {
        // Check if we clicked on empty space
        const rect = app.renderer.domElement.getBoundingClientRect();
        const mouse = new THREE.Vector2();
        const clientX = event.clientX || (event.changedTouches && event.changedTouches[0].clientX);
        const clientY = event.clientY || (event.changedTouches && event.changedTouches[0].clientY);

        if (clientX && clientY) {
          mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
          mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;

          raycaster.setFromCamera(mouse, app.camera);
          const hits = raycaster.intersectObjects(groups.atomsGroup.children, true);

          // If no atom was clicked, clear highlights
          if (hits.length === 0) {
            clearAllHighlights();
          }
        }
      }, 100);
    }
  });

// --- Event setup for Three.js renderer element ---
const el = app.renderer.domElement;

// Prevent browser gestures (zoom, scroll, long-press menu)
el.style.touchAction = 'none';

// Long-press config
let longPressTimer = null;
let longPressFired = false;
let pointerDownPos = null;
let moved = false;
const LONG_PRESS_MS = 700;        // adjust to preference
const MOVE_THRESHOLD_PX = 10;

// Debounce to suppress synthetic click after touch
let lastTouchTime = 0;
const GHOST_CLICK_DELAY = 400;    // ms window to ignore duplicate clicks

// Desktop: keep double-click
el.addEventListener('dblclick', onDoubleClickAtom);

// Desktop: keep normal click
el.addEventListener('click', (e) => {
  const now = Date.now();
  if (now - lastTouchTime < GHOST_CLICK_DELAY) {
    // Ignore the synthetic click that follows a touch
    return;
  }
  onClickPick(e);
});

// Pointer events handle touch + pen + mouse consistently
el.addEventListener('pointerdown', onPointerDown);
el.addEventListener('pointermove', onPointerMove);
el.addEventListener('pointerup', onPointerUp);
el.addEventListener('pointercancel', onPointerCancel);

function onPointerDown(e) {
  // Track touch separately for long-press
  if (e.pointerType === 'touch') {
    longPressFired = false;
    moved = false;
    pointerDownPos = { x: e.clientX, y: e.clientY };

    longPressTimer = setTimeout(() => {
      longPressFired = true;
      onDoubleClickAtom(e);   // use same logic as double-click
      lastTouchTime = Date.now(); // prevent follow-up ghost click
    }, LONG_PRESS_MS);
  }

  try { e.target.setPointerCapture(e.pointerId); } catch {}
}

function onPointerMove(e) {
  if (!pointerDownPos) return;
  const dx = e.clientX - pointerDownPos.x;
  const dy = e.clientY - pointerDownPos.y;
  if (Math.hypot(dx, dy) > MOVE_THRESHOLD_PX) {
    moved = true;
    clearLongPress();
  }
}

function onPointerUp(e) {
  clearLongPress();
  try { e.target.releasePointerCapture(e.pointerId); } catch {}

  if (e.pointerType === 'touch') {
    // If the long-press already triggered, skip normal tap
    if (longPressFired) {
      longPressFired = false;
      pointerDownPos = null;
      return;
    }

    // Ignore small drags
    if (moved) {
      pointerDownPos = null;
      moved = false;
      return;
    }

    // Normal tap on touch → behave like click
    lastTouchTime = Date.now();
    e.preventDefault(); // prevent synthetic mouse click
    onClickPick(e);
  }

  pointerDownPos = null;
}

function onPointerCancel() {
  clearLongPress();
  pointerDownPos = null;
}

function clearLongPress() {
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
}



  document.getElementById('viewX').onclick = () => {app.controls.reset(); setViewDirection(new THREE.Vector3( 1., 0., 0.))};
  document.getElementById('viewY').onclick = () => {app.controls.reset(); setViewDirection(new THREE.Vector3( 0., 1., 0.))};
  document.getElementById('viewZ').onclick = () => {app.controls.reset(); setViewDirection(new THREE.Vector3( 0., 0., 1.))};


  document.getElementById('viewA').onclick = () => {app.controls.reset(); const {a} = latticeDirs(); setViewDirection(a); };
  document.getElementById('viewB').onclick = () => {app.controls.reset(); const {b} = latticeDirs(); setViewDirection(b); };
  document.getElementById('viewC').onclick = () => {app.controls.reset(); const {c} = latticeDirs(); setViewDirection(c); };
  document.getElementById('resetView').onclick = () => resetView();

  setupStructureInput({
    onLoadStructure: (content, name) => loadStructure(content, name),
    setStatus,
  });

  setupSecondStructureInput({
    onLoadStructure: (content, name) => loadSecondStructure(content, name),
    setStatus,
  });

  // Check for shared structure in URL
  loadSharedStructure();

  // Control handlers
  document.getElementById('showBonds').onchange = (e) => {
    general.showBonds = e.target.checked;
    updateVisualization();
  };

    // Control handlers
  document.getElementById('showPolyhedra').onchange = (e) => {
    general.showPolyhedra = e.target.checked;
    updatePolyhedra();
  };

  document.getElementById('showLattice').onchange = (e) => {
    general.showLattice = e.target.checked;
    updateVisualization();
  };

  document.getElementById('showSecond').onchange = (e) => {
    general.showSecond = e.target.checked;
    let slider = document.getElementById("structure2OpacityValue");
    general.structure2OpacityValue=0.5;
    slider.value=0.5;
    addSecondStructure();
  };

  document.getElementById('showComparisonInfo').onchange = (e) => {
    general.showComparisonInfo = e.target.checked;
    addSecondStructure();
  }

   

  // Toggle for VESTA-style neighbor bonds/ghost atoms
  const neighborBondsEl = document.getElementById('neighborBonds');
  if (neighborBondsEl) {
    neighborBondsEl.onchange = (e) => {
      general.showNeighborBonds = e.target.checked;
      updateVisualization();
    };
  }

  document.getElementById('atomSize').oninput = (e) => {
    general.atomSize = parseFloat(e.target.value);
    document.getElementById('atomSizeValue').textContent = general.atomSize.toFixed(1);
    updateVisualization();
    updateMeasurementMarkers(); // Update ring markers when atom size changes
  };

  document.getElementById('structure2OpacityValue').oninput = (e) => {
    general.structure2OpacityValue = parseFloat(e.target.value);
    document.getElementById('structure2OpacityValue').textContent = general.structure2OpacityValue.toFixed(1);
    if (showSecond){
     general.mainOpacity = 2*structure2OpacityValue
     general.secondOpacity = 1.0

    if (general.structure2OpacityValue < 0.5){
           general.secondOpacity = 2*general.structure2OpacityValue
     general.mainOpacity = 1.0
      }
    else if (general.structure2OpacityValue > 0.5){
      general.mainOpacity = 1-2 * (general.structure2OpacityValue - 0.5)
      general.secondOpacity = 1.0
      addSecondStructure(1.0)
      updateAtoms(1-2 * (general.structure2OpacityValue - 0.5))
      }
    else {
      general.secondOpacity =1.0
      general.mainOpacity = 1.0
    }
    updateVisualization(general.mainOpacity,general.secondOpacity);
      
    updateVisualization({
          reRenderAtoms: false,
          reRenderBonds: false,
          reRenderLattice: false,
          reRenderOther: true
        });


    }
  };

  // Bond width control
  const bondWidthSlider = document.getElementById('bondWidth');
  const bondWidthValue = document.getElementById('bondWidthValue');
  if (bondWidthSlider && bondWidthValue) {
    bondWidthSlider.oninput = (e) => {
      const v = parseFloat(e.target.value);
      // clamp defensively
      general.bondRadius = Math.max(0.005, Math.min(1.0, isNaN(v) ? bondRadius : v));
      bondWidthValue.textContent = general.bondRadius.toFixed(2);
      updateVisualization();
    };
  }

  let checkbox_second = document.getElementById("showSecond");
      checkbox_second.checked = false; // explicitly untick

    let checkbox_polyhedra = document.getElementById("showPolyhedra");
      checkbox_polyhedra.checked = false; // explicitly untick 

      let checkbox_showComparisonInfo = document.getElementById("showComparisonInfo");
      checkbox_showComparisonInfo.checked = false; // explicitly untick

     let checkbox_secondBonds = document.getElementById("showSecondBonds");
      checkbox_secondBonds.checked = false; // explicitly untick

  let checkbox_secondLattice = document.getElementById("showSecondLattice");
      checkbox_secondLattice.checked = false; // explicitly untick



  let checkbox_neighbours = document.getElementById("neighborBonds");
      checkbox_neighbours.checked = false; // explicitly untick

  // New control handlers
  document.getElementById('orthographicCamera').onchange = (e) => {
    app.useOrthographicCamera = e.target.checked;
    switchCameraType();
  };

  document.getElementById('defaultColors').onchange = (e) => {
    general.useDefaultColors = e.target.checked;
    updateVisualization(); // also re-renders composition
  };

  // Mobile measurement toggle functionality
  document.getElementById('measurementToggle').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const panel = document.getElementById('measurementPanel');
    panel.classList.toggle('expanded');
  });

  // Mobile camera toggle functionality
  document.getElementById('cameraToggle').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const panel = document.getElementById('cameraPanel');
    panel.classList.toggle('expanded');
  });

  // New measurement tool handlers with improved click handling
  document.getElementById('distanceModeBtn').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    const button = document.getElementById('distanceModeBtn');
    const wasActive = mode.measureMode === 'distance';

    // Clear previous mode
    document.querySelectorAll('.measure-tool-btn').forEach(btn => btn.classList.remove('active'));
    measurements.selectedAtoms.forEach(atom => clearHighlightAtom(atom));
    measurements.selectedAtoms = [];
    clearMeasureGraphics();

    if (wasActive) {
      mode.measureMode = 'none';
    } else {
      mode.measureMode = 'distance';
      button.classList.add('active');
    }
  });

  document.getElementById('angleModeBtn').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    const button = document.getElementById('angleModeBtn');
    const wasActive = mode.measureMode === 'angle';

    // Clear previous mode
    document.querySelectorAll('.measure-tool-btn').forEach(btn => btn.classList.remove('active'));
    measurements.selectedAtoms.forEach(atom => clearHighlightAtom(atom));
    measurements.selectedAtoms = [];
    clearMeasureGraphics();

    if (wasActive) {
      mode.measureMode = 'none';
    } else {
      mode.measureMode = 'angle';
      button.classList.add('active');
    }
  });

  // Delete atom mode
  document.getElementById('deleteModeBtn').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    const button = document.getElementById('deleteModeBtn');
    const wasActive = mode.measureMode === 'delete';

    document.querySelectorAll('.measure-tool-btn').forEach(btn => btn.classList.remove('active'));
    measurements.selectedAtoms.forEach(atom => clearHighlightAtom(atom));
    measurements.selectedAtoms = [];
    clearMeasureGraphics();

    if (wasActive) {
      mode.measureMode = 'none';
    } else {
      mode.measureMode = 'delete';
      button.classList.add('active');
    }
  });

  document.getElementById('clearAllMeasurements').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    clearAllMeasurements();
    // Also clear active measurement mode
    document.querySelectorAll('.measure-tool-btn').forEach(btn => btn.classList.remove('active'));
    mode.measureMode = 'none';

    // Also restore deleted atoms
    if (originalStructureData) {
      general.currentLattice = structureData.lattice


    const parsed = JSON.parse(JSON.stringify(originalStructureData));
          // wherever you parse:

     // Ensure the fields exist and are the right typed arrays
      //
    structureData.positions = parsed.positions ?? null;
    structureData.elements  = parsed.elements  ?? null;
    structureData.lattice   = parsed.lattice   ?? null;
    structureData.supercell = parsed.supercell ?? null;
      if (general.modifiedLattice != null){
        structureData.lattice = general.modifiedLattice
      }
      if (general.currentSupercell != null){
          createSupercell(currentSupercell.nx,currentSupercell.ny,currentSupercell.nz)
          }
      createBondLengthControls();
      createSpinControls();
      createBackgroundControl();
      updateVisualization();
      clearMeasure();
    }
  });

  // Add touch event handlers for better mobile support
  document.getElementById('distanceModeBtn').addEventListener('touchstart', (e) => {
    e.preventDefault();
    e.stopPropagation();
    document.getElementById('distanceModeBtn').click();
  });

  document.getElementById('angleModeBtn').addEventListener('touchstart', (e) => {
    e.preventDefault();
    e.stopPropagation();
    document.getElementById('angleModeBtn').click();
  });

  document.getElementById('clearAllMeasurements').addEventListener('touchstart', (e) => {
    e.preventDefault();
    e.stopPropagation();
    document.getElementById('clearAllMeasurements').click();
  });

  document.getElementById('resetBondLengths').onclick = resetBondLengths;

  // Initialize atomSize from the UI slider so the initial view respects the slider value
  (function initAtomSizeFromSlider(){
    const slider = document.getElementById('atomSize');
    const span = document.getElementById('atomSizeValue');
    if (slider) {
      const v = parseFloat(slider.value);
      if (!isNaN(v)) {
        general.atomSize = v; // apply slider value to internal scale
        if (span) span.textContent = general.atomSize.toFixed(1);
      }
    }
  })();

  // Initialize bond width from slider
  (function initBondWidthFromSlider(){
    const slider = document.getElementById('bondWidth');
    const span = document.getElementById('bondWidthValue');
    if (slider) {
      const v = parseFloat(slider.value);
      if (!isNaN(v)) {
        general.bondRadius = v;
        if (span) span.textContent = general.bondRadius.toFixed(2);
      }
    }
  })();

  app.camera.position.set(20, 20, 20);
  app.controls.update();
 
  console.log("Loading structure...")
  // Load default structure after everything is initialized
  loadDefaultStructure();

  animation_update();
  }
  window.addEventListener('resize', () => resizeRenderer(app.orthographicFrustumSize));
  window.addEventListener('error', e => setStatus(`Error: ${e.message}`));
  window.addEventListener('unhandledrejection', e => setStatus(`Promise error: ${e.reason}`));

// Panel toggle functionality for all screen sizes
function setupMobileMenu() {
  const hamburger = document.getElementById('mobileMenuToggle');
  const overlay = document.getElementById('mobileOverlay');
  const ui = document.getElementById('ui');

  function togglePanel() {
    if (!ui) return;

    if (window.innerWidth > 1024) {
      // Desktop: toggle panel-hidden
      ui.classList.toggle('panel-hidden');
      document.body.classList.toggle('panel-hidden');
    } else {
      // Mobile: toggle panel-open
      ui.classList.toggle('panel-open');
      if (overlay) overlay.classList.toggle('active');
    }

    // Refresh renderer immediately after layout change
    if (typeof resizeRenderer === 'function') {
      resizeRenderer(app.orthographicFrustumSize);
    }
  }

  function closePanel() {
    if (!ui) return;
    ui.classList.remove('panel-open', 'panel-hidden');
    document.body.classList.remove('panel-hidden');
    if (overlay) overlay.classList.remove('active');
  }

  if (hamburger) {
    hamburger.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      togglePanel();
    });

    hamburger.addEventListener('touchend', (e) => {
      e.preventDefault();
      e.stopPropagation();
      togglePanel();
    });
  }

  if (overlay) {
    overlay.addEventListener('click', (e) => {
      e.preventDefault();
      closePanel();
    });

    overlay.addEventListener('touchend', (e) => {
      e.preventDefault();
      closePanel();
    });
  }

  // Add viewport meta tag if not present for proper mobile scaling
  if (!document.querySelector('meta[name="viewport"]')) {
    const viewport = document.createElement('meta');
    viewport.name = 'viewport';
    viewport.content = 'width=device-width, initial-scale=1.0, user-scalable=no';
    document.head.appendChild(viewport);
  }

  console.log(app.scene)
}

init();
//resetView();
setupMobileMenu();
