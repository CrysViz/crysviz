# Cell & Supercell

Shows the lattice vectors of the current structure and lets you build a supercell (N×N×N repeat)
or apply a lattice transformation. Creating a supercell replaces the current structure's atoms
and lattice — download or duplicate the row first if you want to keep the original cell.

**Quick supercell from the search:** press Ctrl+F (⌘F on a Mac) and type the factors, such as
`222`, `232` or `2x2x1`; the first result builds that supercell. `111` goes back to the 1×1×1 cell.

## Order Structure (fractional occupation)

A structure with fractionally occupied sites (a solid solution, a partially occupied sublattice) has no single species per site, which potentials, polyhedra and MD need. **Build Random Samples** makes that many ordered decorations of a supercell (**Size**) that keep the composition; **Use Majority** puts the most occupied species on every site instead (fast, but it changes the composition). **Compare Energy** computes every sample's energy with the potential chosen in the Atomistic window, which the section names, and ranks them lowest first; **Use Shown** keeps the sample in the 3D view, **Keep All** keeps them all as frames of a trajectory.

⚠ The ranking is only as good as the potential: energy differences between decorations are small, often within its error. Check the low-energy candidates against DFT before relying on them.

