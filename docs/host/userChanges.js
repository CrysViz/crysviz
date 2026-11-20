// What changed in the window between two host commands that no command did:
// the user's own edits, selection, camera or renderer changes. BrowserHost
// snapshots the window after every command and compares the snapshot with a
// fresh one when the next command arrives; a difference goes back with that
// command's result as sinceLastCall, so the model learns about a hand edit on
// its very next call of any tool instead of being refused or told.

import { getActiveStructure, getContainerForStructure, getContainerId } from '../state/structures.js';
import { atomIds, structureContent, structureRevision } from '../model/structureRevision.js';
import { cameraState, composition } from './commands.js';
import { listJobs } from './jobs.js';

/** Per-atom elements are kept (to name element changes) up to this many atoms. */
const MAX_TRACKED_ATOMS = 20000;
/** Atom indices listed in a note; beyond this only the count. */
const MAX_LISTED = 50;
/** Camera direction/up components and relative zoom closer than this count as unchanged. */
const CAMERA_TOLERANCE = 1e-2;

/** The window's state as the model would see it, compactly. */
export async function takeSnapshot(deps) {
  const structure = getActiveStructure();
  const container = structure ? getContainerForStructure(structure) : null;
  let selection = [];
  let pick = null;
  let saved = '';
  if (structure) {
    try {
      const query = await import('./query.js');
      selection = await query.userSelection();
      pick = await query.userPick();
      saved = (await query.savedUserSelections()).map((s) => s.name).join('\n');
    } catch { /* no selection module yet */ }
  }
  const camera = cameraState();
  const jobs = listJobs();
  // A playing phonon animation moves the atoms every frame; that is no user edit.
  let animating = false;
  try { animating = !!(await import('../phonon/phononSession.js')).phononState?.playing; } catch { /* no phonons */ }
  return {
    structure: container ? getContainerId(container) : null,
    name: container ? String(container.fileName) : null,
    frame: container ? container.structures.indexOf(structure) : null,
    revision: structure ? structureRevision(structure) : null,
    content: structure ? structureContent(structure) : null,
    formula: structure ? composition(structure.atoms).formula : null,
    atomCount: structure?.atoms.length ?? 0,
    elements: structure && structure.atoms.length <= MAX_TRACKED_ATOMS
      ? structure.atoms.map((atom) => atom.getRepresentativeElement?.() ?? '') : null,
    // Atom identity per index, for the expectedRevision guard (BrowserHost).
    ids: structure && structure.atoms.length <= MAX_TRACKED_ATOMS ? atomIds(structure) : null,
    selection,
    pick,
    saved,
    camera: camera ? { direction: camera.direction, up: camera.up, zoom: camera.zoom } : null,
    renderer: typeof deps?.getRenderPipeline === 'function' ? deps.getRenderPipeline() : null,
    jobs: jobs.map((job) => `${job.jobId}:${job.status}`).join(','),
    jobRunning: jobs.some((job) => job.status === 'running'),
    animating,
  };
}

const near = (u, v) => u.length === v.length && u.every((x, i) => Math.abs(x - v[i]) <= CAMERA_TOLERANCE);

function cameraMoved(a, b) {
  if (!a || !b) return a !== b;
  return !near(a.direction, b.direction) || !near(a.up, b.up)
    || Math.abs(a.zoom - b.zoom) > CAMERA_TOLERANCE * Math.max(1, Math.abs(a.zoom));
}

const listed = (indices) => (indices.length <= MAX_LISTED ? indices : indices.slice(0, MAX_LISTED));

/**
 * What changed from `prev` (after the last command) to `next` (now), or null.
 * While a calculation job runs or has just ended, the active structure is the
 * job's (a working copy, then its trajectory row): structure changes are then
 * left out, as the job reports its own result.
 * @param {any} prev @param {any} next
 */
export function diffSnapshots(prev, next) {
  if (!prev || !next) return null;
  const out = {};
  const notes = [];
  const jobActivity = prev.jobRunning || next.jobRunning || prev.jobs !== next.jobs;
  if (!jobActivity) {
    if (prev.structure !== next.structure) {
      out.structure = {
        from: prev.name, to: next.name, structure: next.structure, frame: next.frame,
        formula: next.formula, atomCount: next.atomCount, revision: next.revision,
      };
      notes.push(`the active structure is now ${next.name ?? 'none'}`);
    } else if (next.structure !== null) {
      if (prev.frame !== next.frame) {
        out.frame = { from: prev.frame, to: next.frame };
        notes.push(`frame ${prev.frame} -> ${next.frame}`);
      }
      if (prev.revision !== next.revision) {
        const change = { from: prev.formula, to: next.formula, atomCount: next.atomCount, revision: next.revision };
        if (prev.atomCount !== next.atomCount) {
          change.atomCountFrom = prev.atomCount;
          notes.push(`atoms ${prev.atomCount} -> ${next.atomCount} (${prev.formula} -> ${next.formula}); indices may have shifted`);
        } else if (prev.elements && next.elements) {
          const changed = [];
          /** @type {Record<string, number>} */
          const pairs = {};
          next.elements.forEach((element, i) => {
            if (element === prev.elements[i]) return;
            changed.push(i);
            const key = `${prev.elements[i]}->${element}`;
            pairs[key] = (pairs[key] || 0) + 1;
          });
          if (changed.length) {
            change.elementChanges = { count: changed.length, atoms: listed(changed), pairs };
            const summary = Object.entries(pairs).map(([pair, n]) => `${pair} x${n}`).join(', ');
            notes.push(`${changed.length} atom${changed.length === 1 ? '' : 's'} changed element (${summary})`);
          } else {
            notes.push(`the structure changed (${prev.formula} -> ${next.formula}): cell or occupancies`);
          }
        } else {
          notes.push(`the structure changed (${prev.formula} -> ${next.formula})`);
        }
        out.structure = change;
      } else if (prev.content !== next.content && !prev.animating && !next.animating) {
        out.structure = { moved: true, revision: next.revision };
        notes.push('atoms were moved');
      }
    }
  }
  const prevSel = prev.selection.join(',');
  if (prevSel !== next.selection.join(',')) {
    out.selection = { count: next.selection.length, atoms: listed(next.selection),
      ...(next.selection.length > MAX_LISTED ? { truncated: true } : {}) };
    notes.push(`the user's selection is now ${next.selection.length} atom${next.selection.length === 1 ? '' : 's'}`);
  }
  if (JSON.stringify(prev.pick ?? null) !== JSON.stringify(next.pick ?? null)) {
    out.selection = { ...(out.selection ?? { count: next.selection.length, atoms: listed(next.selection) }), pick: next.pick };
    if (next.pick) {
      const one = next.pick.count === 1;
      const what = next.pick.kind === 'bonds' ? (one ? 'bond' : 'bonds') : (one ? 'polyhedron' : 'polyhedra');
      notes.push(`the user picked ${next.pick.count} ${what} (selection.pick)`);
    }
  }
  if ((prev.saved ?? '') !== (next.saved ?? '')) {
    const names = next.saved ? next.saved.split('\n') : [];
    out.savedSelections = names;
    notes.push(names.length ? `the user's saved selections are now ${names.join(', ')}` : 'the user has no saved selections now');
  }
  if (cameraMoved(prev.camera, next.camera)) {
    out.camera = next.camera;
    notes.push('the camera moved');
  }
  if (prev.renderer !== next.renderer) {
    out.renderer = { from: prev.renderer, to: next.renderer };
    notes.push(`the renderer is now ${next.renderer}`);
  }
  if (!notes.length) return null;
  out.note = `Changed in the window since your last call (not by you): ${notes.join('; ')}.`;
  return out;
}
