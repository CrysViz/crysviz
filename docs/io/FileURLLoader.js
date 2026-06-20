import { app, general, measurements, fileBrowser } from '../state/store.js';
import * as THREE from '../external/three/three.module.js';
import { parsePOSCAR } from '../ui/StructureInputModule.js';
import { addDistanceMeasurement, addAngleMeasurement, serializeMeasurementRef } from '../render/MeasurementModule.js';
import { createBondLengthControls } from '../ui/BondLengthPanel.js';
import { createShareButton} from '../ui/ShareModule.js';
import {loadStructure, updateVisualization} from '../core/crystal-viewer.js';
import {clearMeasure} from '../render/MeasurementModule.js';
import { fracToCart } from '../math/index.js';
import {initCamera, initRenderer, initLabelRenderer,initControls,resizeRenderer,
  initAxesGizmo, disposeGroup, switchCameraType, setViewDirection,resetView,collapseAllAtomExpansions
} from '../ui/WindowAndSceneControls.js'



export function loadFromFilePath() {

  const hash = window.location.hash;
  const match = hash.match(/^#load-file=(.+)/);
  if (!match) return;

  try {
    // Split the hash into filename and content
    const [encodedFilename, encodedContent] = decodeURIComponent(match[1]).split('|');
    const filename = decodeURIComponent(encodedFilename);
    const b64 = decodeURIComponent(encodedContent);
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const content = new TextDecoder().decode(bytes);

    // Call your function
    loadStructure(content, filename, false);

    //createBondLengthControls();
    general.sharedStructureLoaded = true;
    console.warn("Loaded structure from URL")
  } catch (e) {
    console.error('Failed to decode file:', e);
  }
}

