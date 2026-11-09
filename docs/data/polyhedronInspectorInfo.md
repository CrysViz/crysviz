# Polyhedron Inspector

Click a polyhedron (or its centre atom) in the 3D view to inspect it here: its category, its
**volume** (Å³, the convex hull of the vertex atoms), bond-length distortion index (BLD — mean
deviation of the centre-to-vertex distances from their average, as a fraction of the average),
and bond-angle variance (Robinson et al. 1971 — only defined for CN4 tetrahedra and CN6
octahedra).

The mini 3D view below shows just that one polyhedron, with every bond length and (non-trans)
angle labelled directly on the geometry — drag to rotate, scroll to zoom.

- **Lengths** and **Angles** (top): show or hide every bond-length or angle label at once. Angle
  arcs are drawn for every coordination number (the adjacent vertex pairs — the polyhedron's own
  edges), not only CN4/CN6; the *angle-variance number* above is still CN4/CN6 only.
- **Point at a label** (tap it, on touch) and press the small **×** beside it to hide just that
  one, as on the measurement labels; **Show all labels** brings them all back.
- **Move labels**: drag labels clear of each other. While it is on the view does not turn; a moved
  label keeps a thin line back to its bond or arc, and a **↺** on its left that puts just that one
  back; the **×** stays on the right. Press Move labels again to rotate; **Reset positions** puts
  every label back.
- **Errors from a CIF**: for a CIF loaded with its errors (standard uncertainties), each length
  and angle label shows its error in parentheses, `2.093(3) Å`, and so do the volume, the
  distortion index and the angle variance in the summary — each propagated through the same
  calculation that gives the number. **Show CIF Errors** in the Features window hides them.
- **Double-click** the polyhedron to highlight the same one back in the main structure view
  (without opening the Structure Info panel).

To look at any group of atoms instead — not one coordination polyhedron — select them and use the
**Selection Inspector** (Inspect on the Structure window's selection bar).

Show Polyhedra and Complete Polyhedra are turned on and locked while this inspector is open.
