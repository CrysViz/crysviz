// ReadCubeModule.js
// Parser for Gaussian .cube volumetric files + Marching Cubes isosurface extraction
// Exports: readCubeFile(), updateField()

import * as THREE from "three";

//------------------------------------------------------------
//  Periodic table (extend if needed)
//------------------------------------------------------------
const PT = {
  1: "H", 2: "He", 3: "Li", 4: "Be", 5: "B", 6: "C", 7: "N", 8: "O",
  9: "F", 10: "Ne", 11: "Na", 12: "Mg", 13: "Al", 14: "Si", 15: "P",
  16: "S", 17: "Cl", 18: "Ar"
};

//------------------------------------------------------------
//  readCubeFile(file) → { lattice, positions_cart, field }
//------------------------------------------------------------
export async function readCubeFile(url) {
  const text = await fetch(url).then((r) => r.text());
  const lines = text.trim().split(/\n/);

  let i = 0;
  i += 2; // skip comments

  // Atom count + origin
  const [numAtoms, ox, oy, oz] = lines[i++].trim().split(/\s+/).map(Number);

  // Grid + voxel vectors  (voxel vectors are in Angstroms)
  const [nx, vx1, vx2, vx3] = lines[i++].trim().split(/\s+/).map(Number);
  const [ny, vy1, vy2, vy3] = lines[i++].trim().split(/\s+/).map(Number);
  const [nz, vz1, vz2, vz3] = lines[i++].trim().split(/\s+/).map(Number);

  //------------------------------------------------------------
  //  ATOMS
  //------------------------------------------------------------
  const positions_cart = [];
  const elements = [];

  for (let a = 0; a < Math.abs(numAtoms); a++) {
    const parts = lines[i++].trim().split(/\s+/).map(Number);
    const Z = parts[0];
    const x = parts[2];
    const y = parts[3];
    const z = parts[4];

    elements.push(PT[Z] || "X");
    positions_cart.push([x, y, z]);
  }

  //------------------------------------------------------------
  //  LATTICE (full cell vectors)
  //------------------------------------------------------------
  const lattice = [
    [vx1 * nx, vx2 * nx, vx3 * nx],
    [vy1 * ny, vy2 * ny, vy3 * ny],
    [vz1 * nz, vz2 * nz, vz3 * nz]
  ];

  //------------------------------------------------------------
  //  Volumetric data (ELF or density)
  //------------------------------------------------------------
  const values = [];
  while (i < lines.length) {
    const nums = lines[i++].trim().split(/\s+/).map(Number);
    for (const n of nums) values.push(n);
  }

  const field = {
    nx,
    ny,
    nz,
    origin: [ox, oy, oz],
    voxel: [
      [vx1, vx2, vx3],
      [vy1, vy2, vy3],
      [vz1, vz2, vz3]
    ],
    values: new Float32Array(values)
  };

  return new StructureContainer({
    fileName,
    structures: [
      new Structure({
        elements,
        uniqueElements: [...new Set(elements)],
        lattice,
        positions: fracPositions,
        positions_cartesian: atomPositions,
        spins: new Spin({ vectors: [] }),
        forces: new Forces({ vectors: [] }),
        vectorfield: new Vectorfield({
          field,
          dims,
          origin: gridOrigin,
          step: gridSteps
        })
      })
    ]
  });
}

//------------------------------------------------------------
//  MARCHING CUBES  (Three.js built‑in)
//------------------------------------------------------------
function buildIsosurface(field, iso, color = 0x33aaff) {
  const { nx, ny, nz, values } = field;

  const mc = new THREE.MarchingCubes(nx, {
    enableUvs: false,
    enableColors: false
  });

  mc.field = values;
  mc.isolation = iso;
  mc.scale.set(1, 1, 1);

  // Generate geometry
  mc.update();

  const geom = mc.generateGeometry();
  geom.computeVertexNormals();

  return new THREE.Mesh(
    geom,
    new THREE.MeshPhongMaterial({
      color,
      transparent: true,
      opacity: 0.65,
      side: THREE.DoubleSide
    })
  );
}

//------------------------------------------------------------
//  Convert voxel coordinates → world coordinates
//------------------------------------------------------------
function voxelToCartesian(i, j, k, field) {
  const { origin, voxel } = field;
  const [vx, vy, vz] = voxel;

  return [
    origin[0] + i * vx[0] + j * vy[0] + k * vz[0],
    origin[1] + i * vx[1] + j * vy[1] + k * vz[1],
    origin[2] + i * vx[2] + j * vy[2] + k * vz[2]
  ];
}

//------------------------------------------------------------
//------------------------------------------------------------
//  createSliceAxisAligned  (existing)
//------------------------------------------------------------

// (existing function remains unchanged)

//------------------------------------------------------------
//  createPlaneSlice(field, atomPositions) → Mesh
//  Builds a cutting plane through the **centroid of 3 atoms**.
//  The plane is sampled in the volumetric data using trilinear interpolation.
//------------------------------------------------------------
export function createPlaneSlice(field, atomPositions, size = 8, resolution = 256) {
  const { origin, voxel, nx, ny, nz, values } = field;

  //--------------------------------------------------------
  // Convert 3 atom Cartesian coords → plane definition
  //--------------------------------------------------------
  const A = new THREE.Vector3(...atomPositions[0]);
  const B = new THREE.Vector3(...atomPositions[1]);
  const C = new THREE.Vector3(...atomPositions[2]);

  const center = new THREE.Vector3().add(A).add(B).add(C).multiplyScalar(1/3);
  const normal = new THREE.Vector3().subVectors(B, A).cross(new THREE.Vector3().subVectors(C, A)).normalize();

  // Generate basis vectors for the plane
  const u = new THREE.Vector3().subVectors(B, A).normalize();
  const v = new THREE.Vector3().crossVectors(normal, u).normalize();

  //--------------------------------------------------------
  // Helper: trilinear interpolation in voxel space
  //--------------------------------------------------------
  function sampleVolume(x, y, z) {
    // Convert Cartesian → voxel indices
    const dx = x - origin[0];
    const dy = y - origin[1];
    const dz = z - origin[2];

    // Solve linear system for (i,j,k)
    const M = new THREE.Matrix3();
    M.set(
      voxel[0][0], voxel[1][0], voxel[2][0],
      voxel[0][1], voxel[1][1], voxel[2][1],
      voxel[0][2], voxel[1][2], voxel[2][2]
    );

    const inv = new THREE.Matrix3().copy(M).invert();
    const ijk = new THREE.Vector3(dx, dy, dz).applyMatrix3(inv);

    const i = ijk.x;
    const j = ijk.y;
    const k = ijk.z;

    if (i < 0 || j < 0 || k < 0 || i > nx-1 || j > ny-1 || k > nz-1)
      return 0;

    const i0 = Math.floor(i), j0 = Math.floor(j), k0 = Math.floor(k);
    const di = i - i0, dj = j - j0, dk = k - k0;

    function idx(ii, jj, kk) {
      return ii + nx * (jj + ny * kk);
    }

    const c000 = values[idx(i0, j0, k0)];
    const c100 = values[idx(Math.min(i0+1, nx-1), j0, k0)];
    const c010 = values[idx(i0, Math.min(j0+1, ny-1), k0)];
    const c110 = values[idx(Math.min(i0+1, nx-1), Math.min(j0+1, ny-1), k0)];
    const c001 = values[idx(i0, j0, Math.min(k0+1, nz-1))];
    const c101 = values[idx(Math.min(i0+1, nx-1), j0, Math.min(k0+1, nz-1))];
    const c011 = values[idx(i0, Math.min(j0+1, ny-1), Math.min(k0+1, nz-1))];
    const c111 = values[idx(Math.min(i0+1, nx-1), Math.min(j0+1, ny-1), Math.min(k0+1, nz-1))];

    const c00 = c000*(1-di) + c100*di;
    const c01 = c001*(1-di) + c101*di;
    const c10 = c010*(1-di) + c110*di;
    const c11 = c011*(1-di) + c111*di;

    const c0 = c00*(1-dj) + c10*dj;
    const c1 = c01*(1-dj) + c11*dj;

    return c0*(1-dk) + c1*dk;
  }

  //--------------------------------------------------------
  // Sample plane
  //--------------------------------------------------------
  const data = new Float32Array(resolution * resolution);
  let p = 0;
  const half = size / 2;

  for (let iy = 0; iy < resolution; iy++) {
    for (let ix = 0; ix < resolution; ix++) {
      const upos = (ix / (resolution - 1) - 0.5) * size;
      const vpos = (iy / (resolution - 1) - 0.5) * size;

      const world = new THREE.Vector3()
        .copy(center)
        .addScaledVector(u, upos)
        .addScaledVector(v, vpos);

      data[p++] = sampleVolume(world.x, world.y, world.z);
    }
  }

  //--------------------------------------------------------
  // Normalize & colormap texture
  //--------------------------------------------------------
  let min = Infinity, max = -Infinity;
  for (const val of data) { min = Math.min(min,val); max = Math.max(max,val); }
  const norm = new Float32Array(data.length);
  for (let ii = 0; ii < data.length; ii++) norm[ii] = (data[ii]-min)/(max-min);

  const tex = new THREE.DataTexture(norm, resolution, resolution, THREE.RedFormat, THREE.FloatType);
  tex.needsUpdate = true;

  const geom = new THREE.PlaneGeometry(size, size);
  const mat = new THREE.ShaderMaterial({
    uniforms: { sliceTex: { value: tex } },
    vertexShader: `
      varying vec2 vUv;
      void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
    `,
    fragmentShader: `
      uniform sampler2D sliceTex; varying vec2 vUv;
      vec3 colormap(float t){ return vec3(smoothstep(0.0,0.3,t), pow(t,1.5), pow(t,3.0)); }
      void main(){ float v = texture2D(sliceTex,vUv).r; gl_FragColor = vec4(colormap(v),1.0); }
    `
  });

  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.copy(center);

  // Orient the plane to match the normal
  const q = new THREE.Quaternion();
  q.setFromUnitVectors(new THREE.Vector3(0,0,1), normal);
  mesh.quaternion.copy(q);

  return mesh;
}(field, axis, index) → returns THREE.Mesh
//------------------------------------------------------------
export function createSlice(field, axis = "z", index = null) {
  const { nx, ny, nz, values, origin, voxel } = field;

  let w, h, slice;

  if (axis === "x") {
    w = ny; h = nz;
    const i = index !== null ? index : Math.floor(nx/2);
    slice = new Float32Array(w * h);
    let p = 0;
    for (let y = 0; y < ny; y++) {
      for (let z = 0; z < nz; z++) {
        slice[p++] = values[i + nx*(y + ny*z)];
      }
    }
  }
  else if (axis === "y") {
    w = nx; h = nz;
    const j = index !== null ? index : Math.floor(ny/2);
    slice = new Float32Array(w * h);
    let p = 0;
    for (let x = 0; x < nx; x++) {
      for (let z = 0; z < nz; z++) {
        slice[p++] = values[x + nx*(j + ny*z)];
      }
    }
  }
  else {
    // Z slice
    w = nx; h = ny;
    const k = index !== null ? index : Math.floor(nz/2);
    slice = new Float32Array(w * h);
    let p = 0;
    for (let x = 0; x < nx; x++) {
      for (let y = 0; y < ny; y++) {
        slice[p++] = values[x + nx*(y + ny*k)];
      }
    }
  }

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
//  updateField(scene, structure, field, iso)
//  Adds isosurface to existing atom/bond visualizer
//------------------------------------------------------------
export function updateField(scene, structure, field, iso = 0.75) {
  // Remove previous field mesh if any
  if (structure.__fieldMesh) {
    scene.remove(structure.__fieldMesh);
    structure.__fieldMesh.geometry.dispose();
    structure.__fieldMesh.material.dispose();
  }

  //--------------------------------------------------------
  //  Build marching cubes isosurface in voxel space
  //--------------------------------------------------------
  const mesh = buildIsosurface(field, iso);

  //--------------------------------------------------------
  //  Align the voxel cube with real‑space lattice
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
  //  Add to scene and record
  //--------------------------------------------------------
  scene.add(mesh);
  structure.__fieldMesh = mesh;
}

