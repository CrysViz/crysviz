# EOS Fitting

Fits an equation of state (energy vs. volume) to a series of structures — typically the same
cell scaled to several volumes and relaxed. Load a P/E/V data file in this window; the fit plots
open automatically in a separate EOS Fit window in the wide dock on the right of the 3D scene.
Like any window, the plots can be dragged out to float or into the left bar.

## Compute from potential

Instead of loading data, **Compute from potential** makes the points: it relaxes the current structure (positions and cell) at **Points** pressures evenly spaced from **P min** to **P max**, with the potential chosen in the Atomistic window, and fits them. Each point's structure is kept as a frame of a new trajectory row, so a click on a plot point shows it.

The section names the potential it runs with. ⚠ Machine-learned potentials come with their own errors: check the volumes, bulk modulus and phase order that matter against DFT before using them in production runs. **For pressures above 5 GPa, PET-MAD models are recommended** over NEP: the section warns when P max reaches 5 GPa with NEP (the default P max is 20 GPa).

