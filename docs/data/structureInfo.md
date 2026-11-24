# Structure

Shows the chemical formula of the currently loaded structure. Click it to open the composition
breakdown, with **Atoms**, **Bonds** and **Polyhedra** tabs (plus **Wyckoff** when symmetry is
active) listing every species/category with its own color, opacity, size and position editors.
The **Polyhedra** tab groups the categories by centre element (**Ca**, **Ti**, and **Cages**): the
element's row shows, hides, recolours or changes the alpha of all of its categories (CaO7, CaO8, …)
at once, including categories that only appear on later trajectory frames, and its caret opens the
categories beneath it. A category's own switch, colour or alpha overrides its element's (to show one
category of a hidden element, switch that category on; the element's switch then reads half-way).

The buttons beside the box's title: **✎** opens Modify Structure, **❖** puts a colour legend of the
composition on the view (for figures), and **Aₓ** shows **atom labels**: each atom's name, as its
row in the Atoms tab names it (`Fe1`, `O3`, a mixed site `(Fe,Ni)2`), written on the atom in the 3D
view and in the Selection and Polyhedron Inspectors. With a Wyckoff lock active every atom of an
orbit carries the orbit's name from the Wyckoff tab (`N6 4e`). Press it again to hide them (it
looks pressed while they are shown); the inspectors have the same button in their top-right
corner. **Aˣ⁺** beside it shows the **charges** (oxidation states) the file gives, as badges next to
the atoms, in the view and the inspectors — the same switch as **Features ▸ Show Charges**; it is
greyed out for a structure without charges. A label hidden behind another atom, or overlapping a nearer label, is left
out until the view turns. In the 3D view the labels keep one size on screen at any zoom; **Settings
▸ Atom labels** sizes the names (**Names**) and the charge badges (**Charges**) in the 3D view (the
inspectors have their own **Size** sliders).
Structures of more than 1000 atoms get no labels in the 3D view.

**Long lists.** A species, bond pair or polyhedron category with more than 1,000 entries lists them
100 at a time: use ◀ ▶ to page, or type a number into **#** to jump to the page that holds it.
Picking an atom, bond or polyhedron in the 3D view opens its list on the page that holds its row.
