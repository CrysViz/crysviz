// Loading a VASP INCAR: put its MAGMOM onto the selected structure as spins.
//
// An INCAR has no atoms, so — like a WAVECAR (render/Render3DFieldModule.js
// parseWavecarFile) — it cannot become a file-browser row of its own and is
// applied to the structure that is already selected. Unlike a WAVECAR it
// REPLACES something the structure may already have: a structure carries one
// spin field (several per structure is an open GitHub issue), so the user is
// always told what was found and asked before anything is overwritten.
//
// The parsing and the comparison with the structure are pure and live in
// io/ReadIncarModule.js; this module owns the dialogs and the write.
//
//   nothing usable in the file   -> throws IncarSpinError; loadStructure's
//                                   single catch shows it in the load-error modal
//   MAGMOM written with variables-> ask: unit magnitudes, or cancel
//   usable                       -> summarise, ask: overwrite, or cancel

import { fileBrowser, general } from '../state/store.js';
import { getContainerForStructure } from '../state/structures.js';
import { Spin } from '../model/index.js';
import { readIncarMagnetism, resolveIncarSpins, incarRawVectors } from '../io/ReadIncarModule.js';
import { applySpinFrame, saxisToMatrix } from '../utils/index.js';
import { multiplyMatVec } from '../math/backend-js.js';
import { updateSpins, removeSpins } from '../render/SpinModule.js';
import { choiceDialog, noticeDialog } from './ConfirmModal.js';
import { refreshActivePanels } from './panels/PanelManager.js';

// How many atoms the confirmation dialog lists before summarising the rest.
const PREVIEW_ATOMS = 8;
// MAGMOM for a large cell runs to thousands of characters as written.
const TAG_VALUE_MAX = 72;

/**
 * An INCAR that was read fine but whose moments cannot be used. Carries the
 * headline for ui/LoadErrorModal.js, whose default ("may be corrupt, empty, or
 * not in a supported format") would be wrong here: the file is a perfectly good
 * INCAR, it just has no spin field for this structure.
 */
export class IncarSpinError extends Error {
  /** @param {string} message @param {string} problem an IncarSpinProblem id */
  constructor(message, problem) {
    super(message);
    this.name = 'IncarSpinError';
    this.problem = problem;
    this.modalTitle = 'No spins were loaded from this INCAR';
    this.modalSummary = 'The file was read as a VASP INCAR, but its magnetic moments could not be '
      + 'applied to the selected structure.';
  }
}

function structureDisplayName(structure) {
  const owner = getContainerForStructure(structure);
  if (owner?.fileName && owner.fileName !== 'Unspecified') return owner.fileName;
  return structure?.uniqueElements?.join('') || 'the loaded structure';
}

function shorten(text, max = TAG_VALUE_MAX) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function fmt(value) {
  return (Object.is(value, -0) ? 0 : value).toFixed(3).padStart(8);
}

/** The preformatted "what was found" block of the confirmation dialog. */
function describeFinding(info, resolved, rawVectors, structure) {
  const lines = ['Tags in the file'];
  const shown = ['MAGMOM', 'LNONCOLLINEAR', 'LSORBIT', 'SAXIS', 'ISPIN'].filter((tag) => tag in info.present);
  const width = Math.max(...shown.map((tag) => tag.length));
  for (const tag of shown) lines.push(`  ${tag.padEnd(width)} = ${shorten(info.present[tag])}`);
  if (resolved.saxisIsDefault) lines.push(`  ${'SAXIS'.padEnd(width)}   not set, default 0 0 1`);

  const magnetic = rawVectors.filter((v) => v.some((c) => c !== 0));
  const magnitudes = magnetic.map((v) => Math.hypot(v[0], v[1], v[2]));
  lines.push('', 'Read as');
  lines.push(resolved.noncollinear
    ? '  non-collinear: a 3-vector per atom, in the SAXIS frame'
    : '  collinear: one signed moment per atom, along SAXIS');
  let range = '';
  if (magnitudes.length) {
    // Reduce, not Math.min(...): a spread of a very large cell's moments would
    // overflow the argument limit.
    const lo = magnitudes.reduce((a, b) => Math.min(a, b)).toFixed(2);
    const hi = magnitudes.reduce((a, b) => Math.max(a, b)).toFixed(2);
    // With variables set to 1 the numbers are a pattern, not moments in μB.
    const unit = resolved.symbols.length ? '' : ' μB';
    range = lo === hi ? `, |m| = ${lo}${unit}` : `, |m| from ${lo} to ${hi}${unit}`;
  }
  lines.push(`  ${magnetic.length} of ${rawVectors.length} atoms carry a moment${range}`);
  if (resolved.symbols.length) {
    lines.push(`  variable${resolved.symbols.length === 1 ? '' : 's'} ${resolved.symbols.join(', ')} replaced by 1`);
  }

  const columns = resolved.noncollinear ? ['m1', 'm2', 'm3'] : ['m'];
  lines.push('', `${'Atom'.padEnd(7)}  ${columns.map((c) => c.padStart(8)).join(' ')}`);
  rawVectors.slice(0, PREVIEW_ATOMS).forEach((v, i) => {
    const label = `${String(i + 1).padStart(3)} ${String(structure.elements[i] ?? '').padEnd(3)}`;
    lines.push(`${label}  ${resolved.noncollinear ? v.map(fmt).join(' ') : fmt(v[2])}`);
  });
  if (rawVectors.length > PREVIEW_ATOMS) lines.push(`  … and ${rawVectors.length - PREVIEW_ATOMS} more`);

  if (resolved.notes.length) {
    lines.push('', 'Notes');
    for (const note of resolved.notes) lines.push(`  - ${note}`);
  }
  return lines.join('\n');
}

/** Replace `structure.spins` and bring the scene and panels up to date. */
function overwriteSpins(structure, rawVectors, saxis) {
  // Same construction as io/ReadOutcarModule.js: the file's components are kept
  // as rawVector (SAXIS frame) and the rendered vector is their rotation into
  // global Cartesian, so the Spins panel can re-project between frames.
  const saxisMatrix = saxisToMatrix(saxis);
  structure.spins = rawVectors.map((rawVector, i) => new Spin({
    vector: multiplyMatVec(saxisMatrix, rawVector),
    rawVector,
    scaling: 1.0,
    color: '#008080',
    atomIndex: i,
    element: structure.elements[i],
    position: structure.atoms[i]?.position,
  }));
  structure.spinFrame = { fileSaxis: [...saxis] };
  // structure.originalSpins is left alone, as the Spins panel's own Overwrite
  // does, so its Restore button undoes this import.
  applySpinFrame(structure, {
    mode: general.spinFrameMode ?? 'file',
    customSaxis: general.spinCustomSaxis ?? [0, 0, 1],
    visualRot: general.spinVisualRot ?? [0, 0, 0],
  });

  if (general.spinsActive) {
    if (structure.spins.length) updateSpins(general.spinScale ?? 1.0);
    else removeSpins();
  }
  // The Spins panel and the Structure Info rows were built from the old spins.
  refreshActivePanels();
}

/**
 * Read an INCAR and, with the user's consent, overwrite the selected
 * structure's spins with its MAGMOM.
 *
 * @param {string} text the INCAR
 * @param {string} fileName
 * @returns {Promise<{container: object | null} | null>} null when the user
 *   cancelled; otherwise the container owning the structure that was changed
 *   (itself null for a structure built outside the file browser, e.g. by an addon)
 * @throws {IncarSpinError} when the file has no moments usable for the structure
 */
export async function loadIncarSpins(text, fileName) {
  const structure = fileBrowser.selectedStructure;
  const info = readIncarMagnetism(text);
  const resolved = resolveIncarSpins(info, structure?.atoms?.length ?? 0);
  if (!resolved.ok) throw new IncarSpinError(resolved.message, resolved.problem);

  const structureName = structureDisplayName(structure);

  // `MAGMOM = m -m`: the pattern is given, the magnitude is not. Nothing to
  // draw without a number, and inventing one silently would present a guess as
  // data — so the substitution is the user's call.
  if (resolved.symbols.length) {
    const names = resolved.symbols.join(', ');
    const plural = resolved.symbols.length > 1;
    const choice = await choiceDialog(
      `MAGMOM in ${fileName} is written with the variable${plural ? 's' : ''} ${names} instead of `
      + `${plural ? 'numbers' : 'a number'}. That fixes the relative size and orientation of the moments `
      + 'but not their magnitude, so the spin field is not completely specified.',
      {
        title: 'MAGMOM uses variables',
        detail: `MAGMOM = ${shorten(info.present.MAGMOM, 400)}`,
        choices: [
          {
            value: 'unit',
            label: 'Replace the variables with unit magnitudes',
            description: `Read ${resolved.symbols.map((s) => `${s} as 1 and -${s} as -1`).join(', ')}. `
              + 'Arrow lengths then show the pattern only, not real moments in μB.',
          },
          { value: 'cancel', label: 'Cancel', description: 'Do not load the file.' },
        ],
        cancelValue: 'cancel',
      });
    if (choice !== 'unit') return null;
  }

  const rawVectors = incarRawVectors(resolved.perAtom, 1);

  const existing = structure.spins?.length ?? 0;
  const choice = await choiceDialog(
    `${fileName} holds initial magnetic moments for all ${rawVectors.length} atoms of ${structureName}. `
    + (existing
      ? `The structure already has spins, and it can hold only one spin field, so loading these replaces them.`
      : 'The structure has no spins yet.'),
    {
      title: 'Load spins from INCAR?',
      detail: describeFinding(info, resolved, rawVectors, structure),
      choices: [
        {
          value: 'overwrite',
          label: existing ? 'Overwrite the current spins' : 'Add the spins to the structure',
          description: 'The Restore button in the Spins window brings back the spins the structure was loaded with.',
        },
        { value: 'cancel', label: 'Cancel', description: 'Leave the structure as it is.' },
      ],
      cancelValue: 'cancel',
    });
  if (choice !== 'overwrite') return null;

  overwriteSpins(structure, rawVectors, resolved.saxis);

  const owner = getContainerForStructure(structure);
  const notes = [];
  if (!general.spinsActive) notes.push('Spins are currently hidden: turn on "Show Spins" in the Features window to see them.');
  // A trajectory rebuilds each frame's spins from its frame store, so the
  // import lives on the frame that is showing and not on the others.
  if ((owner?.frameCount ?? 1) > 1) notes.push('This structure is one frame of a trajectory: the spins were set on the frame shown now and are not stored with the other frames.');
  // Not awaited, as with a WAVECAR: the load is finished either way.
  noticeDialog(
    `The magnetic moments in ${fileName} were written to the spins of ${structureName}.`,
    { title: 'INCAR spins loaded', detail: notes.join('\n') });

  console.log(`INCAR: ${rawVectors.length} ${resolved.noncollinear ? 'non-collinear' : 'collinear'} moments applied to ${structureName}`);
  return { container: owner };
}
