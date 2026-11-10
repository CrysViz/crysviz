# Bonds

Bonds are computed automatically per element pair, using the min/max length range shown for each
pair. Drag the range slider to change which distances count as a bond; expand a pair to color,
resize or hide individual bonds. Under **Histograms**, open the bond-length or coordination-number
distribution as a floating window (**Panel**) or beside the 3D scene (**Split View**) — click a bar
to highlight the bonds or atoms it represents.

**Complete Rings & Fragments** (Features window) draws whole every bonded fragment — a dimer, a
molecule, a molecular ion — that a cell face cuts, using the bonds set here: every fragment with an
atom in the cell is drawn complete, so one that sits on a face appears on both sides. A layer or
framework has no finite fragments, so there it closes the rings of up to six atoms that cross the
boundary instead. While it is on, two settings appear at the bottom of this tab: **Ignore bonds to
metals** (on by default) keeps metal–ligand bonds from joining carbonates, sulfates or MOF linkers
into one endless network, and **Close rings in networks up to** sets the largest ring to close
(off, or 3 to 8 atoms).
