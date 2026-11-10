#  Functions 

There is a growing zoo of features implemented in CrysViz. These are in particular following the needs of the Theoretical Physics Division at LiU. More features can be added on-the-fly.


Click one of the buttons below to open the panel with the respective feature. There are three difference categories:
- **Trajectory|Comparison**: Trajectory opens a classic trajectory player that allows you to watch the uploaded trajectory from (currently) a OUTCAR or Quantum Espresso output file. Trajectories can be from molecular dynamics simulations or structural relaxations. For QE currently only *vc-relax* and not *relax* is supported (update is under development). 


- **Force|Spin|Field**: These are exclusive,*i.e* only one can be visualised. Choose either forces, spin or 3D-fields (charge densities and ELFs from cube files or VASP output). Currently experimental. Info: High memory consumption for high resolution files!


- **Bonds|Lattice|Polyhedra**: This section allows to view histograms for bonds (currently lengths, future: angles, coordiation number; an option to draw extra bonds is comming soon) and to modify the lattice on the fly and create supercells. Polyhedra option is currently under developement and will be active soon!

## Show CIF Errors

For a structure read from a CIF together with its errors (the standard uncertainties the file
gives in parentheses; you are asked when the CIF is loaded), measured lengths and angles are
written with their error: `2.3456(12) Å` in the measurement labels and in the Selection and
Polyhedron Inspectors, including the values they derive (mean bond length; polyhedron volume,
distortion index and angle variance). **Show CIF Errors** switches that off (plain values) and on
again; nothing is lost either way. It does nothing for structures loaded without errors. The
Bonds tab, the histograms, the atom tooltip and the Files window's Parameters show plain values.
