// SymmetryWyckoffTabStub.js
//
// Placeholder for symmetry/Wyckoff-position-based structure generation
// (in development in a separate repo). Registered as a disabled, top-level
// tab in AddStructureModule.js today (a peer of "Atoms", not nested under
// it) - this file only documents the extension point.
//
// Future contract: a real implementation owns its own Lattice section (see
// LatticeInputPanel.js) rather than reusing the Atoms tab's instance, since
// a chosen space group constrains/derives the lattice parameters (e.g. cubic
// locks a=b=c and all angles to 90 degrees) - the Atoms tab's free-form
// lattice input doesn't apply here. It should generate atoms (Cartesian
// {element, x, y, z, color}) from the space group + Wyckoff positions, then
// hand them to the same pipeline the Atoms tab uses:
//   1. AtomCollisionCheck.js's checkAtomCollisions(...) against the atoms
//      already entered on the Atoms tab / the target structure's atoms.
//   2. CollisionWarningUI.js's wireCollisionGuardedButton(...) for the
//      warning + "Add Anyway" confirmation.
//   3. CommitAtoms.js's addAtomsToExistingStructure(...) or
//      createNewStructureFromAtoms(...) to commit.
// This gets the same collision-warning UX for free with no changes to the
// existing modals.

export function createSymmetryWyckoffTab(container) {
  container.innerHTML = `
    <div class="wyckoff-stub-message">
      Symmetry (Wyckoff) based structure generation is coming soon.
    </div>
  `;
}
