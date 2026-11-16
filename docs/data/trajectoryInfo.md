# Trajectory

Plays back a multi-frame structure (a relaxation, MD run, or an uploaded trajectory file such as
an OUTCAR or Quantum Espresso vc-relax output) frame by frame. Only shown when the selected file
has more than one frame.

During a relaxation or MD run, and for trajectories with energies, forces or stress, a plot below
the player shows each quantity (temperature, energy, mean force, pressure) in its own plot,
labelled with its unit and its minimum and maximum. The plots are stacked, or side by side when
the plot is wide and short (the side dock along the bottom, a landscape phone in full screen).
Click a plot to jump to that frame; ⛶ opens it full screen and 📥 saves it as a PNG.
