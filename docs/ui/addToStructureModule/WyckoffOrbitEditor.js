// WyckoffOrbitEditor.js
//
// What the Modify Structure panel shows while the structure carries a Wyckoff
// symmetry lock. Free-form atom editing is deliberately NOT offered here: with
// a lock in place the only edits that keep it true are moving a site along its
// degrees of freedom (every atom of the orbit moves with it) and deleting a
// whole orbit. Adding an atom, deleting one atom of a multiplicity-N site, or
// changing the cell would all invalidate the very operations the lock is built
// from — unlock the structure (Symmetry panel) to do those.

import {
  getWyckoffOrbitGroups, getOrbitAxisFreedom, applyWyckoffOrbitPosition, removeWyckoffOrbit,
} from '../SymmetryEditModule.js';
import { fileBrowser } from '../../state/store.js';
import { highlightAtomsIn3D, clearHighlightAtom } from '../SelectAndHighlightModule.js';

const AXES = ['x', 'y', 'z'];

const CARD_STYLE = 'border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; padding: 8px; margin-bottom: 8px;';
const HEADER_STYLE = 'display:flex; align-items:center; gap:8px; font-size:12px; cursor:pointer;';
const INPUT_STYLE = 'width:72px; text-align:right; font-family:monospace; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.15); border-radius:4px; color:white; padding:3px 5px; box-sizing:border-box;';
const NOTE_STYLE = 'font-size:11px; color:rgba(255,255,255,0.55); margin-top:6px;';

const round4 = (value) => Number(Number(value).toFixed(4));

/**
 * @param {HTMLElement} body
 * @returns {{dispose: () => void}}
 */
export function buildWyckoffOrbitEditor(body) {
  const intro = document.createElement('div');
  intro.textContent = 'Symmetry is locked. Each site moves only along its degrees of freedom; frozen axes are greyed out. Removing a site removes every atom of its orbit.';
  intro.style.cssText = 'font-size:11px; color:rgba(255,255,255,0.6); margin-bottom:10px;';
  body.appendChild(intro);

  const listHost = document.createElement('div');
  body.appendChild(listHost);

  let highlightedOrbitId = null;
  /** @type {Array<{orbitId: number, inputs: HTMLInputElement[], representativeIndex: number}>} */
  let cards = [];

  function render() {
    listHost.innerHTML = '';
    cards = [];
    const structure = fileBrowser.selectedStructure;
    const orbits = getWyckoffOrbitGroups(structure);

    if (!orbits.length) {
      const empty = document.createElement('div');
      empty.textContent = 'No Wyckoff orbits — the structure is not symmetry-locked.';
      empty.style.cssText = NOTE_STYLE;
      listHost.appendChild(empty);
      return;
    }

    orbits.forEach((orbit) => {
      const card = document.createElement('div');
      card.style.cssText = CARD_STYLE;

      const header = document.createElement('div');
      header.style.cssText = HEADER_STYLE;
      header.title = 'Click to highlight this orbit in the 3D view';

      const label = document.createElement('span');
      label.textContent = `${orbit.element}  ${orbit.wyckoff}`;
      label.style.cssText = 'font-weight:600;';
      header.appendChild(label);

      const detail = document.createElement('span');
      detail.textContent = `×${orbit.multiplicity}  ${orbit.siteSymmetry}  ·  ${orbit.dofDimension} DOF`;
      detail.style.cssText = 'color:rgba(255,255,255,0.6); flex-grow:1;';
      header.appendChild(detail);

      const removeBtn = document.createElement('button');
      removeBtn.textContent = '✕';
      removeBtn.className = 'btn-mini';
      removeBtn.title = orbits.length <= 1
        ? 'The last orbit cannot be removed — it would leave an empty structure'
        : `Remove all ${orbit.multiplicity} ${orbit.element} atoms of this orbit`;
      removeBtn.disabled = orbits.length <= 1;
      removeBtn.style.cssText = 'width:20px; height:20px; padding:0; line-height:0; display:flex; align-items:center; justify-content:center; flex-shrink:0;';
      header.appendChild(removeBtn);

      header.addEventListener('click', (e) => {
        if (/** @type {HTMLElement} */ (e.target).closest('button')) return;
        clearHighlightAtom();
        if (highlightedOrbitId === orbit.orbitId) {
          highlightedOrbitId = null;
          return;
        }
        highlightedOrbitId = orbit.orbitId;
        highlightAtomsIn3D(orbit.atomIndices);
      });

      removeBtn.addEventListener('click', () => {
        clearHighlightAtom();
        highlightedOrbitId = null;
        if (!removeWyckoffOrbit(orbit.orbitId)) return;
        render();
      });

      card.appendChild(header);

      const freedom = getOrbitAxisFreedom(orbit);
      const position = structure.atoms[orbit.representativeIndex].position;

      const coordRow = document.createElement('div');
      coordRow.style.cssText = 'display:flex; align-items:center; gap:6px; margin-top:8px;';
      const inputs = AXES.map((axis, i) => {
        const wrapper = document.createElement('label');
        wrapper.style.cssText = 'display:flex; align-items:center; gap:4px; font-size:11px; color:rgba(255,255,255,0.7);';
        wrapper.textContent = axis;

        const input = document.createElement('input');
        input.type = 'number';
        input.step = '0.01';
        input.className = 'coord-input';
        input.style.cssText = INPUT_STYLE;
        input.value = String(round4(position[i]));
        if (!freedom[i]) {
          input.disabled = true;
          input.style.opacity = '0.45';
          input.title = `${axis} is fixed by the site symmetry`;
        }
        wrapper.appendChild(input);
        coordRow.appendChild(wrapper);
        return input;
      });

      const applyBtn = document.createElement('button');
      applyBtn.textContent = 'Apply';
      applyBtn.className = 'btn-mini highlight';
      applyBtn.disabled = orbit.isFixed;
      if (orbit.isFixed) applyBtn.title = 'This site has no degrees of freedom';
      coordRow.appendChild(applyBtn);
      card.appendChild(coordRow);

      const note = document.createElement('div');
      note.style.cssText = NOTE_STYLE;
      note.textContent = orbit.isFixed ? 'Fixed by symmetry — no free parameters.' : '';
      card.appendChild(note);

      applyBtn.addEventListener('click', () => {
        const target = inputs.map((input) => parseFloat(input.value) || 0);
        // false means the move was refused: it would have put two symmetry
        // images close enough together that the cell stops being analysable at
        // the tolerance the lock was built at.
        if (applyWyckoffOrbitPosition(orbit.representativeIndex, target)) {
          note.textContent = '';
          return;
        }
        note.textContent = 'Move refused — it would collapse two sites onto each other.';
      });

      cards.push({ orbitId: orbit.orbitId, inputs, representativeIndex: orbit.representativeIndex });
      listHost.appendChild(card);
    });
  }

  // Coordinates edited elsewhere (the Structure Info panel's orbit sliders
  // drive the same applyWyckoffOrbitPosition) land here. Only untouched,
  // unfocused inputs are refreshed so a value being typed isn't overwritten.
  function syncFromStructure() {
    const structure = fileBrowser.selectedStructure;
    if (!structure) return;
    cards.forEach(({ inputs, representativeIndex }) => {
      const position = structure.atoms[representativeIndex]?.position;
      if (!position) return;
      inputs.forEach((input, i) => {
        if (input === document.activeElement) return;
        input.value = String(round4(position[i]));
      });
    });
  }

  render();
  document.addEventListener('crysviz:atoms-changed', syncFromStructure);

  return {
    dispose() {
      document.removeEventListener('crysviz:atoms-changed', syncFromStructure);
      if (highlightedOrbitId !== null) clearHighlightAtom();
    },
  };
}
