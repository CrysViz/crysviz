# Polyhedron Inspector

Click a polyhedron (or its centre atom) in the 3D view to inspect it here: its category, its
**volume** (Å³, the convex hull of the vertex atoms), bond-length distortion index (BLD — mean
deviation of the centre-to-vertex distances from their average, as a fraction of the average),
and bond-angle variance (Robinson et al. 1971 — only defined for CN4 tetrahedra and CN6
octahedra).

The mini 3D view below shows just that one polyhedron, with every bond length and (non-trans)
angle labelled directly on the geometry — drag to rotate, scroll to zoom.

- **Angles** toggle (top): show or hide the bond-angle arcs and labels. Angle arcs are drawn for
  every coordination number (the adjacent vertex pairs — the polyhedron's own edges), not only
  CN4/CN6; the *angle-variance number* above is still CN4/CN6 only.
- **Double-click** the polyhedron to highlight the same one back in the main structure view
  (without opening the Structure Info panel).

Also available in the split view beside the 3D scene (see the "Split View" button next to this
one in the Polyhedra panel).
