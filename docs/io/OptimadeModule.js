import {
  cartToFractional,
  invert3x3,
  normalizeFractional,
  transpose3x3,
} from '../math/index.js';

const ALEXANDRIA_BASES = [
  'https://alexandria.icams.rub.de/pbe/v1/structures/',
  'https://alexandria.icams.rub.de/pbesol/v1/structures/',
];

function finiteVector(value, label) {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error(`OPTIMADE: ${label} must contain three coordinates`);
  }
  const vector = value.map(Number);
  if (!vector.every(Number.isFinite)) {
    throw new Error(`OPTIMADE: ${label} contains a non-numeric coordinate`);
  }
  return vector;
}

function siteElement(species, name) {
  const definition = species.find((entry) => entry?.name === name);
  if (!definition) {
    throw new Error(`OPTIMADE: missing species definition for '${name}'`);
  }
  const symbols = Array.isArray(definition.chemical_symbols)
    ? definition.chemical_symbols
    : [];
  const concentrations = Array.isArray(definition.concentration)
    ? definition.concentration
    : [];
  const candidates = symbols
    .map((symbol, index) => ({ symbol, concentration: Number(concentrations[index] ?? 1) }))
    .filter(({ symbol, concentration }) => /^[A-Z][a-z]?$/.test(symbol) && concentration > 0);
  if (candidates.length === 0) {
    throw new Error(`OPTIMADE: species '${name}' has no supported chemical symbol`);
  }
  candidates.sort((a, b) => b.concentration - a.concentration);
  return candidates[0].symbol;
}

/** Convert one OPTIMADE structures resource object into POSCAR text. */
export function optimadeStructureToPOSCAR(data) {
  if (!data || data.type !== 'structures' || !data.attributes) {
    throw new Error('OPTIMADE: response does not contain a structures resource');
  }
  const attributes = data.attributes;
  if (!Array.isArray(attributes.lattice_vectors) || attributes.lattice_vectors.length !== 3) {
    throw new Error('OPTIMADE: lattice_vectors is missing or malformed');
  }
  const lattice = attributes.lattice_vectors.map((vector, index) =>
    finiteVector(vector, `lattice vector ${index}`));
  const positions = attributes.cartesian_site_positions;
  const speciesAtSites = attributes.species_at_sites;
  const species = attributes.species;
  if (!Array.isArray(positions) || !Array.isArray(speciesAtSites)
      || positions.length === 0 || positions.length !== speciesAtSites.length
      || !Array.isArray(species)) {
    throw new Error('OPTIMADE: site positions or species data is missing or inconsistent');
  }

  const inverse = invert3x3(transpose3x3(lattice));
  const fractional = positions.map((position, index) =>
    cartToFractional(finiteVector(position, `site position ${index}`), lattice, inverse)
      .map(normalizeFractional));
  const elements = speciesAtSites.map((name) => siteElement(species, name));
  const order = [...new Set(elements)];
  const comment = attributes.chemical_formula_descriptive
    || attributes.chemical_formula_reduced
    || data.id
    || 'OPTIMADE structure';

  // POSCAR coordinates are grouped by the element-count lines.
  const coordinateLines = order.flatMap((element) => elements
    .map((siteElementName, index) => ({ siteElementName, position: fractional[index] }))
    .filter(({ siteElementName }) => siteElementName === element)
    .map(({ position }) => position.map((number) => number.toPrecision(12)).join(' ')));

  return [
    comment,
    '1.0',
    ...lattice.map((vector) => vector.map((number) => number.toPrecision(12)).join(' ')),
    order.join(' '),
    order.map((element) => elements.filter((value) => value === element).length).join(' '),
    'Direct',
    ...coordinateLines,
  ].join('\n');
}

export function isOptimadeStructureUrl(text) {
  try {
    const url = new URL(String(text).trim());
    return (url.protocol === 'https:' || url.protocol === 'http:')
      && /\/v\d+(?:\.\d+){0,2}\/structures(?:\/|$)/i.test(url.pathname);
  } catch (_) {
    return false;
  }
}

export function normalizeAlexandriaId(text) {
  const match = /^agm[_-]?(\d{1,9})$/i.exec(String(text || '').trim());
  return match ? `agm${match[1].padStart(9, '0')}` : null;
}

async function requestOptimade(url) {
  let response;
  try {
    response = await fetch(url, {
      headers: { Accept: 'application/vnd.api+json, application/json' },
      mode: 'cors',
    });
  } catch (error) {
    throw Object.assign(
      new Error(`OPTIMADE request failed: ${error.message}`),
      { code: 'OPTIMADE_CORS_OR_NETWORK' },
    );
  }
  if (!response.ok) {
    throw new Error(`OPTIMADE request failed (${response.status} ${response.statusText})`);
  }
  let payload;
  try {
    payload = await response.json();
  } catch (_) {
    throw new Error('OPTIMADE: response is not valid JSON');
  }
  if (Array.isArray(payload?.errors) && payload.errors.length) {
    throw new Error(`OPTIMADE: ${payload.errors[0]?.detail || payload.errors[0]?.title || 'provider error'}`);
  }
  const data = Array.isArray(payload?.data) ? payload.data[0] : payload?.data;
  if (!data) throw new Error('OPTIMADE: no matching structure was found');
  return data;
}

export async function fetchOptimadeStructure(url) {
  if (!isOptimadeStructureUrl(url)) {
    throw new Error('Invalid OPTIMADE structures URL');
  }
  const data = await requestOptimade(url);
  return {
    content: optimadeStructureToPOSCAR(data),
    fileName: `${String(data.id || 'optimade-structure').replace(/[^a-z0-9_.-]+/gi, '_')}.poscar`,
    id: data.id || null,
    sourceUrl: url,
  };
}

export async function fetchAlexandriaStructure(text) {
  const id = normalizeAlexandriaId(text);
  if (!id) throw new Error(`Invalid Alexandria ID: ${text}`);
  for (const base of ALEXANDRIA_BASES) {
    try {
      return await fetchOptimadeStructure(`${base}${id}`);
    } catch (error) {
      if (!/no matching structure was found/.test(error.message)) throw error;
    }
  }
  throw new Error(`Alexandria structure '${id}' was not found in PBE or PBEsol`);
}
