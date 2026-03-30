import { app, general, measurements, fileBrowser } from '../store.js';
import * as THREE from '../external/three/three.module.js';
import { parsePOSCAR } from './StructureInputModule.js';
import { updateAtoms } from './AtomsFracUpdateModule.js';
import { rebuildBonds } from './BondsFracUpdateModule.js';
import { addDistanceMeasurement, addAngleMeasurement, serializeMeasurementRef } from './MeasurementModule.js';
import { createBondLengthControls } from '../panels/BondLengthPanel.js';
import { fracToCart } from './math/index.js';



export function loadFromFilePath() {
  console.log("Trying to load file")
  const hash = window.location.hash;
  const match = hash.match(/^#load-file=(.+)/);
  if (!match) return;

  try {
    const b64 = decodeURIComponent(match[1]);
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const content = new TextDecoder().decode(bytes);
    parsePOSCAR(content, 'loaded.vasp');

    // Update UI as needed
    const structureControls = document.getElementById('structureControls');
    if (structureControls) structureControls.style.display = 'block';
    const structureControls2 = document.getElementById('structureControls2');
    if (structureControls2) structureControls2.style.display = 'block';
    const bondControlsGroup = document.getElementById('bondControlsGroup');
    if (bondControlsGroup) bondControlsGroup.style.display = 'block';
    createBondLengthControls();
    updateAtoms();
    rebuildBonds();
  } catch (e) {
    console.error('Failed to decode file:', e);
  }
}
