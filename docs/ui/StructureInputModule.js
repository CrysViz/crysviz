const NUMBER_PRECISION = 6;
const MATERIALS_PROJECT_OPTIMADE_BASE = 'https://optimade.materialsproject.org/v1/structures/';
const ALEXANDRIA_OPTIMADE_BASE = 'https://alexandria.icams.rub.de/pbe/v1/structures/';

import { StructureContainer } from '../model/StructureContainer.js';
import { Structure } from '../model/Structure.js';
import { Atom } from '../model/Atom.js';
const tableBody = document.querySelector("#objectTable tbody");
import {fileBrowser,structureShip} from '../state/store.js';
import {createRow,selectLastAddedRow} from './FileBrowswerPanel.js';
import {generateID} from '../utils/index.js';
import {buildBondObjects} from '../render/index.js';
import {runPeriodicWrapped} from '../render/index.js';
import {
  transpose3x3,
  invert3x3,
  multiplyMatVec,
  normalizeFractional,
  latticeFromCell,
  cartToFractional,
} from '../math/index.js';

export {
  transpose3x3,
  invert3x3,
  multiplyMatVec,
  normalizeFractional,
  latticeFromCell,
  cartToFractional,
};


function formatNumber(value) {
  if (!Number.isFinite(value)) return '0';
  const fixed = value.toFixed(NUMBER_PRECISION);
  return fixed.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}
function parseMaybeWithUncertainty(value) {
  if (value == null) return null;
  let str = String(value).trim();
  if ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith("'") && str.endsWith("'"))) {
    str = str.slice(1, -1);
  }
  str = str.replace(/\([^()]*\)$/,'');
  const num = parseFloat(str);
  return Number.isFinite(num) ? num : null;
}

function elementFromLabel(label) {
  if (!label) return null;
  const match = String(label).match(/^([A-Z][a-z]?)/);
  return match ? match[1] : null;
}

export function readPOSCAR(content, fileName) {
  const lines = content.trim().split('\n').filter(l => l.trim());
  let i = 0;

  const comment = lines[i++]?.trim() || 'POSCAR Structure';
  const scale = parseFloat(lines[i++]);
  if (!Number.isFinite(scale)) throw new Error('POSCAR: missing scale factor');

  // --- lattice (3×3)
  const lattice = Array.from({ length: 3 }, () =>
    (lines[i++] || '').trim().split(/\s+/).slice(0, 3).map(v => parseFloat(v) * scale)
  );

  // --- element symbols + counts
  const elementLine = (lines[i++] || '').trim().split(/\s+/);
  const countLine = (lines[i++] || '').trim().split(/\s+/).map(x => parseInt(x, 10));

  if (
    !elementLine.length ||
    !countLine.length ||
    elementLine.length !== countLine.length
  ) {
    throw new Error('POSCAR: invalid element/count lines');
  }

  // --- flattened list of all atoms
  const elements = [];
  elementLine.forEach((el, idx) => {
    const repetitions = countLine[idx];
    if (!Number.isFinite(repetitions)) throw new Error('POSCAR: invalid atom count');
    for (let c = 0; c < repetitions; c++) elements.push(el);
  });

  // --- coordinate type (Direct/Cartesian)
  let coordType = (lines[i] || '').trim().toLowerCase();
  if (coordType.startsWith('s')) {
    i++;
    coordType = (lines[i] || '').trim().toLowerCase();
  }
  i++;

  const isCartesian = coordType.startsWith('c') || coordType.startsWith('k');
  const totalAtoms = countLine.reduce((a, b) => a + b, 0);

  // --- read raw positions
  const positionsRaw = [];
  for (let n = 0; n < totalAtoms; n++) {
    const tokens = (lines[i++] || '').trim().split(/\s+/);
    if (tokens.length < 3) throw new Error('POSCAR: atomic position line too short');
    positionsRaw.push(tokens.slice(0, 3).map(Number));
  }

  // --- convert cart → frac if needed
  const latticeInverse = isCartesian ? invert3x3(transpose3x3(lattice)) : null;
  const positions = (isCartesian
    ? positionsRaw.map(vec => cartToFractional(vec, lattice, latticeInverse))
    : positionsRaw
  ).map(pos => pos.map(normalizeFractional));

  const atoms = [];

  positions.forEach((pos, i) => {
    atoms.push(new Atom({
      position: pos,
      element: elements[i],
      uuid: generateID([elements[i]])
    }));
  });

  let periodic = runPeriodicWrapped(
  { hash: "None",wrapped: {}},
  positions,  
  elements,
  lattice
);

  console.log("Periodic",periodic)

  const structure = new Structure({
  elements: elements,
  uniqueElements: elementLine,
  lattice: lattice,
  atoms: atoms,
  periodic: periodic,
  volumetricFields:null
  });

  return structure
}


export  function parsePOSCAR(content, fileName) {
   console.log(content)
  const structure = readPOSCAR(content, fileName);
  initializeWithPOSCAR(structure, fileName);  
}

export function initializeWithPOSCAR(structure, fileName) {
  const container = new StructureContainer({
    fileName: fileName,
    structures: [structure],
  });

  initializeUIOnLoad(container);
}




function parseCifFallback(content) {
  const getTag = (tag) => {
    const re = new RegExp('^\\s*' + tag.replace(/([.*+?^${}()|[\]\\])/g,'\\$1') + '\\s+([^\r\n#;]+)', 'mi');
    const match = content.match(re);
    return match ? match[1].trim() : null;
  };

  const a  = parseMaybeWithUncertainty(getTag('_cell_length_a'));
  const b  = parseMaybeWithUncertainty(getTag('_cell_length_b'));
  const c  = parseMaybeWithUncertainty(getTag('_cell_length_c'));
  const al = parseMaybeWithUncertainty(getTag('_cell_angle_alpha'));
  const be = parseMaybeWithUncertainty(getTag('_cell_angle_beta'));
  const ga = parseMaybeWithUncertainty(getTag('_cell_angle_gamma'));
  if (!(a && b && c && al && be && ga)) throw new Error('CIF: missing unit cell parameters');
  const lattice = latticeFromCell(a, b, c, al, be, ga);

  const lines = content.split(/\r?\n/);
  let idx = 0;
  let headers = [];
  let rows = [];
  while (idx < lines.length) {
    const line = lines[idx].trim();
    if (/^loop_/i.test(line)) {
      idx++;
      headers = [];
      while (idx < lines.length && /^_/.test(lines[idx].trim())) {
        headers.push(lines[idx].trim());
        idx++;
      }
      const hasFrac = headers.includes('_atom_site_fract_x') && headers.includes('_atom_site_fract_y') && headers.includes('_atom_site_fract_z');
      const hasType = headers.includes('_atom_site_type_symbol');
      const hasLabel = headers.includes('_atom_site_label');
      if (hasFrac && (hasType || hasLabel)) {
        rows = [];
        while (idx < lines.length) {
          const entry = lines[idx];
          if (!entry.trim()) break;
          if (/^loop_/i.test(entry) || /^data_/i.test(entry) || /^_/.test(entry.trim())) break;
          rows.push(entry);
          idx++;
        }
        break;
      }
    } else {
      idx++;
    }
  }
  if (!rows.length) throw new Error('CIF: could not locate atom_site loop');

  const colIndex = Object.create(null);
  headers.forEach((h, index) => { colIndex[h] = index; });
  const useType = colIndex['_atom_site_type_symbol'] != null ? '_atom_site_type_symbol' : '_atom_site_label';
  const ix = colIndex['_atom_site_fract_x'];
  const iy = colIndex['_atom_site_fract_y'];
  const iz = colIndex['_atom_site_fract_z'];
  const it = colIndex[useType];

  const elements = [];
  const positions = [];
  for (const row of rows) {
    const tokens = [];
    let current = '';
    let quote = null;
    for (let k = 0; k < row.length; k++) {
      const ch = row[k];
      if (quote) {
        current += ch;
        if (ch === quote) { tokens.push(current.trim()); current = ''; quote = null; }
      } else if (ch === '"' || ch === "'") {
        if (current.trim()) { tokens.push(current.trim()); current = ''; }
        quote = ch; current = ch;
      } else if (/\s/.test(ch)) {
        if (current) { tokens.push(current.trim()); current = ''; }
      } else {
        current += ch;
      }
    }
    if (current.trim()) tokens.push(current.trim());

    const sx = parseMaybeWithUncertainty(tokens[ix]);
    const sy = parseMaybeWithUncertainty(tokens[iy]);
    const sz = parseMaybeWithUncertainty(tokens[iz]);
    let el = tokens[it];
    if (!el) continue;
    if ((el.startsWith('"') && el.endsWith('"')) || (el.startsWith("'") && el.endsWith("'"))) el = el.slice(1, -1);
    if (useType === '_atom_site_label') el = elementFromLabel(el) || el;
    if ([sx, sy, sz].every(v => typeof v === 'number')) {
      elements.push(el);
      positions.push([sx, sy, sz]);
    }
  }

  if (!elements.length) throw new Error('CIF: no atom_site rows parsed');

  const seen = new Set();
  const uniqueElements = [];
  for (const el of elements) {
    if (!seen.has(el)) {
      seen.add(el);
      uniqueElements.push(el);
    }
  }
  return { comment: 'CIF Structure', lattice, elements, positions, uniqueElements };
}

// export async function parseCIF(content) {
//   const result = parseCifFallback(content);
//   return result;
// }
//
function looksLikeUrl(text) {
  try {
    const url = new URL(text);
    return !!(url.protocol === 'http:' || url.protocol === 'https:');
  } catch (_) {
    return false;
  }
}

function normalizeMaterialsProjectId(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim().toLowerCase();
  if (/^mp-\d+$/.test(trimmed)) {
    return trimmed;
  }
  return null;
}

function normalizeAlexandriaId(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim().toLowerCase();
  if (/^agm[_-]?\d+$/.test(trimmed)) {
    return trimmed.replace('-', '_');
  }
  return null;
}

function extractElementForSite(speciesList, speciesName) {
  const match = speciesList.find((item) => item && item.name === speciesName);
  if (!match) {
    throw new Error(`OPTIMADE: missing species definition for site '${speciesName}'`);
  }
  const symbols = Array.isArray(match.chemical_symbols) ? match.chemical_symbols : [];
  const primary = symbols.find(sym => typeof sym === 'string' && sym !== '?');
  if (!primary) {
    throw new Error(`OPTIMADE: unsupported mixed or unknown species '${speciesName}'`);
  }
  return primary;
}

function buildPoscarFromOptimade(data) {
  const attributes = data && data.attributes ? data.attributes : {};
  const lattice = attributes.lattice_vectors;
  const positions = attributes.cartesian_site_positions;
  const speciesAtSites = attributes.species_at_sites;
  const species = Array.isArray(attributes.species) ? attributes.species : [];

  if (!Array.isArray(lattice) || lattice.length !== 3) {
    throw new Error('OPTIMADE: lattice vectors missing or malformed');
  }
  if (!Array.isArray(positions) || !Array.isArray(speciesAtSites) || positions.length !== speciesAtSites.length) {
    throw new Error('OPTIMADE: inconsistent site data');
  }

  const latticeClean = lattice.map((vec) => {
    if (!Array.isArray(vec) || vec.length !== 3) {
      throw new Error('OPTIMADE: lattice vector dimension mismatch');
    }
    return vec.map(Number);
  });

  const elements = speciesAtSites.map((siteName, index) => {
    try {
      return extractElementForSite(species, siteName);
    } catch (err) {
      throw new Error(`${err.message} (site index ${index})`);
    }
  });

  const latticeInverse = invert3x3(transpose3x3(latticeClean));

  const fractionalPositions = positions.map((cart) => {
    if (!Array.isArray(cart) || cart.length !== 3) {
      throw new Error('OPTIMADE: cartesian position dimension mismatch');
    }
    const coords = cart.map(Number);
    const frac = cartToFractional(coords, latticeClean, latticeInverse);
    return frac.map(normalizeFractional);
  });

  const elementOrder = [];
  const counts = [];
  elements.forEach((el) => {
    const idx = elementOrder.indexOf(el);
    if (idx === -1) {
      elementOrder.push(el);
      counts.push(1);
    } else {
      counts[idx] += 1;
    }
  });

  const comment = attributes.chemical_formula_descriptive ||
                  attributes.chemical_formula_reduced ||
                  attributes.chemical_formula_hill ||
                  data.id ||
                  'OPTIMADE Structure';

  const lines = [];
  lines.push(comment);
  lines.push('1.0');
  latticeClean.forEach((vec) => {
    lines.push(vec.map(formatNumber).join(' '));
  });
  lines.push(elementOrder.join(' '));
  lines.push(counts.join(' '));
  lines.push('Direct');
  fractionalPositions.forEach((pos) => {
    lines.push(pos.map(formatNumber).join(' '));
  });

  return {
    poscar: lines.join('\n'),
    metadata: {
      comment,
      id: data.id || attributes.immutable_id || null,
    }
  };
}
// Direct fetch of optimade fails due to cors. Not sure what or why.
const CORS_PROXY_PREFIX = 'https://corsproxy.io/?';

async function requestOptimadeJson(url) {
  const options = { headers: { Accept: 'application/json' }, mode: 'cors' };
  try {
    const response = await fetch(url, options);
    if (!response.ok) {
      throw new Error(`OPTIMADE request failed (${response.status} ${response.statusText})`);
    }
    return { response, viaProxy: false };
  } catch (err) {
    const shouldRetryViaProxy = err instanceof TypeError || err?.name === 'TypeError';
    if (!shouldRetryViaProxy) throw err;
    const proxyUrl = `${CORS_PROXY_PREFIX}${encodeURIComponent(url)}`;
    console.warn('OPTIMADE fetch failed, retrying via CORS proxy', proxyUrl, err);
    const proxyResponse = await fetch(proxyUrl, options).catch((proxyErr) => {
      throw new Error(`OPTIMADE proxy request failed (${proxyErr?.message || proxyErr})`);
    });
    if (!proxyResponse.ok) {
      throw new Error(`OPTIMADE request (via proxy) failed (${proxyResponse.status} ${proxyResponse.statusText})`);
    }
    return { response: proxyResponse, viaProxy: true };
  }
}

async function fetchOptimadeStructure(url) {
  const { response, viaProxy } = await requestOptimadeJson(url);

  let payload;
  try {
    payload = await response.json();
  } catch (err) {
    throw new Error('OPTIMADE: response is not valid JSON');
  }

  const data = Array.isArray(payload?.data) ? payload.data[0] : payload?.data;
  if (!data) {
    throw new Error('OPTIMADE: response missing data');
  }

  const { poscar, metadata } = buildPoscarFromOptimade(data);
  const fileNameBase = metadata.id || metadata.comment || 'optimade_structure';
  return {
    poscar,
    fileName: `${fileNameBase}.poscar`.replace(/\s+/g, '_'),
    metadata,
    viaProxy,
  };
}

async function fetchMaterialsProjectStructure(mpId) {
  const normalized = normalizeMaterialsProjectId(mpId);
  if (!normalized) {
    throw new Error(`Invalid Materials Project ID: ${mpId}`);
  }
  return fetchOptimadeStructure(`${MATERIALS_PROJECT_OPTIMADE_BASE}${normalized}`);
}

async function fetchAlexandriaStructure(agmId) {
  const normalized = normalizeAlexandriaId(agmId);
  if (!normalized) {
    throw new Error(`Invalid Alexandria ID: ${agmId}`);
  }
  return fetchOptimadeStructure(`${ALEXANDRIA_OPTIMADE_BASE}${normalized}`);
}

export function isLikelyCIFContent(content) {
  if (!content || typeof content !== 'string') return false;
  const trimmed = content.trim();
  if (!trimmed) return false;
  if (/^\s*data_/i.test(trimmed)) return true;
  if (/_cell_(length|angle)_[abc]/i.test(trimmed)) return true;
  if (/_symmetry_space_group_name_h-m/i.test(trimmed)) return true;
  return false;
}

export function isLikelyOUTCARContent(content) {
  if (!content || typeof content !== 'string') return false;
  const trimmed = content.trim();
  if (!trimmed) return false;
  if (/Startparameter/i.test(trimmed)) return true;
  if (/Iteration:/i.test(trimmed)) return true;
  return false;
}

export function initializeUIOnLoad(structureContainer) {
  console.log(structureContainer);
  const fileName = structureContainer.fileName;
  const structures = structureContainer.structures;

  const traj = structures.length;
  const step = traj;
  const row = createRow({ name: fileName, traj, step });
  tableBody.appendChild(row);
  fileBrowser.fileData.push({ idx: -1, name: fileName, traj, step });

  structureShip.container.push(structureContainer);
  selectLastAddedRow();
}


export function setupStructureInput({ onLoadStructure, setStatus }) {
  const fileInput = document.getElementById('fileInput');
  const fileLabel = document.getElementById('fileLabel');
  const inputModeButtons = Array.from(document.querySelectorAll('.input-mode-btn'));
  const fileInputContainer = document.getElementById('fileInputContainer');
  const textInputContainer = document.getElementById('textInputContainer');
  const structureText = document.getElementById('structureText');
  const loadTextButton = document.getElementById('loadTextButton');

  if (typeof onLoadStructure !== 'function') {
    throw new Error('setupStructureInput requires an onLoadStructure callback');
  }
  if (typeof setStatus !== 'function') {
    throw new Error('setupStructureInput requires a setStatus callback');
  }

  let currentInputMode = 'file';

  function setInputMode(mode) {
    if (!fileInputContainer || !textInputContainer) return;
    currentInputMode = mode === 'text' ? 'text' : 'file';
    const showText = currentInputMode === 'text';

    inputModeButtons.forEach(btn => {
      const isActive = btn.dataset.mode === currentInputMode;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
      const controls = btn.getAttribute('aria-controls');
      if (controls) {
        const panel = document.getElementById(controls);
        if (panel) panel.setAttribute('tabindex', isActive ? '0' : '-1');
      }
    });

    if (showText) {
      fileInputContainer.setAttribute('hidden', '');
      fileInputContainer.setAttribute('aria-hidden', 'true');
      textInputContainer.removeAttribute('hidden');
      textInputContainer.setAttribute('aria-hidden', 'false');
      if (structureText && typeof structureText.focus === 'function') {
        setTimeout(() => structureText.focus({ preventScroll: true }), 0);
      }
    } else {
      textInputContainer.setAttribute('hidden', '');
      textInputContainer.setAttribute('aria-hidden', 'true');
      fileInputContainer.removeAttribute('hidden');
      fileInputContainer.setAttribute('aria-hidden', 'false');
    }
  }

  if (inputModeButtons.length > 0) {
    inputModeButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.mode;
        if (mode) setInputMode(mode);
      });
    });
  }

  setInputMode('file');

  async function loadStructureFromText() {
    if (!structureText) return;
    const raw = structureText.value.trim();
    if (!raw) {
      setStatus('Paste POSCAR, CIF, OPTIMADE URL, Materials Project mp-id, or Alexandria agm-id before loading.');
      structureText.focus({ preventScroll: true });
      return;
    }

    // ... (rest of your existing loadStructureFromText function)
  }

  if (loadTextButton) {
    loadTextButton.addEventListener('click', (event) => {
      event.preventDefault();
      loadStructureFromText();
    });
  }

  if (structureText) {
    structureText.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        loadStructureFromText();
      }
    });
  }

  if (fileInput) {
    fileInput.onchange = async (e) => {
      const files = Array.from(e.target.files);
      if (files.length === 0) return;

      setStatus(`Loading ${files.length} structure(s)...`);
      let loadedCount = 0;

      try {
        for (const file of files) {
          setStatus(`Loading ${file.name} (${++loadedCount}/${files.length})...`);
          const reader = new FileReader();
          await new Promise((resolve, reject) => {
            reader.onload = (event) => {
              try {
                onLoadStructure(event.target.result, file.name);
                resolve();
              } catch (err) {
                reject(err);
              }
            };
            reader.onerror = (error) => reject(error);
            reader.readAsText(file);
          });
        }
        setStatus(`${files.length} structure(s) loaded!`);
      } catch (error) {
        console.error('Error loading structures:', error);
        setStatus('Error loading structures.');
      } finally {
        fileInput.value = '';
      }
    };
  }

  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    document.body.addEventListener(eventName, preventDefaults, false);
    if (fileLabel) fileLabel.addEventListener(eventName, preventDefaults, false);
  });

  if (fileLabel) {
    ['dragenter', 'dragover'].forEach(eventName => {
      fileLabel.addEventListener(eventName, highlight, false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
      fileLabel.addEventListener(eventName, unhighlight, false);
    });

    fileLabel.addEventListener('drop', async (e) => {
      preventDefaults(e);
      unhighlight();

      const dt = e.dataTransfer;
      const files = Array.from(dt.files);
      if (files.length === 0) return;

      if (currentInputMode !== 'file') {
        setInputMode('file');
      }

      setStatus(`Loading ${files.length} structure(s)...`);
      let loadedCount = 0;

      try {
        for (const file of files) {
          setStatus(`Loading ${file.name} (${++loadedCount}/${files.length})...`);
          const reader = new FileReader();
          await new Promise((resolve, reject) => {
            reader.onload = (event) => {
              try {
                onLoadStructure(event.target.result, file.name);
                resolve();
              } catch (err) {
                reject(err);
              }
            };
            reader.onerror = (error) => reject(error);
            reader.readAsText(file);
          });
        }
        setStatus(`${files.length} structure(s) loaded!`);
      } catch (error) {
        console.error('Error loading structures:', error);
        setStatus('Error loading structures.');
      }
    });
  }

  function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
  }

  function highlight() {
    if (!fileLabel || currentInputMode !== 'file') return;
    fileLabel.classList.add('dragover');
  }

  function unhighlight() {
    if (!fileLabel) return;
    fileLabel.classList.remove('dragover');
  }

  return {
    getCurrentInputMode: () => currentInputMode,
    setInputMode,
  };
}
