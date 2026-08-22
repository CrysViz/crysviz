// ReadCubeModule.js
// Parser for Gaussian .cube volumetric files + Marching Cubes isosurface extraction
// Exports: readCubeFile(), updateField()

import * as THREE from "../external/three/three.module.js";

import { initializeWithPOSCAR } from '../ui/StructureInputModule.js';
import { fieldBrowser, updateFieldPanel } from "../ui/FieldPanel.js";
import { app, groups, fileBrowser, structureShip } from '../state/store.js';
import { readCHGCAR } from "../io/ReadChgcarModule.js";
import { readCubeFile } from "../io/ReadCubeModule.js";
import { readWAVECAR } from "../io/ReadWavecarModule.js";
import { Isosurface, FieldCatalog, FieldContainer } from "../model/index.js";
import { choiceDialog, noticeDialog } from "../ui/ConfirmModal.js";





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
      // A field that dips below zero gets the signed treatment (a positive and a
      // negative isosurface); one that does not only needs the positive half.
      //
      // Read from the field's own precomputed minimum rather than re-scanning
      // `values`. Every producer now fills the stats in (computeFieldStats /
      // wf_reduce_scalar), and the old full reduce cost a walk of a
      // multi-million-entry array on every field switch. The scan is kept only
      // as a fallback for a field that arrived without stats.
      const actualMinValue = Number.isFinite(field.minValue)
        ? field.minValue
        : field.values.reduce((m, v) => Math.min(m, v), Infinity);
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

/**
 * Point the field browser at a freshly-parsed container and draw its first
 * field. Shared by the eagerly-parsed field formats, whose fields are all in
 * memory by the time they get here.
 */
function adoptEagerFieldContainer(container) {
  if (!container) return;
  fieldBrowser.setCatalog(container.catalog);
  fieldBrowser.setSelectedField(0); // Select the first field by default
  const selectedField = fieldBrowser.selectedField;
  if (!selectedField) return;

  setActiveField(selectedField);
  updateField();
}

export function parseCubeFile(content, fileName) {
  // Parse the Cube file (volumetric fields are now included in the structure).
  // Errors intentionally propagate to loadStructure and the host facade.
  const result = readCubeFile(content, fileName);

  adoptEagerFieldContainer(result.structure_with_field.volumetricFields);

  const container = initializeWithPOSCAR(result.structure_with_field, fileName);
  updateFieldPanel();
  console.log(`Cube file parsed successfully with ${result.structure_with_field.volumetricFields ? result.structure_with_field.volumetricFields.fields.length : 0} volumetric fields`);
  return container;
}

export function parseCHGCARFile(content, fileName, source = 'CHGCAR') {
  // Parse the CHGCAR file (volumetric fields are now included in the structure).
  // Errors intentionally propagate to loadStructure and the host facade.
  const result = readCHGCAR(content, fileName, source);

  adoptEagerFieldContainer(result.structure_with_field.volumetricFields);

  const container = initializeWithPOSCAR(result.structure_with_field, fileName);
  updateFieldPanel();
  console.log(`CHGCAR file parsed successfully with ${result.structure_with_field.volumetricFields ? result.structure_with_field.volumetricFields.fields.length : 0} volumetric fields`);
  return container;
}

//------------------------------------------------------------
//  WAVECAR
//------------------------------------------------------------

/** Largest tolerated per-component difference between two lattices, in Angstrom. */
const LATTICE_MATCH_TOLERANCE = 1e-3;

/** Componentwise comparison of two 3×3 lattices. */
function latticesMatch(a, b, tolerance = LATTICE_MATCH_TOLERANCE) {
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      if (Math.abs((a[i]?.[j] ?? NaN) - (b[i]?.[j] ?? NaN)) > tolerance) return false;
    }
  }
  return true;
}

/** Largest per-component difference, for the dialog's detail block. */
function largestLatticeDeviation(a, b) {
  let worst = 0;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      worst = Math.max(worst, Math.abs((a[i]?.[j] ?? 0) - (b[i]?.[j] ?? 0)));
    }
  }
  return worst;
}

/** Side-by-side lattice listing for the dialog. */
function describeLatticePair(structureLattice, wavecarLattice) {
  const row = (label, lattice) => [`${label}:`]
    .concat((lattice || []).map((v, i) => `  ${'abc'[i]}  `
      + v.map((x) => x.toFixed(4).padStart(10)).join(' ')))
    .join('\n');
  return `${row('Loaded structure', structureLattice)}\n\n${row('WAVECAR', wavecarLattice)}`;
}

/** The StructureContainer that owns a given structure, or null. */
function containerForStructure(structure) {
  if (!structure) return null;
  return structureShip.container.find((c) => c?.structures?.includes(structure)) || null;
}

/**
 * Open a WAVECAR.
 *
 * Unlike the other field formats this does not parse anything up front — it
 * builds a proxy (`model/WavefunctionSource.js`) over the file and a catalog of
 * spin/k-point/band entries, none of which are loaded until the user asks.
 *
 * A WAVECAR carries the cell but no atomic positions, so it has to be shown
 * inside some structure. When the selected structure's lattice matches, it is
 * attached silently — the ordinary POSCAR-then-WAVECAR workflow, where there is
 * nothing to decide. Otherwise the user is asked, because all three answers are
 * legitimate and guessing would either lose data or silently misplace it.
 *
 * @param {import('../io/FileSource.js').FileSource} source
 * @param {string} fileName
 * @returns {Promise<import('../model/index.js').StructureContainer | null>} null if cancelled
 */
export async function parseWavecarFile(source, fileName) {
  // Header decode only. Throws (with a specific message) for a non-collinear
  // file, an unknown RTAG, or a plane-wave count that cannot be reconciled with
  // the cutoff — all of which are better surfaced now than on the first click.
  const result = await readWAVECAR(source, fileName);
  const wf = result.source;

  const selected = fileBrowser.selectedStructure;
  const matches = selected && latticesMatch(selected.lattice, wf.lattice);

  let attachTo = null;
  if (matches) {
    attachTo = selected;
  } else {
    const choices = [];
    if (selected) {
      choices.push({
        value: 'attach',
        label: `Add to the loaded structure (${selected.uniqueElements.join('') || 'current cell'})`,
        description: 'Use the loaded structure and its cell for the grid geometry, ignoring the '
          + "WAVECAR's own cell. The mismatch stays flagged in the field panel.",
      });
    }
    choices.push({
      value: 'standalone',
      label: 'Load as its own structure',
      description: "Use the WAVECAR's cell, with no atoms — the isosurface is shown in an "
        + 'empty box.',
    });
    choices.push({ value: 'cancel', label: 'Cancel', description: 'Do not load the file.' });

    const message = selected
      ? `The cell in ${fileName} does not match the loaded structure.`
      : `${fileName} contains a cell but no atomic positions, and no structure is loaded to `
        + 'attach it to.';

    const choice = await choiceDialog(message, {
      title: 'WAVECAR cell does not match',
      choices,
      detail: selected ? describeLatticePair(selected.lattice, wf.lattice) : null,
      cancelValue: 'cancel',
    });

    if (choice === 'cancel' || choice === null) return null;
    if (choice === 'attach') attachTo = selected;
  }

  // When attaching to a structure whose cell differs, that structure's cell is
  // what everything else in the scene is drawn in, so the field grid has to be
  // expressed in it too or the isosurface would sit in a box of its own.
  const usingHostCell = Boolean(attachTo) && !matches;
  if (usingHostCell) wf.displayLattice = attachTo.lattice;

  const catalog = FieldCatalog.fromWavefunction(wf, { source: 'WAVECAR' });

  // Memory pressure: the proxy caches expanded wavefunctions under a fixed
  // budget and drops the least recently used ones, one at a time, once that
  // budget is reached. That is automatic and needs no input, but it is not
  // invisible — a band the user loaded earlier quietly goes back to showing
  // "Load" — so say it once, the first time it happens for this file. Repeating
  // it on every subsequent eviction would be noise: by then the behaviour is
  // known, and evictions are routine while browsing a large file.
  let evictionAnnounced = false;
  wf.onEvicted = ({ freed }) => {
    // The rows for the dropped bands must go back to their unloaded state.
    catalog.notify();
    if (evictionAnnounced) return;
    evictionAnnounced = true;
    noticeDialog(
      `${fileName} has filled the wavefunction memory budget, so the ${freed === 1
        ? 'least recently used wavefunction has' : `${freed} least recently used wavefunctions have`}`
      + ' been freed to make room. This happens automatically from now on, and the'
      + ' wavefunction currently being displayed is never freed.',
      {
        title: 'Freeing older wavefunctions',
        detail: 'Nothing is lost: anything freed can be loaded again from the file'
          + ' at any time, it simply has to be recomputed.',
      });
  };
  const container = new FieldContainer({
    fileName,
    source: 'WAVECAR',
    fields: [],          // nothing is loaded yet; the catalog is the source of truth
    catalog,
    proxySource: wf,
  });
  if (usingHostCell) {
    container.cellMismatch = {
      structureLattice: attachTo.lattice,
      fileLattice: wf.lattice,
      deviation: largestLatticeDeviation(attachTo.lattice, wf.lattice),
    };
  }

  fieldBrowser.setCatalog(catalog);

  if (attachTo) {
    // No new file-browser row: the wavefunctions belong to a structure that is
    // already listed, so hand back that structure's existing container.
    attachTo.volumetricFields = container;
    const owner = containerForStructure(attachTo);
    if (owner) {
      console.log(`WAVECAR opened and attached to the selected structure — ${wf.describe()}`);
      return owner;
    }
    // The selected structure is not in the file browser's registry — it was
    // built outside the normal load path (an addon, a test harness). Falling
    // through to register the WAVECAR's own cell is better than returning null,
    // which loadStructure would report as a failed load.
    console.warn('WAVECAR: the selected structure is not registered in the file browser; '
      + 'loading the file as its own entry instead.');
  }

  result.structure.volumetricFields = container;
  const structureContainer = initializeWithPOSCAR(result.structure, fileName);
  console.log(`WAVECAR opened as its own structure — ${wf.describe()}`);
  return structureContainer;
}

// End of file
