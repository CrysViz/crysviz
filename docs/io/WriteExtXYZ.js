// Extended XYZ writer: frames of a trajectory as one text file, the format
// ASE, pymatgen and OVITO read. Plain arrays in, text out (SavePanel.js
// extxyzExport gathers a row's frames, for the Download menu and the host).

const fmt = (x) => (Number.isFinite(x) ? x.toFixed(8) : 'nan');

/**
 * @param {Array<{lattice?: number[][]|null, positions: number[][], elements: string[], energy?: number, step?: number}>} frames
 *   positions fractional when the frame has a lattice, Cartesian (Å) otherwise
 * @returns {string}
 */
export function writeExtXYZ(frames) {
  const out = [];
  for (const frame of frames) {
    const { lattice, positions, elements } = frame;
    const periodic = Array.isArray(lattice) && lattice.length === 3;
    const info = [];
    if (periodic) info.push(`Lattice="${lattice.flat().map(fmt).join(' ')}"`);
    info.push('Properties=species:S:1:pos:R:3');
    if (Number.isFinite(frame.energy)) info.push(`energy=${fmt(frame.energy)}`);
    if (Number.isInteger(frame.step)) info.push(`step=${frame.step}`);
    info.push(`pbc="${periodic ? 'T T T' : 'F F F'}"`);
    out.push(String(positions.length), info.join(' '));
    positions.forEach((p, i) => {
      const cart = periodic
        ? [0, 1, 2].map((k) => p[0] * lattice[0][k] + p[1] * lattice[1][k] + p[2] * lattice[2][k])
        : p;
      out.push(`${elements[i]} ${cart.map(fmt).join(' ')}`);
    });
  }
  return `${out.join('\n')}\n`;
}
