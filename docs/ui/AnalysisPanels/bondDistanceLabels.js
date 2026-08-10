// Floating "X.XXX Å" labels dropped at each highlighted bond's midpoint when
// the Bond Length Histogram's "Show distances" toggle is on. Deliberately
// lighter-weight than render/MeasurementModule.js's addDistanceMeasurement:
// that one draws its own dashed cylinder + atom-ring markers and expects live
// picked atom meshes, because it drives the interactive click-to-measure
// tool. Here the bonds are already known by render instance id (the
// histogram bin) and already highlighted by highlightBondIn3D, so only the
// text label is needed — reusing its .measure-label visual style for
// consistency with the Measure tool.

import { app } from '../../state/store.js';
import { CSS2DObject } from '../../external/three/CSS2DRenderer.js';
import { getBondByInstanceId } from '../../render/BondsFracUpdateModule.js';

/** @type {any[]} */
let labels = [];

/** instanceIds: render instance ids (bond.instanceIds, both halves) for the
 *  bonds to label — duplicates (both halves of the same physical bond)
 *  collapse to one label at that bond's midpoint. */
export function showBondDistanceLabels(instanceIds) {
  clearBondDistanceLabels();
  const seen = new Set();
  for (const id of instanceIds ?? []) {
    const bond = getBondByInstanceId(id);
    if (!bond || seen.has(bond) || !bond.positions) continue;
    seen.add(bond);

    const [p1, p2] = bond.positions;
    const div = document.createElement('div');
    div.className = 'measure-label bond-distance-label';
    div.textContent = `${bond.dist.toFixed(3)} Å`;

    const label = /** @type {any} */ (new CSS2DObject(div));
    label.position.set(
      (p1[0] + p2[0]) / 2,
      (p1[1] + p2[1]) / 2,
      (p1[2] + p2[2]) / 2,
    );
    app.scene.add(label);
    labels.push(label);
  }
}

export function clearBondDistanceLabels() {
  labels.forEach((label) => app.scene.remove(label));
  labels = [];
}
