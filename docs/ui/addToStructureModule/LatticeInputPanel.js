// LatticeInputPanel.js
//
// Lattice-entry UI shared by the Add-Structure panel's Atoms and Symmetry
// modes: "Parameters" (a, b, c, alpha, beta, gamma) and "Matrix" (3x3
// Cartesian row vectors) shown side by side (separated by a vertical
// divider), both editing one shared lattice matrix live as either side is
// typed into. Styled to match the app's existing lattice-input convention
// (see docs/ui/LatticeSupercellPanel.js's ".LatticeInput": right-aligned
// monospace values next to plain labels) rather than a boxed/bordered form.
// Unlike LatticeSupercellPanel.js (which reimplements the params<->matrix
// formulas inline), this calls the math facade
// (latticeFromCell/latticeParameters) directly.

import { latticeFromCell, latticeParameters } from '../../math/index.js';
import { makeSectionHeadline } from '../panels/sectionHeadline.js';

const TABLE_STYLE = 'width:100%; border-collapse:collapse; font-size:12px;';
const LABEL_STYLE = 'padding:4px 6px 4px 0; color:rgba(255,255,255,0.7); text-align:right; white-space:nowrap;';
const CELL_STYLE = 'padding:4px 4px 4px 4px;';
const INPUT_STYLE = 'width:70px; text-align:right; font-family:monospace; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.15); border-radius:4px; color:white; padding:3px 5px; box-sizing:border-box;';

function paramRow(labelA, idA, labelB, idB) {
  return `
    <tr>
      <td style="${LABEL_STYLE}">${labelA}</td>
      <td style="${CELL_STYLE}"><input type="number" id="${idA}" step="0.01" class="LatticeInput coord-input" style="${INPUT_STYLE}"></td>
      <td style="${LABEL_STYLE}">${labelB}</td>
      <td style="${CELL_STYLE}"><input type="number" id="${idB}" step="0.01" class="LatticeInput coord-input" style="${INPUT_STYLE}"></td>
    </tr>
  `;
}

// createLatticeInputPanel(container, { initial, onChange }) -> { getLattice, setLattice }
/**
 * @param {HTMLElement} container
 * @param {{initial?: number[][], onChange?: (lattice: number[][]) => void}} options
 */
export function createLatticeInputPanel(container, { initial, onChange } = {}) {
  let lattice = initial || [[10, 0, 0], [0, 10, 0], [0, 0, 10]];

  container.appendChild(makeSectionHeadline('Lattice'));

  const hint = document.createElement('div');
  hint.textContent = 'Input either lattice parameters or the matrix - both stay in sync.';
  hint.style.cssText = 'text-align:center; font-size:11px; color:rgba(255,255,255,0.5); margin-bottom:10px;';
  container.appendChild(hint);

  const row = document.createElement('div');
  row.style.cssText = 'display:flex; align-items:flex-start; gap:14px;';

  const paramsCol = document.createElement('div');
  paramsCol.style.cssText = 'flex:1 1 0; min-width:0;';

  const divider = document.createElement('div');
  divider.style.cssText = 'width:1px; align-self:stretch; background:rgba(255,255,255,0.15);';

  const matrixCol = document.createElement('div');
  matrixCol.style.cssText = 'flex:1 1 0; min-width:0; display:flex; justify-content:center;';

  row.appendChild(paramsCol);
  row.appendChild(divider);
  row.appendChild(matrixCol);
  container.appendChild(row);

  paramsCol.innerHTML = `
    <table style="${TABLE_STYLE}">
      <tbody>
        ${paramRow('a (Å)', 'latA', 'α (°)', 'latAlpha')}
        ${paramRow('b (Å)', 'latB', 'β (°)', 'latBeta')}
        ${paramRow('c (Å)', 'latC', 'γ (°)', 'latGamma')}
      </tbody>
    </table>
  `;
  const paramInputs = {
    a: paramsCol.querySelector('#latA'),
    b: paramsCol.querySelector('#latB'),
    c: paramsCol.querySelector('#latC'),
    alpha: paramsCol.querySelector('#latAlpha'),
    beta: paramsCol.querySelector('#latBeta'),
    gamma: paramsCol.querySelector('#latGamma'),
  };

  matrixCol.innerHTML = `
    <table style="border-collapse:collapse; font-size:12px;">
      <tbody>
        ${[0, 1, 2].map(i => `
          <tr>
            ${[0, 1, 2].map(j => `<td style="${CELL_STYLE}"><input type="number" class="lat-mat LatticeInput coord-input" data-i="${i}" data-j="${j}" step="0.01" style="${INPUT_STYLE}"></td>`).join('')}
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
  const matrixInputs = [[null, null, null], [null, null, null], [null, null, null]];
  matrixCol.querySelectorAll('.lat-mat').forEach(input => {
    const i = parseInt(input.dataset.i, 10);
    const j = parseInt(input.dataset.j, 10);
    matrixInputs[i][j] = input;
  });

  function syncParamsFromLattice() {
    const { a, b, c, alpha, beta, gamma } = latticeParameters(lattice);
    paramInputs.a.value = a.toFixed(4);
    paramInputs.b.value = b.toFixed(4);
    paramInputs.c.value = c.toFixed(4);
    paramInputs.alpha.value = alpha.toFixed(2);
    paramInputs.beta.value = beta.toFixed(2);
    paramInputs.gamma.value = gamma.toFixed(2);
  }

  function syncMatrixFromLattice() {
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        matrixInputs[i][j].value = lattice[i][j].toFixed(4);
      }
    }
  }

  Object.values(paramInputs).forEach(input => {
    input.addEventListener('input', () => {
      const a = parseFloat(paramInputs.a.value) || 0;
      const b = parseFloat(paramInputs.b.value) || 0;
      const c = parseFloat(paramInputs.c.value) || 0;
      const alpha = parseFloat(paramInputs.alpha.value) || 0;
      const beta = parseFloat(paramInputs.beta.value) || 0;
      const gamma = parseFloat(paramInputs.gamma.value) || 0;
      if (a > 0 && b > 0 && c > 0 && alpha > 0 && beta > 0 && gamma > 0) {
        lattice = latticeFromCell(a, b, c, alpha, beta, gamma);
        syncMatrixFromLattice();
        onChange?.(lattice);
      }
    });
  });

  matrixCol.querySelectorAll('.lat-mat').forEach(input => {
    const i = parseInt(input.dataset.i, 10);
    const j = parseInt(input.dataset.j, 10);
    input.addEventListener('input', () => {
      lattice[i][j] = parseFloat(input.value) || 0;
      syncParamsFromLattice();
      onChange?.(lattice);
    });
  });

  syncParamsFromLattice();
  syncMatrixFromLattice();

  return {
    getLattice: () => lattice,
    // Replace the shown cell wholesale (revert / reset-lattice) - refreshes
    // both the parameter and matrix views. Does NOT fire onChange: the caller
    // that resets the structure is already driving the render itself.
    setLattice: (next) => {
      lattice = next.map((row) => [...row]);
      syncParamsFromLattice();
      syncMatrixFromLattice();
    },
  };
}
