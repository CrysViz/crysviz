# Focus Regions

Focus Regions make a selected atom, molecule, or defect easier to inspect in a
large structure. Select atoms in the scene or Structure panel and choose **Add
from selection**.

When the inner region is active, its center is shown in fractional coordinates.
Edit those values for fine positioning, or use **Reset** to return to the
selection centroid. The adjustment follows that centroid when atoms move.

Atoms in the inner sphere retain local structural context. Everything outside
it uses the outer opacity. Disable the inner region when the selected group
itself is the object of interest.

Regions repeat with the lattice: distances are measured to the nearest
periodic image of the center, so widening the active cell boundary shows the
same focus around every periodic copy of the selected atoms.

Regions are remembered per structure: open the same file again after a
browser reload and they come back (see the Settings window's "Clear local
data" to forget them).

Regions are non-destructive: their opacity is combined with existing atom
opacity without changing it. Overlapping regions keep the most visible result.
Bonds, hydrogen bonds, forces, spins, charge badges, polyhedra, and the
volumetric field follow the same region. The field keeps its Field panel
opacity as the maximum and fades per vertex where the surrounding atoms fade.

**Radial gradient**, on by default, softens the edge of the inner sphere from
within: the outer share of the inner radius ramps linearly from the inner
opacity down to the outer opacity, reaching it exactly at the inner radius.
The slider sets that share, from 0% (a hard edge) to 100% (a ramp from the
center). It only applies while the inner region is on. **Polyhedra opacity** chooses whether a polyhedron takes the
average of its atoms' focus opacity or the rule evaluated at its own centroid.
Every atom follows the rule, including the atoms the region was created
from. Use **Exclude selection** to keep chosen atoms unchanged; the exclusion
list is the only exemption.

**Select inner atoms** replaces the current selection with atoms inside the
sphere plus all exceptions. The Structure panel can then show and copy their
fractional and Cartesian coordinates from its **Coordinates** action.
