// WyckoffLatticeConstraints.js
//
// Which lattice parameters a chosen space group leaves free, and the wiring
// that enforces it on a LatticeInputPanel instance. Picking a space group is
// a statement about the metric of the cell (cubic cannot have a != b), so the
// Wyckoff tab locks the parameters the group determines instead of letting a
// user type a cell the symmetry forbids - the generated Wyckoff coordinates
// would otherwise be expressed in a cell they do not actually belong to.
//
// The rules below are keyed to the *setting* WyckoffProjector.js selects,
// which is the first row per IT number in symmetry_basics.json:
//   - monoclinic resolves to the a-unique setting ("P 2 1 1", setting (b,c,a)),
//     NOT the more familiar b-unique "P 1 2 1". So alpha is the free angle and
//     beta = gamma = 90. Reading b-unique into this would silently produce
//     cells inconsistent with the coordinates generated alongside them.
//   - every trigonal R group resolves to its hexagonal-axes (:H) setting, so
//     trigonal and hexagonal share one rule and rhombohedral axes never arise.

// A constraint per parameter, keyed a/b/c/alpha/beta/gamma. Absent means free.
//   { fixed: number }  - constant, user cannot edit
//   { mirror: 'a' }    - always equals another parameter, user cannot edit
const RIGHT_ANGLES = { alpha: { fixed: 90 }, beta: { fixed: 90 }, gamma: { fixed: 90 } };

const CONSTRAINTS_BY_SYSTEM = {
  triclinic: {},
  // a-unique setting: the 2-fold/mirror runs along a, so alpha is free.
  monoclinic: { beta: { fixed: 90 }, gamma: { fixed: 90 } },
  orthorhombic: { ...RIGHT_ANGLES },
  tetragonal: { b: { mirror: 'a' }, ...RIGHT_ANGLES },
  trigonal: { b: { mirror: 'a' }, alpha: { fixed: 90 }, beta: { fixed: 90 }, gamma: { fixed: 120 } },
  hexagonal: { b: { mirror: 'a' }, alpha: { fixed: 90 }, beta: { fixed: 90 }, gamma: { fixed: 120 } },
  cubic: { b: { mirror: 'a' }, c: { mirror: 'a' }, ...RIGHT_ANGLES },
};

const PARAM_IDS = {
  a: 'latA', b: 'latB', c: 'latC',
  alpha: 'latAlpha', beta: 'latBeta', gamma: 'latGamma',
};

export function latticeConstraintsFor(crystalSystem) {
  return CONSTRAINTS_BY_SYSTEM[crystalSystem] ?? {};
}

// One-line summary of what the group locks, for the panel's hint text.
export function describeLatticeConstraints(crystalSystem) {
  const constraints = latticeConstraintsFor(crystalSystem);
  const parts = [];
  const mirrored = Object.entries(constraints).filter(([, rule]) => rule.mirror);
  if (mirrored.length) {
    parts.push([...new Set([mirrored[0][1].mirror, ...mirrored.map(([key]) => key)])].join(' = '));
  }
  const angles = ['alpha', 'beta', 'gamma'].filter((key) => constraints[key]?.fixed !== undefined);
  const symbols = { alpha: 'α', beta: 'β', gamma: 'γ' };
  const byValue = new Map();
  angles.forEach((key) => {
    const value = constraints[key].fixed;
    if (!byValue.has(value)) byValue.set(value, []);
    byValue.get(value).push(symbols[key]);
  });
  byValue.forEach((keys, value) => parts.push(`${keys.join(' = ')} = ${value}°`));
  return parts.length ? parts.join(', ') : 'all parameters free';
}

// Dimming/cursor for a locked input is expressed in CSS off the `disabled`
// attribute alone (addStructure.css's .LatticeInput:disabled) - this only
// needs to flip the attribute and the dynamic title text.
function markLocked(input, locked) {
  input.disabled = locked;
  input.title = locked ? 'Determined by the chosen space group' : '';
}

const LENGTH_KEYS = new Set(['a', 'b', 'c']);

// Bind constraint enforcement to a LatticeInputPanel already rendered into
// `host`, returning a controller whose setCrystalSystem() can be called again
// every time the space group changes. Listeners are attached once here rather
// than per space group, so repeatedly switching groups cannot pile up
// duplicate handlers.
//
// Locked parameters are disabled and driven from the free ones. The matrix
// inputs are disabled whenever anything is locked, since editing the matrix
// directly could otherwise reintroduce a metric the space group forbids (the
// matrix still updates to show the result).
//
// Locked values are written by setting .value and dispatching 'input', which
// is what the panel listens on - so its internal lattice matrix stays in sync
// exactly as if a user had typed them.
export function createLatticeConstraintController(host) {
  const inputs = {};
  for (const [key, id] of Object.entries(PARAM_IDS)) {
    inputs[key] = host.querySelector(`#${id}`);
  }
  // Panel not rendered as expected - degrade to doing nothing rather than throwing.
  if (Object.values(inputs).some((input) => !input)) {
    return { setCrystalSystem: () => {} };
  }

  let constraints = {};

  // Re-derive every locked parameter from the free ones, then tell the panel
  // once so it recomputes its matrix a single time.
  function enforce() {
    let changed = false;
    for (const [key, rule] of Object.entries(constraints)) {
      const target = rule.fixed !== undefined
        ? rule.fixed
        : parseFloat(inputs[rule.mirror].value);
      if (!Number.isFinite(target)) continue;
      const formatted = LENGTH_KEYS.has(key) ? target.toFixed(4) : target.toFixed(2);
      if (inputs[key].value !== formatted) {
        inputs[key].value = formatted;
        changed = true;
      }
    }
    if (changed) {
      // Any one param input re-reads all six, so a single event is enough.
      // This re-enters enforce(), which then finds nothing left to change.
      inputs.a.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  Object.values(inputs).forEach((input) => input.addEventListener('input', enforce));

  // Apply a constraint map directly. The add panel derives it from the
  // space-group table via setCrystalSystem(); the Modify panel measures it from
  // the lock's own operations (wyckoffLatticeConstraints) because the table is
  // keyed to the generator's setting and would freeze the wrong angle there.
  function setConstraints(next) {
    constraints = next ?? {};
    const anyLocked = Object.keys(constraints).length > 0;
    host.querySelectorAll('.lat-mat').forEach((input) => markLocked(/** @type {HTMLInputElement} */ (input), anyLocked));
    for (const [key, input] of Object.entries(inputs)) {
      markLocked(input, Boolean(constraints[key]));
    }
    enforce();
  }

  return {
    setConstraints,
    setCrystalSystem(crystalSystem) {
      setConstraints(latticeConstraintsFor(crystalSystem));
    },
  };
}
