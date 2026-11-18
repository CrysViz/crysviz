# Visual

All appearance settings that aren't specific to one feature: atom/bond sizes, the unit cell and
axes, background, rendering pipeline and color mode, and the camera (perspective/parallel,
damping, auto-rotation). Feature-specific visuals (bonds, field, polyhedra, ...) live in their
own windows.

**Atom detail** chooses how atoms are drawn. *Spheres* are tessellated instanced spheres, the
classic look. *Imposters* draw one flat quad per atom and ray-cast the sphere per pixel: exact
at every zoom, a fraction of the geometry work, so structures of tens of thousands of atoms stay
interactive. Atoms that are large on screen are still drawn as real spheres (with hull outlines
and disorder wedges); zoom in and only what is in view and close pays for geometry. *Auto*
(default) uses spheres for small structures and imposters from about 20 000 drawn atoms up.
Imposters skip the cel *3D hull* outline and disorder wedges on the small far atoms.

**Ground plane** puts a floor disc under the structure (patterned, coloured, with a distance and
size), which catches the shadows in ray and path tracing and is drawn in the other modes too.
**Ground position** chooses its side: *Below (−y)* (the default), *Below the view* (always under
the picture, whatever the rotation; the light follows the view too, so the shadows always fall the
same way), *Behind the view* (a backdrop facing the camera, e.g. for a view straight down an axis),
a fixed world side (*Above*, *Side ±x*, *Side ±z*) or a crystal side (*Under/Over a, b or c*,
parallel to the plane of the other two lattice vectors). Share links and `.crysviz` sessions keep it.
