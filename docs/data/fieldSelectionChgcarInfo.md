# Field List — CHGCAR

Each entry represents the charge density as contained in the given CHGCAR

## What the entries are

- **Charge Density** – the first block, the total charge density.
- **Magnetization Density** – written by a collinear spin-polarised run (`ISPIN = 2`): the
  *difference* between the two spin channels, representing density of magnetization/spin.
- **Magnetization along σ₁**, **σ₂**, **σ₃** – a noncollinear run (`LNONCOLLINEAR = .TRUE.`) writes
  three magnetization blocks instead of one, one per Pauli matrix in the spin-quantization frame
  (the frame VASP's `SAXIS` defines), listed in file order.
- **Spin Up Density** and **Spin Down Density** – derived from collinear entries, representing the charge density of spin-up and spin-down electrons respectively.
- **Magnetization Magnitude** – derived from a noncollinear file's three blocks, |m| =
  √(m₁² + m₂² + m₃²). It is the entry that shows where the cell is magnetic at all.

## Values and isosurface settings

VASP writes a CHGCAR as the charge density *divided by the cell volume and grid volume (NGXF \* NGYF \* NGZF)*.
CrysViz reads and scales these values back, so that density values are in units of 1/Å³.
