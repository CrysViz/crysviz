# Field List — WAVECAR

Each entry is the orbital for a single **band**, grouped by spin and k-points.
A spin-polarised file shows **Spin up** /
**Spin down** at the top level.
Each k-point is labelled with its fractional coordinates.
In a non-collinear file a band is not one orbital but a spinor, so the band itself becomes a group —
see **Non-collinear files** below.

**Nothing is loaded when the file is opened**. A WAVECAR stores
plane-wave coefficients, and is normally too large to load into memory all at once. So each band to visualize needs to be **Loaded**.

## Reading a band row

- The band's **eigenvalue** (in eV) and **occupation** are shown to the right of its label.
- **Load** expands that band into a grid.
- Once loaded, the row's radio button becomes selectable and the band behaves exactly like a field from any other file.

## Quantity

The **Quantity** dropdown at the top chooses what is computed from the WAVECAR coefficients:

- **|ψ|² (density)** – the probability density in units of 1/Å³.
- **signed |ψ| (lobes)** – the magnitude carrying the sign of the real part of the wavefunction.
- **Re ψ** and **Im ψ** – the raw real and imaginary parts.

These are also used as categories for field selection. The field selection and combination is specific for **one** quantity.

## Non-collinear files

A non-collinear (`LNONCOLLINEAR`) run stores a **two-component spinor** per band rather than a single
wavefunction, and reports one spin channel while writing twice as many plane-wave coefficients.
CrysViz detects that and gives such a band its own group, holding:

- **ψ↑** and **ψ↓** – the two components as the file stores them, each a wavefunction in its own
  right that the Quantity dropdown applies to as usual.
- **ρ↑↑**, **ρ↑↓** and **ρ↓↓** – the elements of that band's contribution to the density matrix,
  ρ_ab = ψ_a\* ψ_b. The diagonal is the density each component carries, and the off-diagonal is the
  transverse part: its real and imaginary parts are the in-plane magnetisation
  (m_x = 2 Re ρ↑↓, m_y = −2 Im ρ↑↓), while m_z is ρ↑↑ − ρ↓↓.


The whole spinor is normalised together, so ρ↑↑ and ρ↓↓ integrate over the cell to the fraction of
the band held by each component and add up to one. 

## Filtering and memory

**Filter bands…** narrows the tree by label and opens the groups that hold the matches;
**Loaded only** hides everything that has not been loaded to memory yet.

Expanded bands are kept in a size-limited cache (about 1 GB by default). When it fills, the least
recently used bands are dropped and their rows flip back to **Load** — reloading them just re-runs
the transform. The band currently being drawn is pinned and is never dropped out from under the
isosurface.

Only loaded bands appear in the field dropdowns elsewhere in the app (the cut-plane panel, for
example).
