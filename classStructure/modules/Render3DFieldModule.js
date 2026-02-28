// ReadCubeModule.js
// Parser for Gaussian .cube volumetric files + Marching Cubes isosurface extraction
// Exports: readCubeFile(), updateField()

import * as THREE from "three";

import { MarchingCubes } from "../backend/three/MarchingCubes.js";
import { initializeUIOnLoad, readPOSCAR, initializeWithPOSCAR } from './StructureInputModule.js';
import { fieldBrowser, updateFieldPanel } from "../panels/FieldPanel.js";
import { app, groups } from '../store.js';
import { Field } from "../classes/Field.js";
import { FieldContainer } from "../classes/FieldContainer.js";

//------------------------------------------------------------
//  Periodic table (extend if needed)
//------------------------------------------------------------
const PT = {
  1: "H", 2: "He", 3: "Li", 4: "Be", 5: "B", 6: "C", 7: "N", 8: "O",
  9: "F", 10: "Ne", 11: "Na", 12: "Mg", 13: "Al", 14: "Si", 15: "P",
  16: "S", 17: "Cl", 18: "Ar"
};

const surface_options = {
    opacity: 0.4,
    roughness: 0.3,
    metalness: 0.05,
    clearcoat: 0.4,
    clearcoatRoughness: 0.1,
    side: THREE.DoubleSide,
    transparent: true,
  } 

//------------------------------------------------------------
//  readCubeFile(file) → { lattice, positions_cart, field }
//------------------------------------------------------------
export function readCubeFile(url) {
  const text = url; // url is already the file contents
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
//  readCHGCAR(url) → { lattice, positions_cart, field }
//  Parser for VASP CHGCAR files (supports multiple spin components)
//------------------------------------------------------------
export function readCHGCAR(text, fileName) {
  // Find first empty line and split
  const firstEmptyIndex = text.search(/\n\s*\n/);
  const textAfterEmpty = firstEmptyIndex !== -1 ? text.substring(firstEmptyIndex + 2) : text;
  const textBeforeEmpty = firstEmptyIndex !== -1 ? text.substring(0, firstEmptyIndex) : '';

  const lines = textAfterEmpty.trim().split(/\n/);

  // Grid dimensions line (nx ny nz)
  let nx, ny, nz;
  let nvalues;

  // Read volumetric data (can be multiple blocks for spin-polarized)
  const fields = [];
  let fill_ind = 0;
  let currentValues = null;
  let voxel;
  let i = 0;

  let line;
  while (i < lines.length) {
    // Check for augmentation charges section (skip it)
    let max_arg = 0;
    line = lines[i].trim();
    while (line.startsWith('augmentation')) {
      // Parse the augmentation line to get the count of numbers to skip
      const augTokens = line.split(/\s+/);
      const numToSkip = parseInt(augTokens[3], 10) || 0;
      max_arg = Math.max(max_arg, parseInt(augTokens[2], 10) || 0);
      
      // Skip the required number of values
      let skipped = 0;
      i++;
      while (i < lines.length && skipped < numToSkip) {
        const augLine = lines[i].trim();
        if (augLine === '') {
          i++;
          continue;
        }
        const augNums = augLine.split(/\s+/).filter(s => s.length > 0);
        skipped += augNums.length;
        i++;
      }
      if (i >= lines.length) break;
      line = lines[i].trim();
    }
    // skip any remaining augmentation lines if we had a max_arg
    const numToSkip = max_arg;
    let skipped = 0;
    while (i < lines.length && skipped < numToSkip) {
      const augLine = lines[i].trim();
      if (augLine === '') {
        i++;
        continue;
      }
      const augNums = augLine.split(/\s+/).filter(s => s.length > 0);
      skipped += augNums.length;
      i++;
    }

    if (i >= lines.length) break;
    

    // Check for new grid line (indicates another spin component)
    line = lines[i].trim();
    const tokens = line.split(/\s+/);
    if (tokens.length === 3 && tokens.every(t => /^\d+$/.test(t))) {
      // Save current field if we have data
      if (currentValues && currentValues.length > 0) {
        const absMinValue = currentValues.reduce((m, v) => Math.min(Math.abs(m), Math.abs(v)), Infinity);
        const absMaxValue = currentValues.reduce((m, v) => Math.max(Math.abs(m), Math.abs(v)), 0);
        const minValue = currentValues.reduce((m, v) => Math.min(m, v), Infinity);
        const maxValue = currentValues.reduce((m, v) => Math.max(m, v), -Infinity);
        fields.push(new Field({
          nx,
          ny,
          nz,
          origin: [0, 0, 0],
          voxel: null, // will set later
          values: new Float32Array(currentValues),
          component: fields.length, // 0 for charge density, 1+ for spin components
          label: fields.length == 0 ? 'Charge Density' : `Spin Density`,
          minValue: minValue,
          maxValue: maxValue,
          absMinValue: absMinValue,
          absMaxValue: absMaxValue
        })); 
      }
      fill_ind = 0;
      [nx, ny, nz] = tokens.map(Number);
      nvalues = nx * ny * nz;
      currentValues = new Array(nvalues);
      i++;
      // Parse volumetric data  
      while (i < lines.length && fill_ind < nvalues) {
        line = lines[i].trim();
        const nums = line.split(/\s+/).filter(s => s.length > 0).map(Number);
        for (let j = 0; j < nums.length; j++) {
          if (!isNaN(nums[j]) && fill_ind < nvalues) currentValues[fill_ind++] = nums[j];
        }
        i++;
      }
      continue;
    }

    i++;
  }

  // Push final field
  if (currentValues && currentValues.length > 0) {
    const absMinValue = currentValues.reduce((m, v) => Math.min(Math.abs(m), Math.abs(v)), Infinity);
    const absMaxValue = currentValues.reduce((m, v) => Math.max(Math.abs(m), Math.abs(v)), 0);
    const minValue = currentValues.reduce((m, v) => Math.min(m, v), Infinity);
    const maxValue = currentValues.reduce((m, v) => Math.max(m, v), -Infinity);
    fields.push(new Field({
      nx,
      ny,
      nz,
      origin: [0, 0, 0],
      voxel: null, // will set later
      values: new Float32Array(currentValues),
      component: fields.length, // 0 for charge density, 1+ for spin components
      label: fields.length == 0 ? 'Charge Density' : `Spin Density`,
      minValue: minValue,
      maxValue: maxValue,
      absMinValue: absMinValue,
      absMaxValue: absMaxValue
    }));
  }

  // Create volumetric field container with metadata
  const fieldContainer = new FieldContainer({
    fileName,
    source: 'CHGCAR',
    fieldCount: fields.length,
    fields: fields
  });

  // Parse structure with volumetric fields included
  const structure_with_field = readPOSCAR(textBeforeEmpty, fileName);
  structure_with_field.volumetricFields = fieldContainer;

  // Update voxel field for each component based on structure lattice
  fieldContainer.fields.forEach(field => {
    field.voxel = [
      [structure_with_field.lattice[0][0] / field.nx, structure_with_field.lattice[0][1] / field.nx, structure_with_field.lattice[0][2] / field.nx],
      [structure_with_field.lattice[1][0] / field.ny, structure_with_field.lattice[1][1] / field.ny, structure_with_field.lattice[1][2] / field.ny],
      [structure_with_field.lattice[2][0] / field.nz, structure_with_field.lattice[2][1] / field.nz, structure_with_field.lattice[2][2] / field.nz]
    ];
  });

  return {
    fileName,
    structure_with_field
  };
}


//------------------------------------------------------------
//  MARCHING CUBES  (Three.js built‑in)
//------------------------------------------------------------
function initIsosurfaceMesh(field, colorPos = 0x33aaff, colorNeg = 0xff3333) {
  const { nx, ny, nz, values } = field;
  let material_options = {};
  Object.assign(material_options, surface_options);

  material_options.color = colorPos;
  const materialPos = new THREE.MeshPhysicalMaterial(material_options);

  const maxPolyCount = nx * ny * nz * 5;
  const pos_mesh_instance = new MarchingCubes([nx, ny, nz], materialPos, false, false, maxPolyCount);
  // Copy field values directly into the MarchingCubes field buffer
  for (let i = 0; i < values.length; i++) {
    pos_mesh_instance.field[i] = values[i];
  }

  if (field.useAbsoluteIsoValue) {
    material_options.color = colorNeg;
    const materialNeg = new THREE.MeshPhysicalMaterial(material_options);
    const neg_mesh_instance = new MarchingCubes([nx, ny, nz], materialNeg, false, false, maxPolyCount);
    neg_mesh_instance.field = pos_mesh_instance.field; // share the same field data

    return { pos: pos_mesh_instance, neg: neg_mesh_instance };
  }
  else {
    return pos_mesh_instance;
  }
}

function updateIsosurface(iso) {
  if (!groups.fieldMeshPos || !groups.activeField) return;

  const mc = groups.fieldMeshPos;
  mc.isolation = iso;
  mc.blur(1);
  mc.scale.set(1,1,1);

  mc.update();

  // MarchingCubes is already a Mesh with geometry built-in
  // Compute normals for proper lighting
  mc.geometry.computeVertexNormals();

  // If using absolute isovalue, also update the negative mesh with -iso
  if (groups.activeField.useAbsoluteIsoValue && groups.fieldMeshNeg) {
    
    const mc2 = groups.fieldMeshNeg;
    mc2.isolation = -iso;
    mc2.blur(1);
    mc2.update();

    mc2.geometry.computeVertexNormals();
  }
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

function clearMesh(mesh) {
  if (mesh) {
    app.scene.remove(mesh);
    mesh.geometry.dispose();
    mesh.material.dispose();
  }
}

export function setActiveField(field, absoluteIsoValue = null, color1 = 0x33aaff, color2 = 0xff3333) {
  if (groups.fieldMeshPos) {
    clearMesh(groups.fieldMeshPos);
  }
  if (groups.fieldMeshNeg) {
    clearMesh(groups.fieldMeshNeg);
    groups.fieldMeshNeg = null;
  }

  if (absoluteIsoValue === null) {
    if (field.useAbsoluteIsoValue === null) {
      const actualMinValue = field.values.reduce((m, v) => Math.min(m, v), Infinity);
      field.useAbsoluteIsoValue = actualMinValue < 0; // store in field for future reference
    }
    absoluteIsoValue = field.useAbsoluteIsoValue;
  }

  // determine iso if not provided
  const mesh = initIsosurfaceMesh(field, color1, color2);

  if (absoluteIsoValue) {
    groups.fieldMeshPos = mesh.pos;
    groups.fieldMeshNeg = mesh.neg;
  }
  else {
    groups.fieldMeshPos = mesh;
  }
  groups.activeField = field;
}

export function updateField(iso = null) {
  if (!groups.activeField || !groups.fieldMeshPos) {
    console.warn("No active field to update");
    return;
  }
  // Remove previous field mesh if any
  if (groups.fieldMeshPos) {
    clearMesh(groups.fieldMeshPos);
  }
  if (groups.fieldMeshNeg) {
    clearMesh(groups.fieldMeshNeg);
    groups.fieldMeshNeg = null;
  }

  const field = groups.activeField;

  // determine iso if not provided
  if (iso === null || iso === undefined) {
    if (field.isoValue !== 0) {
      iso = field.isoValue;
    }
    else {
      let min;
      if (field.useAbsoluteIsoValue) {
        min = Math.abs(field.minValue);
      }
      else {
        min = field.minValue;
      }
      const max = field.maxValue;
      iso = (min + max) / 2;
      field.isoValue = iso; // store for future use
    }
  }

  //--------------------------------------------------------
  //  Build marching cubes isosurface in voxel space
  //--------------------------------------------------------
  updateIsosurface(iso);

  //--------------------------------------------------------
  //  Align the voxel cube with real‑space lattice
  //--------------------------------------------------------
  const { nx, ny, nz } = field;

  // Convert 0→1 cube into actual cell (scaled to half the voxel extent)
  const cell = new THREE.Matrix4();
  cell.set(
    field.voxel[0][0] * nx * 0.5, field.voxel[1][0] * ny * 0.5, field.voxel[2][0] * nz * 0.5, field.origin[0],
    field.voxel[0][1] * nx * 0.5, field.voxel[1][1] * ny * 0.5, field.voxel[2][1] * nz * 0.5, field.origin[1],
    field.voxel[0][2] * nx * 0.5, field.voxel[1][2] * ny * 0.5, field.voxel[2][2] * nz * 0.5, field.origin[2],
    0, 0, 0, 1
  );
  // Translate to the midpoint of the full voxel extent
  const midpoint = new THREE.Vector3(
    (field.voxel[0][0] * (nx+1) + field.voxel[1][0] * (ny+1) + field.voxel[2][0] * (nz+1)) * 0.5,
    (field.voxel[0][1] * (nx+1) + field.voxel[1][1] * (ny+1) + field.voxel[2][1] * (nz+1)) * 0.5,
    (field.voxel[0][2] * (nx+1) + field.voxel[1][2] * (ny+1) + field.voxel[2][2] * (nz+1)) * 0.5
  );

  groups.fieldMeshPos.applyMatrix4(cell);
  groups.fieldMeshPos.position.set(midpoint.x, midpoint.y, midpoint.z);

  if (field.useAbsoluteIsoValue && groups.fieldMeshNeg) {
    groups.fieldMeshNeg.applyMatrix4(cell);
    groups.fieldMeshNeg.position.set(midpoint.x, midpoint.y, midpoint.z);
  }


  //--------------------------------------------------------
  //  Add to scene and record
  //--------------------------------------------------------
  app.scene.add(groups.fieldMeshPos);
  if (field.useAbsoluteIsoValue && groups.fieldMeshNeg) {
    app.scene.add(groups.fieldMeshNeg);
  }
}

export function parseCubeFile(content, fileName) {
  try {
    // Parse the cube file and extract structure + field data
    const result = readCubeFile(content, fileName);
    
    // Initialize the structure part normally
    initializeUIOnLoad(result.structureContainer);
    
    // Note: Field visualization controls are now handled by the "Field" button in the control panel
    console.log(`CUBE file parsed successfully`);
    
  } catch (error) {
    console.log(`Error parsing CUBE file: ${error.message}`);
    console.error(error);
  }
}

export function parseCHGCARFile(content, fileName) {
  try {
    // Parse the CHGCAR file (volumetric fields are now included in the structure)
    const result = readCHGCAR(content, fileName);
    
    // Initialize the field rendering
    if (result.structure_with_field.volumetricFields) {
      fieldBrowser.setAvailableFields(result.structure_with_field.volumetricFields.fields);
      fieldBrowser.setSelectedField(0); // Select the first field by default
      const selectedField = fieldBrowser.selectedField;

      setActiveField(selectedField);
      updateField();
    }
    
    // Initialize the structure (volumetricFields are already attached)
    initializeWithPOSCAR(result.structure_with_field, fileName);

    updateFieldPanel();
    
    // Note: Field visualization controls are now handled by the "Field" button in the control panel
    console.log(`CHGCAR file parsed successfully with ${result.structure_with_field.volumetricFields ? result.structure_with_field.volumetricFields.fields.length : 0} volumetric fields`);
    
  } catch (error) {
    console.log(`Error parsing CHGCAR file: ${error.message}`);
    console.error(error);
  }
}

// End of file
