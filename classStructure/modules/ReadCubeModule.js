// ReadCubeModule.js
// Parser for Gaussian .cube volumetric files + Marching Cubes isosurface extraction
// Exports: readCubeFile(), updateField()

import * as THREE from "three";

//------------------------------------------------------------
//  Periodic table (lookup table for cube files as it contains 
//                  only the element number) ! Check if everythig is correct!
//------------------------------------------------------------
export const PT = {
  1: "H",   2: "He",
  3: "Li",  4: "Be",  5: "B",   6: "C",   7: "N",   8: "O",   9: "F",   10: "Ne",
  11: "Na", 12: "Mg", 13: "Al", 14: "Si", 15: "P",  16: "S",  17: "Cl", 18: "Ar",
  19: "K",  20: "Ca", 21: "Sc", 22: "Ti", 23: "V",  24: "Cr", 25: "Mn", 26: "Fe",
  27: "Co", 28: "Ni", 29: "Cu", 30: "Zn", 31: "Ga", 32: "Ge", 33: "As", 34: "Se",
  35: "Br", 36: "Kr",
  37: "Rb", 38: "Sr", 39: "Y",  40: "Zr", 41: "Nb", 42: "Mo", 43: "Tc", 44: "Ru",
  45: "Rh", 46: "Pd", 47: "Ag", 48: "Cd", 49: "In", 50: "Sn", 51: "Sb", 52: "Te",
  53: "I",  54: "Xe",
  55: "Cs", 56: "Ba",
  // Lanthanides
  57: "La", 58: "Ce", 59: "Pr", 60: "Nd", 61: "Pm", 62: "Sm", 63: "Eu", 64: "Gd",
  65: "Tb", 66: "Dy", 67: "Ho", 68: "Er", 69: "Tm", 70: "Yb", 71: "Lu",
  // Transition continues
  72: "Hf", 73: "Ta", 74: "W",  75: "Re", 76: "Os", 77: "Ir", 78: "Pt", 79: "Au",
  80: "Hg", 81: "Tl", 82: "Pb", 83: "Bi", 84: "Po", 85: "At", 86: "Rn",
  87: "Fr", 88: "Ra",
  // Actinides
  89: "Ac", 90: "Th", 91: "Pa", 92: "U",  93: "Np", 94: "Pu", 95: "Am", 96: "Cm",
  97: "Bk", 98: "Cf", 99: "Es", 100: "Fm", 101: "Md", 102: "No", 103: "Lr",
  // Final row
  104: "Rf", 105: "Db", 106: "Sg", 107: "Bh", 108: "Hs", 109: "Mt", 110: "Ds",
  111: "Rg", 112: "Cn", 113: "Nh", 114: "Fl", 115: "Mc", 116: "Lv", 117: "Ts",
  118: "Og"
};


//------------------------------------------------------------
//  readCubeFile(file) → { lattice, positions_cart, field }
//------------------------------------------------------------
export async function readCubeFile(content,fileName) {

  const lines = content.split(/\r?\n/);

  let i = 0;

// Normalize slice
const min = Math.min(...slice);
const max = Math.max(...slice);
const norm = slice.map(v => (v - min) / (max - min));

// Create colormap texture
const tex = new THREE.DataTexture(norm, w, h, THREE.RedFormat, THREE.FloatType);
tex.needsUpdate = true;

const geom = new THREE.PlaneGeometry(w, h);
const mat = new THREE.ShaderMaterial({
uniforms: {
sliceTex: { value: tex },
},
vertexShader: `
varying vec2 vUv;
void main() {
vUv = uv;
gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`,
fragmentShader: `
uniform sampler2D sliceTex;
varying vec2 vUv;

vec3 colormap(float t) {
// Inferno-like map
return vec3(
smoothstep(0.0,0.3,t),
pow(t,1.5),
pow(t,3.0)
);
}

void main() {
float v = texture2D(sliceTex, vUv).r;
gl_FragColor = vec4(colormap(v), 1.0);
}
`
});

const mesh = new THREE.Mesh(geom, mat);
mesh.userData.axis = axis;
return mesh;
}

//------------------------------------------------------------
// updateField(scene, structure, field, iso)
// Adds isosurface to existing atom/bond visualizer
//------------------------------------------------------------
export function updateField(scene, structure, field, iso = 0.75) {
// Remove previous field mesh if any
if (structure.__fieldMesh) {
scene.remove(structure.__fieldMesh);
structure.__fieldMesh.geometry.dispose();
structure.__fieldMesh.material.dispose();
}

//--------------------------------------------------------
// Build marching cubes isosurface in voxel space
//--------------------------------------------------------
const mesh = buildIsosurface(field, iso);

//--------------------------------------------------------
// Align the voxel cube with real‑space lattice
//--------------------------------------------------------
const { nx, ny, nz } = field;

// Convert 0→1 cube into actual cell
const cell = new THREE.Matrix4();
cell.set(
field.voxel[0][0] * nx, field.voxel[1][0] * ny, field.voxel[2][0] * nz, field.origin[0],
field.voxel[0][1] * nx, field.voxel[1][1] * ny, field.voxel[2][1] * nz, field.origin[1],
field.voxel[0][2] * nx, field.voxel[1][2] * ny, field.voxel[2][2] * nz, field.origin[2],
0, 0, 0, 1
);

mesh.applyMatrix4(cell);

//--------------------------------------------------------
// Add to scene and record
//--------------------------------------------------------
scene.add(mesh);
structure.__fieldMesh = mesh;
}
