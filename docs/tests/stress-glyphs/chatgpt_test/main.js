import * as THREE from './three/three.module.js';
import { TrackballControls } from './three/TrackballControls.js';

import { eigensystemStress, stressToSuperquadric, orientationMatrix } from './tensor.js';
import { superquadricGeometry } from './superquadratic.js';

// DOM
const textarea = document.getElementById('matrix');

// Scene
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x111111);

// Camera
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 20);
camera.position.set(2.5, 2.5, 2.5);
camera.lookAt(0, 0, 0);

// Renderer
const renderer = new THREE.WebGLRenderer({ antialias: true });
document.body.appendChild(renderer.domElement);

// Responsive resize
const resize = () => {
  const w = window.innerWidth - 280;
  const h = window.innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
};
resize();
window.addEventListener('resize', resize);

// Controls
const controls = new TrackballControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;

// Soft lighting
scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 0.9));
scene.add(new THREE.AmbientLight(0xffffff, 0.6));

let glyph = null;
// --- Parse a 3x3 matrix from textarea input ---
function parseMatrix(text) {
  const rows = text.trim().split('\n');
  if (rows.length !== 3) return null;
  return rows.map(r => {
    const v = r.trim().split(/\s+/).map(Number);
    return v.length === 3 && v.every(Number.isFinite) ? v : null;
  });
}

// --- Update or create the V3S glyph ---

function updateGlyph() {
  const T = parseMatrix(textarea.value);
  if (!T || T.some(r => r === null)) return;

  if (glyph) scene.remove(glyph);

  // Eigen-decomposition
  const { evals, evecs } = eigensystemStress(T);
  const { alpha, beta, scale } = stressToSuperquadric(evals);

  // Generate superquadric geometry
  const geom = superquadricGeometry(alpha, beta, scale);
  const posAttr = geom.getAttribute('position');
  const colors = [];

  const maxAbs = Math.max(...evals.map(Math.abs), 1e-6);
  const sigma = 0.5 * scale; // Gaussian along axis

  // Normalize eigenvectors
  const axes = evecs.map(v => {
    const len = Math.hypot(...v);
    return v.map(x => x / len);
  });

  // Determine the number of segments used in parametric mesh
  const uCount = geom.parameters?.segmentsU || 32; // fallback if not stored
  const vCount = geom.parameters?.segmentsV || 32;

  // For each vertex, we need its (u,v) index in the parametric grid
  // Assume vertices are ordered row-major: v loop outer, u loop inner
  for (let i = 0; i < posAttr.count; i++) {
    const x = posAttr.getX(i);
    const y = posAttr.getY(i);
    const z = posAttr.getZ(i);
    const vtx = [x, y, z];

    let r = 0, b = 0;
    let assigned = false;

    // --- Axis-parametric assignment ---
    for (let j = 0; j < 3; j++) {
      const axis = axes[j];
      // Check if the vertex lies along the principal axis direction
      // i.e., its perpendicular components in superquadric param space are near zero
      // Compute dot along axis
      const dot = vtx[0]*axis[0] + vtx[1]*axis[1] + vtx[2]*axis[2];

      // Compute perpendicular distance to axis
      const proj = axis.map(a => a*dot);
      const perp = vtx.map((vi,k) => vi - proj[k]);
      const dist = Math.hypot(...perp);

      // Assign if close to axis (Patel-style parametric intersection)
      if (dist < 1e-3 * scale) {
        const ev = evals[j]/maxAbs;
        const w = Math.exp(-(dot*dot)/(2*sigma*sigma));
        if (ev > 0) r = w;
        else b = w;
        assigned = true;
        break; // assign to only one axis
      }
    }

    // --- Disc fallback ---
    if (!assigned) {
      // Disc: choose largest positive eigenvalue
      let maxEv = -Infinity;
      for (let j = 0; j < 3; j++) {
        if (evals[j] > maxEv) maxEv = evals[j];
      }
      r = 0.5;
      b = 0;
    }

    colors.push(r, 0, b);
  }

  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

  const mat = new THREE.MeshPhongMaterial({
    vertexColors: true,
    shininess: 10,
    specular: 0x222222
  });

  glyph = new THREE.Mesh(geom, mat);

  // Apply orientation
  const R = orientationMatrix(evecs);
  glyph.matrix.set(
    R[0], R[1], R[2], 0,
    R[3], R[4], R[5], 0,
    R[6], R[7], R[8], 0,
    0, 0, 0, 1
  );
  glyph.matrixAutoUpdate = false;

  scene.add(glyph);
}


function updateTensorArrows() {
  const T = parseMatrix(textarea.value);
  if (!T || T.some(r => r === null)) return;

  if (glyph) scene.remove(glyph);

  const { evals, evecs } = eigensystemStress(T);
  glyph = new THREE.Group();

  for (let i = 0; i < 3; i++) {
    const ev = evals[i];
    const axis = new THREE.Vector3(...evecs[i]).normalize();
    const color = ev > 0 ? 0xff0000 : 0x0000ff;

    const arrow = new THREE.ArrowHelper(
      axis,
      new THREE.Vector3(0,0,0),
      Math.abs(ev),
      color,
      0.1,
      0.05
    );
    glyph.add(arrow);
  }

  scene.add(glyph);
}



// --- Render loop (with TrackballControls) ---
function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}



// Input handler
textarea.addEventListener('input', updateGlyph);

// Initial glyph
updateTensorArrows()

// Render loop
animate();

