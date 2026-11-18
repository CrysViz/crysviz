# Trajectory

Plays back a multi-frame structure (a relaxation, MD run, or an uploaded trajectory file such as
an OUTCAR or Quantum Espresso vc-relax output) frame by frame. Only shown when the selected file
has more than one frame.

During a relaxation or MD run, and for trajectories with energies, forces or stress, a plot below
the player shows each quantity (temperature, energy, mean force, pressure) in its own plot,
labelled with its unit and its minimum and maximum. The plots are stacked, or side by side when
the plot is wide and short (the side dock along the bottom, a landscape phone in full screen).
Click a plot to jump to that frame; ⛶ opens it full screen and 📥 saves it as a PNG.

**Memory.** A trajectory's frames stay in memory: 24 bytes per atom per frame for the positions,
as much again for forces. 100,000 atoms over 200 frames with forces take about 1 GB. Above the
**Trajectory memory** limit (Settings ▸ Memory, 2 GiB by default) a load asks what to load:

- every n-th frame, chosen so the frames fit;
- the first frames that fit;
- everything, and raise the limit to fit;
- everything this time, leaving the limit as it is.

For .xyz files the frames are counted from the start of the file before reading the rest, and a
reduced load reads only the frames it keeps. Other formats are trimmed right after reading.

On large structures (about 20,000 atoms and more) the player keeps the app responsive:

- Pausing, stepping and releasing the scrubber show the exact frame without rebuilding the whole
  scene. Dragging the scrubber moves the atoms and bonds in place.
- While such a trajectory plays, **Show Bonds**, **Show Periodic Images**, **Neighbour Bonds**
  and the polyhedra toggles are greyed out. Each one rebuilds every atom and bond, so pause first.
- When paused, these toggles take a few seconds at around 200,000 atoms. The progress strip at
  the top of the view runs while they work.
