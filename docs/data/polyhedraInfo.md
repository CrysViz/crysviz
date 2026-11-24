# Polyhedra

Draws coordination polyhedra (e.g. octahedra, tetrahedra) around chosen centre atoms, built from
their nearest bonded neighbours. Toggle per-category colour/opacity and completeness (whether a
polyhedron needs all its corner atoms present to be drawn). Still under active development.

**Colour by** paints every polyhedron by a number computed from its shape: **Bond-length
distortion** (Baur's distortion index), **Bond-angle variance**, **Quadratic elongation**,
**Volume**, **Tilt about a**, **b** or **c**, or **Total rotation**; **Style** keeps the category
colours. A colour bar shows the scale; it is fitted to the data when you choose a property — on a
trajectory over its frames (up to 25, evenly spaced) — (long press the bar for **Auto Range**, or
type the limits). During trajectory playback, relaxations and MD the colours follow every frame.
**Grey the rest** draws the polyhedra the property does not apply to in grey (off: their style
colour); **Edges** colours the edges grey, like the faces (**Property**) or as the style (**Style**). Tilts and the total rotation are measured against **Tilt axes**:
*Automatic* takes, for each polyhedron type, the mean orientation of its octahedra or tetrahedra —
the untilted pseudo-cubic axes in any cell setting, so neighbours tilting in opposite senses get
opposite colours; *Cell axes* uses a, b, c; *Matrix* takes two axes typed as rows in terms of a, b,
c, and the third is their cross product (always right-handed). Changing the axes, or editing the
matrix, fits the colour range again.

While frames play (a trajectory, a relaxation, an MD run) a polyhedron corner follows its bond: a
corner breaks off only once its bond is longer than the cutoff by the **Bond breaking tolerance**
(Polyhedra window, 10 % by default), and comes back within the cutoff, so a vibrating bond does not
make the polyhedron flicker. A polyhedron that keeps fewer than four corners is not drawn until
they return.
