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

Regions are non-destructive: their opacity is combined with existing atom
opacity without changing it. Overlapping regions keep the most visible result.
Bond, force, and spin visibility follows the same region.
Use **Exclude selection** to keep additional atoms unchanged. Every focus atom
is preserved globally, so adding another region never dims an earlier focus.
