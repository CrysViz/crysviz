// User-placed vacancy markers.
//
// These are a visualisation device, not chemistry. They live in their own list
// on the structure rather than in structure.atoms/elements, which is the whole
// point: bonding, polyhedra, symmetry analysis, MD/relaxation and the chemical
// formula never see them, so none of those needed an exclusion rule. It also
// makes a 100% vacancy expressible, which the occupancy model cannot do - a
// site with no occupants is simply absent from a CIF.
//
// Distinct from the *implicit* vacancy of a partially occupied site (the
// hatched wedge in WedgeAtoms.js). That one is real crystallography read from
// the file; this one is an annotation the user places to point at a defect.
//
// Drawn as a deliberately coarse, faceted sphere so it never reads as a real
// atom, and carries an optional formal charge for annotating charged defects.

import * as THREE from '../external/three/three.module.js';

import { app, groups, fileBrowser, general } from '../state/store.js';
import { fracToCart } from '../math/index.js';

/** Low segment counts on purpose — the faceting is the visual signal. */
const MARKER_SEGMENTS_W = 7;
const MARKER_SEGMENTS_H = 5;

/** Symbols that mean "vacancy" rather than an element. X is ASE's dummy-atom name. */
export const VACANCY_SYMBOLS = new Set(['Va', 'va', 'VA', 'X', 'x']);

const DEFAULT_MARKER_COLOR = 0x9aa4b0;
const DEFAULT_MARKER_RADIUS = 0.55;

/**
 * @param {any} structure
 * @returns {any[]}
 */
export function getVacancyMarkers(structure = fileBrowser.selectedStructure) {
  if (!structure) return [];
  structure.vacancyMarkers ??= [];
  return structure.vacancyMarkers;
}

/**
 * Add a marker at a fractional position.
 *
 * @param {{position: number[], color?: number, radius?: number, oxidationState?: number|null, label?: string}} spec
 * @param {any} [structure]
 * @returns {any} the created marker
 */
export function addVacancyMarker(spec, structure = fileBrowser.selectedStructure) {
  const markers = getVacancyMarkers(structure);
  const marker = {
    position: [...spec.position],
    color: spec.color ?? DEFAULT_MARKER_COLOR,
    radius: spec.radius ?? DEFAULT_MARKER_RADIUS,
    oxidationState: Number.isFinite(spec.oxidationState) ? spec.oxidationState : null,
    label: spec.label ?? `Va${markers.length + 1}`,
  };
  markers.push(marker);
  return marker;
}

/**
 * @param {number} index
 * @param {any} [structure]
 */
export function removeVacancyMarker(index, structure = fileBrowser.selectedStructure) {
  const markers = getVacancyMarkers(structure);
  if (index >= 0 && index < markers.length) markers.splice(index, 1);
}

export function disposeVacancyMarkers() {
  const group = groups.vacancyMarkerGroup;
  if (!group) return;
  group.traverse((child) => {
    if (child.geometry) child.geometry.dispose();
    if (child.material) child.material.dispose();
  });
  app.scene?.remove(group);
  groups.vacancyMarkerGroup = null;
}

/**
 * Rebuild the marker meshes from the structure's marker list. Cheap to call on
 * any structure change; no-op when there are no markers.
 */
export function rebuildVacancyMarkers() {
  disposeVacancyMarkers();

  const structure = fileBrowser.selectedStructure;
  if (!structure || !app.scene) return;
  const markers = getVacancyMarkers(structure);
  if (!markers.length) return;

  const group = new THREE.Group();
  group.name = 'vacancyMarkers';

  // One shared coarse geometry; markers differ only in transform and colour.
  const geometry = new THREE.SphereGeometry(1, MARKER_SEGMENTS_W, MARKER_SEGMENTS_H);
  const cart = fracToCart(markers.map((m) => m.position), structure.lattice);

  markers.forEach((marker, i) => {
    const material = new THREE.MeshStandardMaterial({
      color: marker.color,
      flatShading: true,   // reinforces the faceting; a smooth marker reads as an atom
      roughness: 0.85,
      metalness: 0.0,
      transparent: true,
      opacity: 0.75,
    });
    const mesh = new THREE.Mesh(geometry, material);
    const r = marker.radius * (general.atomSize || 1);
    mesh.scale.set(r, r, r);
    mesh.position.set(cart[i][0], cart[i][1], cart[i][2]);
    mesh.userData.vacancyMarkerIndex = i;
    group.add(mesh);
  });

  groups.vacancyMarkerGroup = group;
  app.scene.add(group);
}
