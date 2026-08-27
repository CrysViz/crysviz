# Field List

Every entry in this list is one 3D grid that can be drawn as an isosurface. Exactly one is active
at a time — the radio button picks which field the isosurface, the cut planes and the tracers all
read.

What the entries are depends on the file the panel was opened from, and this list adapts to it:

- **Cube files** (`.cube`) hold a single grid, labelled from the two comment lines at the top of
  the file — so whatever the code that wrote it called the data is what you see here.
- **CHGCAR / ELFCAR** files list one entry per data block, all parsed up front.
- **WAVECAR** files list bands grouped by spin and k-point, each loaded on demand.

Open this button again with one of those files loaded and you get the notes specific to it.

## Isosurface settings

- Data that is positive everywhere (a charge density, ELF, |ψ|²) is easiest to work with when
  **Absolute Isosurface Values** is on, so the slider sweeps 0 → max.
- Data that straddles zero (a molecular orbital in a cube file, a spin density, a difference of two
  fields) should have it off: the slider then runs from the most negative value through zero to the
  most positive, and the two colours under **Color controls** show the sign of each lobe.
- **Logarithmic Slider Scale** helps whenever the values span orders of magnitude, which is the
  normal case for densities and rarely the case for anything bounded.

## Derived fields

Once two or more fields are loaded, a **Combine fields** section appears below the list. Fields you
build there are added under a **Derived** group and behave exactly like fields read from the file.
The section has its own info button explaining the weights.
