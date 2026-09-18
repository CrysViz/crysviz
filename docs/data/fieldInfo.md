# Volumetric Field

Renders an isosurface of a 3D scalar field (charge density, ELF, or wavefunction/partial density)
loaded from a cube file, VASP CHGCAR or VASP WAVECAR.

1. Pick the field. If loading WAVECARs, first load the specific band (under desired spin and k-point) into memory
2. Choose isosurface value — drag the slider, or type an exact level (plain or exponential, e.g. 2.5e-3) into the box beside it and press Enter. Toggle logarithmic slider scale for more fine control.
3. Customize positive/negative colors for the surface visualization here.

Experimental — high-resolution files can use a lot of memory.
