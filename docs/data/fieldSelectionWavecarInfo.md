# Field List — WAVECAR

Each entry is one **band**, grouped by spin and k-point. A spin-polarised file shows **Spin up** /
**Spin down** at the top level; a file with a single spin channel skips that level and starts at the
k-points, each labelled with its fractional coordinates. Click a group header to expand it — the
rows underneath are built only when you open the group, because a file with hundreds of k-points
and hundreds of bands would otherwise put tens of thousands of rows on the page.

Unlike a CHGCAR or a cube file, **nothing is loaded when the file is opened**. A WAVECAR stores
plane-wave coefficients, not a grid: turning one band into something that can be drawn means an
inverse FFT onto the real-space mesh, and doing that for every band up front is neither fast nor
possible in memory. So each band row starts dimmed with a **Load** button, and only the bands you
load become real fields.

## Reading a band row

- The band's **eigenvalue** (in eV) and **occupation** are shown to the right of its label, so you
  can find the states you care about — the highest occupied band, an empty state above the gap —
  without leaving the panel.
- **Load** expands that band into a grid. It runs in the background; the row shows *Loading…* while
  it does, and any failure (a truncated file, a grid too large to allocate) is reported under the
  list rather than only in the console.
- Once loaded, the row's radio button becomes selectable and the band behaves exactly like a field
  from any other file.

## Quantity

The **Quantity** dropdown at the top chooses what is computed from the coefficients:

- **|ψ|² (density)** – the probability density. Always positive, so turn **Absolute Isosurface
  Values** on for it.
- **signed |ψ| (lobes)** – the magnitude carrying the sign of the wavefunction, which is what you
  want to see an orbital's positive and negative lobes.
- **Re ψ** and **Im ψ** – the raw real and imaginary parts.

Changing the quantity re-points every row at a different grid, so bands you had already loaded show
up as unloaded again until you expand them in the new quantity. That is honest rather than
annoying: |ψ|² and Re ψ are different data, not two views of one grid.

## Filtering and memory

**Filter bands…** narrows the tree by label and opens the groups that hold the matches;
**Loaded only** hides everything that has not been expanded yet, which is the quickest way back to
the handful of bands you are working with.

Expanded bands are kept in a size-limited cache (about 1 GB by default). When it fills, the least
recently used bands are dropped and their rows flip back to **Load** — reloading them just re-runs
the transform. The band currently being drawn is pinned and is never dropped out from under the
isosurface.

Only loaded bands appear in the field dropdowns elsewhere in the app (the cut-plane panel, for
example). An unloaded band has no values to sample, so offering it there would be offering nothing.
