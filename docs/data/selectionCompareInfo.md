# Compare

**Compare** shows, for every bond length and angle of the selection, its value in a second
structure too — two versions of the same structure side by side: experiment and DFT, before and
after a relaxation, two steps of a trajectory file.

1. Select the atoms in the structure you want to inspect.
2. In the **Files** list, tick the checkbox of the one structure to compare with. Compare is
   greyed out until exactly one other structure is ticked. For a trajectory, its row's **Step**
   is the frame compared with.
3. Press **Compare** (press it again to stop). It does not need the Comparison window.

Each label then shows the inspected structure's value first and the compared one second, in a
second colour (red by default), e.g. `1.386 1.389 Å`.

## When two structures are compared

Only when they are the same structure closely enough:

- the same number of atoms of each element;
- cells within 15 % in every length and 10° in every angle;
- every atom matched one to one: by file order when both list the elements in the same order, or
  otherwise by the nearest atom of the same element after the best rigid shift (a different
  origin); positions are compared in fractional coordinates, so a relaxed cell still matches;
- every atom within 40 % of the shortest interatomic distance of its partner (at most 1 Å), once
  that shift is removed.

The line under the controls says which structure is compared and how closely they match (RMS and
largest displacement, the limit, and the cell change), or why they are not compared — for
example which atom moved too far. A bond across a cell face is measured across the same face in
both structures.

## Legend and colours

The **legend** in the view's corner is a label of its own: the two names on one pill, in the two
value colours, read like every label — the inspected structure first. Click a name to edit it.
**Values** and **Compared** in the Colours row set the two colours; the pill takes the length
labels' background. Drag its **⦀** grip (or the pill's edge) to move it anywhere in the view.

**Export image…** saves the view with the legend, as on screen.
