// Where a structure's energy, forces and stress came from: the code that
// computed them ("VASP", "Quantum ESPRESSO") or the potential the Atomistic
// window ran ("PET-MAD xs", "NEP89"). The Files window's Parameters section
// shows it as "Source: …" and .crysviz sessions keep it.
//
// Two levels. A file's reader stamps its container (StructureContainer
// .dataSource) once, from the format (io/load_structure.js); a computation
// in the app writes its own result onto one structure (Structure.dataSource),
// which wins over the file's. A trajectory frame's own source rides in its
// frame record (model/TrajectoryFrameStore.js), so the next frame does not
// inherit it.

/** The code behind each format that carries computed energies, forces or stress (io/formats.js ids). */
const FORMAT_SOURCES = {
  outcar: 'VASP',
  'pwscf-out': 'Quantum ESPRESSO',
  'castep-geom': 'CASTEP',
  'aims-out': 'FHI-aims',
  res: 'AIRSS (.res)',
  // An ASE trajectory's reader names the calculator itself (aseCalculatorSource).
};

/** ASE calculator names (Calculator.name) as people write them. */
const ASE_CALCULATORS = {
  vasp: 'VASP',
  espresso: 'Quantum ESPRESSO',
  castep: 'CASTEP',
  aims: 'FHI-aims',
  gpaw: 'GPAW',
  cp2k: 'CP2K',
  abinit: 'ABINIT',
  siesta: 'SIESTA',
  lammpsrun: 'LAMMPS',
  lammpslib: 'LAMMPS',
  emt: 'EMT',
  lj: 'Lennard-Jones',
  mace: 'MACE',
  nequip: 'NequIP',
  orb: 'Orb',
  chgnet: 'CHGNet',
  m3gnet: 'M3GNet',
  sevennet: 'SevenNet',
  'pet-mad': 'PET-MAD',
  xtb: 'xtb',
  dftb: 'DFTB+',
};

const MAX_LENGTH = 80;

/**
 * A usable source label, or null: a non-empty string, trimmed, at most 80
 * characters (it comes from files and sessions).
 * @param {unknown} value
 * @returns {string | null}
 */
export function cleanDataSource(value) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, MAX_LENGTH) : null;
}

/**
 * The source a file of this format carries, or null for a format that holds
 * geometry only (a CIF, a POSCAR).
 * @param {string} formatId an io/formats.js id
 */
export function formatDataSource(formatId) {
  return FORMAT_SOURCES[formatId] ?? null;
}

/**
 * "VASP (via ASE)" for an ASE trajectory written by the vasp calculator,
 * "ASE" when it names none (or "unknown").
 * @param {unknown} name the calculator's name in the file
 */
export function aseCalculatorSource(name) {
  const key = cleanDataSource(name)?.toLowerCase();
  // A SinglePointCalculator (results copied in from elsewhere) is "unknown".
  if (!key || key === 'unknown' || key === 'singlepoint') return 'ASE';
  return `${ASE_CALCULATORS[key] ?? cleanDataSource(name)} (via ASE)`;
}

/**
 * Does a freshly read file carry anything computed — an energy, a stress, a
 * non-zero force — that a source would describe? (A SHELX .res has none; an
 * AIRSS one has its enthalpies.) A store read from disk on demand is assumed
 * to.
 * @param {any} container
 */
export function hasComputedData(container) {
  const store = container?.store;
  if (store) {
    return Array.isArray(store.frames)
      ? store.frames.some((f) => Number.isFinite(f?.energy) || !!f?.stress || !!f?.forces)
      : true;
  }
  return (container?.structures ?? []).some((s) => !!s && (Number.isFinite(s.energy) || !!s.stress?.tensor
    || (s.forces ?? []).some((f) => (f?.vector ?? []).some((v) => v !== 0))));
}

/**
 * The source of a structure's data: its own, else its container's.
 * @param {any} structure
 * @param {any} [container]
 * @returns {string | null}
 */
export function dataSourceOf(structure, container = null) {
  return cleanDataSource(structure?.dataSource) ?? cleanDataSource(container?.dataSource);
}
