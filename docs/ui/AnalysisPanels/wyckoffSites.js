// Per-atom Wyckoff site labels for the Bond Length and Force histograms'
// "Group by Wyckoff" toggle. A site is one crystallographic orbit of the
// structure's Wyckoff lock (structure.symmetry.orbitGroups, built by
// ui/SymmetryEditModule.js), named the way the Structure panel's Wyckoff tab
// names its rows (CompositionRow.js): element, the orbit's number among that
// element's orbits, then multiplicity + letter — "O2 (2q)". Two orbits that
// share a letter (two independent 4e oxygen sites) stay apart as O1 (4e) and
// O2 (4e): they are different sites with their own coordinates and bonds.

/** Event the histograms listen for: Wyckoff mode was switched on or off. */
export const SYMMETRY_MODE_CHANGED = 'crysviz:symmetry-mode-changed';

/** True while `structure` is locked in Wyckoff mode with at least one orbit. */
export function hasWyckoffSites(structure) {
  return structure?.symmetry?.mode === 'wyckoff'
    && Array.isArray(structure.symmetry.orbitGroups)
    && structure.symmetry.orbitGroups.length > 0;
}

/**
 * Site label and sort rank for every atom of `structure`, or null outside
 * Wyckoff mode. Ranks order sites by element (as the Wyckoff tab sorts them),
 * then by orbit number. An atom outside every orbit (not expected under a lock)
 * keeps its bare element symbol and sorts after the sites.
 * @returns {{ labels: string[], ranks: number[] } | null}
 */
export function wyckoffSites(structure) {
  if (!hasWyckoffSites(structure)) return null;
  const atomCount = structure.atoms?.length ?? 0;
  const elements = structure.elements ?? [];

  const perElement = new Map();
  const sites = structure.symmetry.orbitGroups.map((group) => {
    const number = (perElement.get(group.element) ?? 0) + 1;
    perElement.set(group.element, number);
    const symbol = group.wyckoff && group.wyckoff !== '?' ? ` (${group.multiplicity}${group.wyckoff})` : '';
    return { group, element: String(group.element), number, label: `${group.element}${number}${symbol}` };
  });
  sites.sort((a, b) => (a.element < b.element ? -1 : a.element > b.element ? 1 : a.number - b.number));

  const labels = new Array(atomCount).fill(null);
  const ranks = new Array(atomCount).fill(sites.length);
  sites.forEach((site, rank) => {
    for (const atomIndex of site.group.atomIndices ?? []) {
      if (atomIndex >= 0 && atomIndex < atomCount) {
        labels[atomIndex] = site.label;
        ranks[atomIndex] = rank;
      }
    }
  });
  for (let i = 0; i < atomCount; i++) labels[i] ??= elements[i] ?? '?';
  return { labels, ranks };
}
