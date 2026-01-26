
<img src="docs/CrysViz_logo_clear_back.png" width="400">

# Light-weight browser-based crystal structure visualisation with on-device rendering.

## This is the live developement repository. If you are not Abhijith, Florian, or Rickard, you should not be here!

### Current Features:

- Fully running in browser with mobile device and touch support
- Automatic periodice boundary conditions
- Automatic visualisation of bonds with customisable maximum bond length values
- Inter-atomic distance measuring
- Angle measurements
- Periodic images outside the Unitcell
- Ability to remove atoms
- read POSCAR, CIFS and load from Optimade Structure URLS
- user colors for  individual atoms
- switch for parallel vs. perspective view
- on-the-fly position and lattice chagnes
- Spins! per atom, indivudual colors, scaling, etc.
- Automatic dark/light mode
- on-the-fly custom background color

### Known Bugs & Problems
- zooming out on the website (ctrl + - )and the zooming the atoms crashes the atom view
- in the vesta-like colors a lot of elements are pink... colors need to be chosen somehow
- when a bond is measured and some color or position is changed, the measured bond switches to the periodic images
- - on bond lenght zero, even though it says now "disabled", bonds are still shown

### Features We Could Add

1. Minimum bond length slider. Could be useful to identify ranges of bonds.
3. Show the metainfo line from poscar file
5. Possibility to deselect single measurements by clicking them again
6. some comment under the upload stating that "No data leaves your device". Is this really true?


### Possible Advanced Features

1. On-the-fly symmetry information and potentially symmetrisation
2. Package as stand-alone offline application
4. Crystal Structure Comparison:
   - Mode (1): Compare structures by overlay. Option to load two structures that differ by a shade in color and a visualised on top of each other.
   - Mode (2): Load two structures side by side. both can rotate on their own, but there is a button to lock them in the current state and then all roation is synced unless the button is pushed again
