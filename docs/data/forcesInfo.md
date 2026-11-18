# Forces

Visualizes per-atom force vectors as arrows, scaled by the slider in this window. Forces come
from an uploaded file that includes them (e.g. an OUTCAR) or from a Relax/MD run. Only one of
Forces, Spins or Field can be shown at a time.

## Arrow length and colour

An arrow's length is the force times **Global Scaling**: at 1, a force of 1 eV/Å draws 1 Å. The
slider is logarithmic, from 0.1 to 1000, so the small forces of a relaxed structure (0.01 eV/Å)
can be made visible (about 100). With **log length** on, the length is the log of the force
instead: the file's smallest force (over all steps) gets 0.3 Å and its largest 2 Å, times Global
Scaling. Either way the length depends only on the force — the same force has the same length on
every step.

The colour bar's range only sets the colours: changing Min/Max or pressing **Auto Range** never
changes a length, and forces below Min or above Max take the bar's first or last colour. When a
structure is opened, the bar gets its stored range, or else its **Auto Range** (the shown step's
forces, padded a little and rounded to readable limits; on a log scale to 1, 2 or 5 × 10ⁿ).

