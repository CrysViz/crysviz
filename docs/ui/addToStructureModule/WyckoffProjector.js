// WyckoffProjector.js
//
// Pure (DOM-free) space-group crystallography for the Add-Structure panel's
// "Symmetry (Wyckoff)" tab: given a space-group number, a Wyckoff letter and a
// representative position, expand the full orbit of symmetry-equivalent sites.
// The tab (SymmetryWyckoffTab.js) turns the result into atoms; nothing here
// knows about atoms, structures or the DOM.
//
// Data comes from data/symmetry_basics.json, fetched lazily on first use
// rather than imported. Two reasons: the file is ~8.9 MB, so nothing should
// pay for it until the Wyckoff tab is actually opened; and a static `import
// ... with { type: 'json' }` would be the only JSON import in the codebase
// (big generated tables here are .js modules - see BackendPanel/hallSymbols.js)
// and needs import-attribute support in every target browser. A fetch has
// neither problem.

// Resolved against this module's own URL, so it does not depend on what page
// path the app happens to be served from.
const DATA_URL = new URL('../../data/symmetry_basics.json', import.meta.url);

const DEFAULT_TOLERANCE = 1e-6;

// The parsed dataset, once loaded. Kept as the in-flight promise so concurrent
// callers (several site rows populating their letter dropdowns at once) share
// one fetch instead of racing several 8.9 MB downloads.
let dataPromise = null;
let symmetryBasics = null;

// Must be awaited once before any of the synchronous accessors below are used.
// Safe to call repeatedly - the fetch happens at most once.
export function loadSymmetryData() {
  dataPromise ??= fetch(DATA_URL)
    .then((response) => {
      if (!response.ok) {
        throw new Error(`Could not load symmetry data (HTTP ${response.status})`);
      }
      return response.json();
    })
    .then((data) => {
      symmetryBasics = data;
      return data;
    })
    .catch((error) => {
      dataPromise = null; // let a later attempt retry rather than caching the failure
      throw error;
    });
  return dataPromise;
}

function wrap01(x) {
  return ((x % 1) + 1) % 1;
}

function wrapFrac(pos) {
  return [wrap01(pos[0]), wrap01(pos[1]), wrap01(pos[2])];
}

function fracDelta(a, b) {
  return a.map((value, axis) => {
    let diff = value - b[axis];
    diff -= Math.round(diff);
    return diff;
  });
}

function fracDistance(a, b) {
  const d = fracDelta(a, b);
  return Math.hypot(d[0], d[1], d[2]);
}

// Orbit expansion maps several symmetry operations onto the same site whenever
// the representative sits on a special position (that is exactly what makes it
// special), so the raw image list is longer than the site's multiplicity.
// Collapsing it here is what makes the returned count match `multiplicity`.
function deduplicatePositions(positions, tolerance = DEFAULT_TOLERANCE) {
  const unique = [];

  positions.forEach((position) => {
    const wrapped = wrapFrac(position);
    const duplicate = unique.some((other) => fracDistance(wrapped, other) <= tolerance);
    if (!duplicate) unique.push(wrapped);
  });

  return unique;
}

// Affine entries are strings, and rational ones are written as fractions
// ("1/2", "-1/4") rather than decimals, so they need parsing rather than a
// plain Number().
function parseFraction(value) {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return Number(value) || 0;

  const trimmed = value.trim();
  if (trimmed.includes('/')) {
    const [num, den] = trimmed.split('/').map(Number);
    return den ? num / den : 0;
  }

  return Number(trimmed) || 0;
}

// One 4x4 affine operation applied to a fractional position: rows 0-2 hold the
// x/y/z coefficients plus a translation in column 3.
function applyAffine(position, affine) {
  const x = position[0];
  const y = position[1];
  const z = position[2];

  return wrapFrac([
    parseFraction(affine[0][0]) * x +
      parseFraction(affine[0][1]) * y +
      parseFraction(affine[0][2]) * z +
      parseFraction(affine[0][3]),

    parseFraction(affine[1][0]) * x +
      parseFraction(affine[1][1]) * y +
      parseFraction(affine[1][2]) * z +
      parseFraction(affine[1][3]),

    parseFraction(affine[2][0]) * x +
      parseFraction(affine[2][1]) * y +
      parseFraction(affine[2][2]) * z +
      parseFraction(affine[2][3]),
  ]);
}

function requireData() {
  if (!symmetryBasics) {
    throw new Error('Symmetry data not loaded yet - await loadSymmetryData() first.');
  }
  return symmetryBasics;
}

// The dataset carries 527 rows: one per space-group *setting*, several sharing
// one IT number (different axis choices/origins). Matching on it_number takes
// the first listed setting for that number, which is the reference setting.
function getSpaceGroupEntry(spaceGroupNumber) {
  const number = Number(spaceGroupNumber);
  const entry = requireData().spacegroups?.find(
    (spaceGroup) => Number(spaceGroup.it_number) === number
  );

  if (!entry) {
    throw new Error(`Space group ${spaceGroupNumber} not found`);
  }

  return entry;
}

function getWyckoffEntry(spaceGroupNumber, wyckoffLetter) {
  const spaceGroup = getSpaceGroupEntry(spaceGroupNumber);
  const letter = String(wyckoffLetter).trim().toLowerCase();
  const entry = spaceGroup.wyckoff?.[letter];

  if (!entry) {
    throw new Error(`Wyckoff letter ${wyckoffLetter} not found in space group ${spaceGroupNumber}`);
  }

  return entry;
}

export function getWyckoffOrbitData(spaceGroupNumber, wyckoffLetter) {
  return getWyckoffEntry(spaceGroupNumber, wyckoffLetter);
}

// Every Wyckoff letter defined for a space group, sorted. The tab uses this to
// populate its letter dropdown, so only letters that exist in the chosen group
// can be picked.
export function getWyckoffLetters(spaceGroupNumber) {
  const spaceGroup = getSpaceGroupEntry(spaceGroupNumber);
  return Object.keys(spaceGroup.wyckoff ?? {}).sort();
}

// Human-readable identity of a space group, for panel headings.
export function getSpaceGroupInfo(spaceGroupNumber) {
  const entry = getSpaceGroupEntry(spaceGroupNumber);
  return {
    number: Number(entry.it_number),
    hmShort: entry.hm_short ?? '',
    crystalSystem: entry.crystal_system ?? '',
    centringType: entry.centring_type ?? '',
    settingCode: entry.it_coordinate_system_code ?? '',
  };
}

// Which of x/y/z are genuinely free parameters on this site, and the symbolic
// representative it comes from ("x,2x,z", "0,y,1/4", "1/2,1/2,1/2"). A `false`
// entry means that coordinate is not an independent input: it is either fixed
// outright or locked to another coordinate, and constrainRepresentative()
// below computes its actual value.
export function getSiteFreedom(spaceGroupNumber, wyckoffLetter) {
  const entry = getWyckoffEntry(spaceGroupNumber, wyckoffLetter);
  return {
    hasFreedom: entry.hasfreedom ?? [true, true, true],
    firstOrbit: entry.first_orbit ?? '',
    multiplicity: entry.multiplicity ?? 0,
    siteSymmetry: entry.sitesym ?? '',
  };
}

// Snap a typed position onto the site's allowed subspace. The orbit's first
// affine operation *is* the site's parametrisation (SG 194 letter k is
// "x,2x,z", so its first operation maps (x,y,z) -> (x,2x,z)), which means
// applying it both fixes frozen coordinates and derives dependent ones. The
// tab calls this to show users what their input actually becomes; orbit
// expansion below applies the same operation anyway, so a caller that skips
// this gets the same structure - it just would not see it coming.
export function constrainRepresentative(spaceGroupNumber, wyckoffLetter, position) {
  const wyckoff = getWyckoffEntry(spaceGroupNumber, wyckoffLetter);
  const first = wyckoff.orbit_affine?.[0];
  if (!first) return wrapFrac(position);
  return applyAffine(position, first);
}

// Expand one Wyckoff site into its full orbit of equivalent positions.
export function projectWyckoffOrbit(spaceGroupNumber, wyckoffLetter, representativePosition, tolerance = DEFAULT_TOLERANCE) {
  const wyckoff = getWyckoffEntry(spaceGroupNumber, wyckoffLetter);
  const affineOperations = wyckoff.orbit_affine ?? [];

  const projected = affineOperations.map((affine) =>
    applyAffine(representativePosition, affine)
  );

  return {
    spaceGroupNumber: Number(spaceGroupNumber),
    wyckoffLetter: String(wyckoffLetter).trim().toLowerCase(),
    representativePosition: wrapFrac(representativePosition),
    multiplicity: wyckoff.multiplicity ?? projected.length,
    siteSymmetry: wyckoff.sitesym ?? '',
    hasFreedom: wyckoff.hasfreedom ?? [true, true, true],
    positions: deduplicatePositions(projected, tolerance),
  };
}

// Expand a whole set of sites into a flat atom list. Each site is
// { element, wyckoff, representativePosition: [x, y, z] }; the returned atoms
// carry fractional positions and the letter they came from.
export function projectWyckoffStructure(spaceGroupNumber, sites, tolerance = DEFAULT_TOLERANCE) {
  const atoms = [];

  sites.forEach((site) => {
    const orbit = projectWyckoffOrbit(
      spaceGroupNumber,
      site.wyckoff,
      site.representativePosition,
      tolerance
    );

    orbit.positions.forEach((position) => {
      atoms.push({
        element: site.element,
        position,
        wyckoff: orbit.wyckoffLetter,
      });
    });
  });

  return atoms;
}
