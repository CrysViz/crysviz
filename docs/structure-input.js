const NUMBER_PRECISION = 6;

function formatNumber(value) {
  if (!Number.isFinite(value)) return '0';
  const fixed = value.toFixed(NUMBER_PRECISION);
  return fixed.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

function invert3x3(m) {
  const [a, b, c] = m;
  const A = a[0], B = a[1], C = a[2];
  const D = b[0], E = b[1], F = b[2];
  const G = c[0], H = c[1], I = c[2];
  const det = A * (E * I - F * H) - B * (D * I - F * G) + C * (D * H - E * G);
  if (Math.abs(det) < 1e-12) {
    throw new Error('OPTIMADE: lattice matrix is singular');
  }
  const invDet = 1.0 / det;
  return [
    [(E * I - F * H) * invDet, (C * H - B * I) * invDet, (B * F - C * E) * invDet],
    [(F * G - D * I) * invDet, (A * I - C * G) * invDet, (C * D - A * F) * invDet],
    [(D * H - E * G) * invDet, (B * G - A * H) * invDet, (A * E - B * D) * invDet],
  ];
}

function multiplyMatVec(mat, vec) {
  return [
    mat[0][0] * vec[0] + mat[0][1] * vec[1] + mat[0][2] * vec[2],
    mat[1][0] * vec[0] + mat[1][1] * vec[1] + mat[1][2] * vec[2],
    mat[2][0] * vec[0] + mat[2][1] * vec[1] + mat[2][2] * vec[2],
  ];
}

function normalizeFractional(value) {
  if (!Number.isFinite(value)) return 0;
  let normalized = value - Math.floor(value);
  if (normalized < 0) normalized += 1;
  if (Math.abs(normalized) < 1e-8) normalized = 0;
  if (Math.abs(normalized - 1) < 1e-8) normalized = 0;
  return normalized;
}

function looksLikeUrl(text) {
  try {
    const url = new URL(text);
    return !!(url.protocol === 'http:' || url.protocol === 'https:');
  } catch (_) {
    return false;
  }
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

  const inverseLattice = invert3x3(latticeClean);

  const elements = speciesAtSites.map((siteName, index) => {
    try {
      return extractElementForSite(species, siteName);
    } catch (err) {
      throw new Error(`${err.message} (site index ${index})`);
    }
  });

  const fractionalPositions = positions.map((cart) => {
    if (!Array.isArray(cart) || cart.length !== 3) {
      throw new Error('OPTIMADE: cartesian position dimension mismatch');
    }
    const coords = cart.map(Number);
    const frac = multiplyMatVec(inverseLattice, coords);
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

export function isLikelyCIFContent(content) {
  if (!content || typeof content !== 'string') return false;
  const trimmed = content.trim();
  if (!trimmed) return false;
  if (/^\s*data_/i.test(trimmed)) return true;
  if (/_cell_(length|angle)_[abc]/i.test(trimmed)) return true;
  if (/_symmetry_space_group_name_h-m/i.test(trimmed)) return true;
  return false;
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
      setStatus('Paste POSCAR, CIF, or OPTIMADE URL before loading.');
      structureText.focus({ preventScroll: true });
      return;
    }

    if (looksLikeUrl(raw)) {
      try {
        setStatus('Fetching OPTIMADE structure...');
        const { poscar, fileName, viaProxy } = await fetchOptimadeStructure(raw);
        if (viaProxy) {
          setStatus('Fetched via CORS proxy. Parsing structure...');
        }
        onLoadStructure(poscar, fileName);
      } catch (err) {
        console.error(err);
        setStatus(err.message);
      }
      return;
    }

    setStatus('Loading pasted structure...');
    const pseudoName = isLikelyCIFContent(raw) ? 'pasted_structure.cif' : 'pasted_structure.poscar';
    onLoadStructure(raw, pseudoName);
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
    fileInput.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const fileName = file.name.toLowerCase();
      const isStructureFile = fileName.includes('poscar') ||
                              fileName.includes('contcar') ||
                              fileName.endsWith('.vasp') ||
                              fileName.endsWith('.poscar') ||
                              fileName === 'poscar' ||
                              fileName === 'contcar' ||
                              fileName.endsWith('.cif');

      if (!isStructureFile) {
        console.warn('Selected file may not be a structure file:', file.name);
      }

      const reader = new FileReader();
      reader.onload = (event) => {
        onLoadStructure(event.target.result, file.name);
        fileInput.value = '';
      };
      reader.readAsText(file);
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

    fileLabel.addEventListener('drop', handleDrop, false);
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

  function handleDrop(e) {
    const dt = e.dataTransfer;
    const files = dt.files;
    if (files && files.length > 0) {
      const file = files[0];
      if (currentInputMode !== 'file') {
        setInputMode('file');
      }
      const reader = new FileReader();
      reader.onload = (event) => onLoadStructure(event.target.result, file.name);
      reader.readAsText(file);
    } else if (structureText) {
      const droppedText = dt.getData('text/plain') || dt.getData('text');
      if (droppedText && droppedText.trim()) {
        setInputMode('text');
        structureText.value = droppedText;
        setStatus('Text pasted from drop. Click "Load Structure" to parse.');
      }
    }
  }

  return {
    getCurrentInputMode: () => currentInputMode,
    setInputMode,
  };
}
