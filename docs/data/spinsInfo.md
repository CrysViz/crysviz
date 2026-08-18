# Spins

Visualizes per-atom magnetic moment vectors as arrows, scaled by the slider in this window. Spin
data comes from an uploaded file that includes it. Only one of Forces, Spins or Field can be
shown at a time.

The **Spin Reference Frame** and **Visual Rotation** controls live in collapsible sections
(collapsed by default) since they're only occasionally needed — click a header to expand it.

## Spin Reference Frame

A magnetic moment is a Cartesian vector, but codes don't always report its components in the global
Cartesian frame. Some report the on-site magnetization in the frame whose z-axis is the
**spin-quantization axis** (in VASP this is the `SAXIS` tag, default `0 0 1`), so a non-default axis
means the printed `(mx, my, mz)` are *not* global x/y/z. The reader detects this axis from the file
and rotates the moments into global Cartesian automatically, and collinear moments are placed along
the quantization axis (z) rather than x.

**Quantum ESPRESSO** has no single global quantization axis. In LSDA (`nspin = 2`) the magnetization
is along z, so collinear moments are placed on z. In the noncollinear case (`nspin = 4`) the moment
of each site is a generic Cartesian vector, printed directly by pw.x when `report` is set — the
reader uses those vectors as-is. The per-type `angle1` / `angle2` inputs only set the *initial*
direction and are not applied on read. Tip: for a noncollinear run, set `report` (e.g. `-1`) in
`&system` so the per-site magnetization vectors are printed; otherwise only the scalar magnitude is
available and the direction can't be recovered.

The **Spin Reference Frame** dropdown lets you override how the raw components are interpreted:

- **Quantization axis from file** – re-project from the axis the file was written with (the default;
  the detected value is shown beneath the dropdown).
- **Cartesian (raw x y z)** – treat the components as already global Cartesian.
- **Crystal axes (a b c)** – interpret the components along the crystal axes.
- **Custom quantization axis…** – enter your own axis in Cartesian coordinates (e.g. `0 0 1`) and
  press Apply.

## Visual Rotation

For collinear or non-spin-orbit data the absolute spin direction is arbitrary. The **Visual
Rotation** section has three angle fields (**X**, **Y**, **Z**, in degrees) that rotate every
arrow together about the Cartesian axes. This is purely decorative and does not change the
underlying moment magnitudes. Press **Reset** to return to 0°.
