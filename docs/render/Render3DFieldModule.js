// ReadCubeModule.js
// Parser for Gaussian .cube volumetric files + Marching Cubes isosurface extraction
// Exports: readCubeFile(), updateField()

import * as THREE from "../external/three/three.module.js";

import { initializeWithPOSCAR } from '../ui/StructureInputModule.js';
import { fieldBrowser, updateFieldPanel } from "../ui/FieldPanel.js";
import { app, groups } from '../state/store.js';
import { readCHGCAR } from "../io/ReadChgcarModule.js";
import { readCubeFile } from "../io/ReadCubeModule.js";
import { Isosurface } from "../model/index.js";





//------------------------------------------------------------
//  MARCHING CUBES  (Three.js built‑in)
//------------------------------------------------------------
function initIsosurfaceMesh(field) {

  const isosurface = new Isosurface(field);

  return isosurface;
}

function updateIsosurface(iso, useAbsoluteIsoValue = false) {
  if (!groups.isosurfaceGroup) {
    console.warn("No isosurface group to update");
    return;
  }

  groups.isosurfaceGroup.updateMesh(iso, useAbsoluteIsoValue);
}

export function createSlice(field, axis = "z", index = null) {
  const { nx, ny, nz, values, origin: _origin, voxel: _voxel } = field;

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

export function clearField() {
  if (groups.isosurfaceGroup) {
    groups.isosurfaceGroup.clearMesh();
    app.scene.remove(groups.isosurfaceGroup);
  }
}
export function deleteField() {
  if (groups.isosurfaceGroup) {
    groups.isosurfaceGroup.delete();
    groups.isosurfaceGroup = null;
  }
}

export function setActiveField(field, absoluteIsoValue = null) {
  clearField();

  if (absoluteIsoValue === null) {
    if (field.useAbsoluteIsoValue === null) {
      const actualMinValue = field.values.reduce((m, v) => Math.min(m, v), Infinity);
      field.useAbsoluteIsoValue = actualMinValue < 0; // store in field for future reference
    }
    absoluteIsoValue = field.useAbsoluteIsoValue;
  }

  if (groups.isosurfaceGroup) {
    groups.isosurfaceGroup.delete();
    groups.isosurfaceGroup = null;
  }

  // determine iso if not provided
  const isosurface = initIsosurfaceMesh(field);

  groups.isosurfaceGroup = isosurface;
  groups.activeField = field;
}

export function toggleFieldVisibility(visible) {
  if (groups.activeField) {
    groups.activeField.isVisible = visible;
    if (groups.isosurfaceGroup) {
      groups.isosurfaceGroup.setVisible(visible);
    }
  }
}

export function updateField(iso = null) {
  if (!groups.activeField || !groups.isosurfaceGroup) {
    console.warn("No active field to update");
    return;
  }

  if (!groups.activeField.isVisible) {
    return;
  }

  clearField();
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
  updateIsosurface(iso, field.useAbsoluteIsoValue);

  //--------------------------------------------------------
  //  Add to scene if not already there
  //--------------------------------------------------------
  app.scene.add(groups.isosurfaceGroup);
}

export function parseCubeFile(content, fileName) {
  try {
    // Parse the Cube file (volumetric fields are now included in the structure)
    const result = readCubeFile(content, fileName);
    
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
