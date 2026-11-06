// Geometry of an arbitrary atom selection, for the Polyhedron Inspector's
// selection mode: the selected atoms (the exact on-screen copies that were
// picked), the bonds among them under the Bonds-tab cutoffs, and the angle
// between every pair of selected bonds that meet at an atom. Plus the
// "neighbours" the inspector's Add atoms tool offers: displayed atoms bonded to
// the selection but not in it. Pure data: no rendering — the mini view draws
// it (ui/AnalysisPanels/PolyhedronMiniRenderer.js).

import { getBondCutoff, getBondMinCutoff } from './BondsFracUpdateModule.js';
import {
  renderedAtomRadius, atomColorHex, renderedBondLookup, posKey, angleAtCenterDeg,
} from './PolyhedraAnalysisModule.js';
import { counterpartCart } from './StructureMatchModule.js';
import { invert3x3, transpose3x3 } from '../math/index.js';
import { general } from '../state/store.js';

function dist3(p, q) {
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

function asArray(p) {
  if (!p) return null;
  if (Array.isArray(p)) return p;
  return [p.x, p.y, p.z];
}

/** Whether two placed atoms are bonded, by the same rule the main view draws
 *  bonds with: inside the pair's min..max range and the pair not hidden. */
function bonded(elA, elB, d) {
  const max = getBondCutoff(elA, elB);
  return max > 0.01 && d <= max && d >= getBondMinCutoff(elA, elB) && d > 1e-3;
}

/** Stable identity of a placed atom: its source atom plus where it sits.
 *  Instance ids change whenever the displayed set is rebuilt; positions of the
 *  same copy do not, so label keys built from this survive a rebuild. */
export function placedAtomKey(srcIndex, pos) {
  return `${srcIndex}@${posKey(pos)}`;
}

/** Label keys, shared by the inspector's two modes so a label hidden while
 *  looking at a polyhedron stays hidden in a selection with the same atoms. */
export function bondLabelKey(keyA, keyB) {
  const [a, b] = [keyA, keyB].sort();
  return `b:${a}|${b}`;
}
export function angleLabelKey(keyAt, keyI, keyJ) {
  const [i, j] = [keyI, keyJ].sort();
  return `a:${keyAt}:${i}|${j}`;
}

/**
 * @param {any} structure the active structure
 * @param {Array<{instanceId:number, sourceIndex:number, element:string, position:any}>} selectedAtoms
 *   from SelectAndHighlightModule.getSelectedAtoms()
 * @returns {null | {
 *   atoms: Array<{key:string, instanceId:number, srcIndex:number, element:string, pos:number[], color:number|null, radius:number}>,
 *   bonds: Array<{key:string, a:number, b:number, length:number, colorA:number|null, colorB:number|null, trimA:number|null, trimB:number|null}>,
 *   angles: Array<{key:string, at:number, i:number, j:number, angleDeg:number}>,
 *   formula: string, meanBond: number|null }}
 */
export function computeSelectionDetail(structure, selectedAtoms) {
  if (!structure || !selectedAtoms?.length) return null;
  const atoms = [];
  const seen = new Set();
  for (const sel of selectedAtoms) {
    const pos = asArray(sel.position);
    const src = sel.sourceIndex;
    if (!pos || !Number.isInteger(src)) continue;
    const key = placedAtomKey(src, pos);
    if (seen.has(key)) continue;
    seen.add(key);
    const element = sel.element ?? structure.elements?.[src] ?? '?';
    atoms.push({
      key, instanceId: sel.instanceId, srcIndex: src, element, pos,
      color: atomColorHex(structure, src),
      radius: renderedAtomRadius(structure, src, element),
    });
  }
  if (!atoms.length) return null;

  const bonds = [];
  const bondsAt = atoms.map(() => []);
  const drawnBond = renderedBondLookup(structure);
  for (let a = 0; a < atoms.length; a++) {
    for (let b = a + 1; b < atoms.length; b++) {
      const d = dist3(atoms[a].pos, atoms[b].pos);
      if (!bonded(atoms[a].element, atoms[b].element, d)) continue;
      const drawn = drawnBond(atoms[a].pos, atoms[b].pos);
      bonds.push({
        key: bondLabelKey(atoms[a].key, atoms[b].key), a, b, length: d,
        colorA: drawn?.hexA ?? null, colorB: drawn?.hexB ?? null,
        trimA: drawn?.trimA ?? null, trimB: drawn?.trimB ?? null,
      });
      bondsAt[a].push(b);
      bondsAt[b].push(a);
    }
  }

  const angles = [];
  for (let at = 0; at < atoms.length; at++) {
    const nb = bondsAt[at];
    for (let x = 0; x < nb.length; x++) {
      for (let y = x + 1; y < nb.length; y++) {
        angles.push({
          key: angleLabelKey(atoms[at].key, atoms[nb[x]].key, atoms[nb[y]].key), at, i: nb[x], j: nb[y],
          angleDeg: angleAtCenterDeg(atoms[at].pos, atoms[nb[x]].pos, atoms[nb[y]].pos),
        });
      }
    }
  }

  const counts = new Map();
  for (const a of atoms) counts.set(a.element, (counts.get(a.element) ?? 0) + 1);
  const formula = [...counts.entries()].map(([el, n]) => (n > 1 ? `${el}${n}` : el)).join(' ');
  const meanBond = bonds.length ? bonds.reduce((s, b) => s + b.length, 0) / bonds.length : null;
  return { atoms, bonds, angles, formula, meanBond };
}

/**
 * Displayed atoms bonded to the selection but not in it, each with the
 * selected atoms it bonds to — the faint atoms the inspector's Add atoms tool
 * offers. With "Link periodic copies" on, a selection entry stands for every
 * copy of its source atom, so another copy of a selected atom cannot be added:
 * those are counted in `linkedCopies` instead of being offered.
 * @param {any} structure
 * @param {NonNullable<ReturnType<typeof computeSelectionDetail>>} detail
 * @returns {{ atoms: Array<{key:string, instanceId:number, srcIndex:number, element:string, pos:number[], color:number|null, radius:number, partners:number[], partnerBonds:Array<ReturnType<ReturnType<typeof renderedBondLookup>>>}>, linkedCopies:number }}
 */
export function findSelectionNeighbours(structure, detail) {
  const out = { atoms: [], linkedCopies: 0 };
  const wrapped = structure?.periodic?.visibleWrapped;
  if (!detail?.atoms?.length || !wrapped?.cart?.length) return out;
  const selectedKeys = new Set(detail.atoms.map((a) => a.key));
  const selectedSrc = new Set(detail.atoms.map((a) => a.srcIndex));
  const linked = general.linkPeriodicCopies !== false;
  const drawnBond = renderedBondLookup(structure);
  for (let inst = 0; inst < wrapped.cart.length; inst++) {
    const pos = wrapped.cart[inst];
    const src = wrapped.srcIndex?.[inst] ?? inst;
    const element = wrapped.elements?.[inst] ?? structure.elements?.[src];
    const partners = [];
    for (let k = 0; k < detail.atoms.length; k++) {
      const a = detail.atoms[k];
      if (bonded(a.element, element, dist3(a.pos, pos))) partners.push(k);
    }
    if (!partners.length) continue;
    const key = placedAtomKey(src, pos);
    if (selectedKeys.has(key)) continue;
    if (linked && selectedSrc.has(src)) { out.linkedCopies++; continue; }
    out.atoms.push({
      key, instanceId: inst, srcIndex: src, element, pos,
      color: atomColorHex(structure, src),
      radius: renderedAtomRadius(structure, src, element),
      partners,
      // The main view's drawn bond to each partner (colours, clipped ends),
      // partner side first.
      partnerBonds: partners.map((k) => drawnBond(detail.atoms[k].pos, pos)),
    });
  }
  return out;
}

/**
 * The same bonds and angles measured in a matched second structure
 * (render/StructureMatchModule.js matchStructures): each selected atom's
 * partner, in the copy that overlays it, so a bond across a cell face is
 * measured across the same face there.
 * @param {NonNullable<ReturnType<typeof computeSelectionDetail>>} detail
 * @param {ReturnType<typeof import('./StructureMatchModule.js').matchStructures>} match an ok match
 * @returns {{ bonds: number[], angles: number[], atoms: Array<{srcIndex:number, pos:number[]}> }}
 *   bonds/angles aligned with detail.bonds / detail.angles; atoms: each
 *   selected atom's partner in B (its index there and the copy measured), for
 *   B's own CIF errors (model/cifErrors.js modelErrors)
 */
export function compareSelectionDetail(detail, match, A, B) {
  const latInv = invert3x3(transpose3x3(A.lattice));
  const pos = detail.atoms.map((a) => counterpartCart(match, A, B, a.srcIndex, a.pos, latInv));
  return {
    bonds: detail.bonds.map((b) => dist3(pos[b.a], pos[b.b])),
    angles: detail.angles.map((g) => angleAtCenterDeg(pos[g.at], pos[g.i], pos[g.j])),
    atoms: detail.atoms.map((a, k) => ({ srcIndex: match.map[a.srcIndex], pos: pos[k] })),
  };
}
