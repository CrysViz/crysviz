# Field List — ELFCAR

An ELFCAR holds the **electron localization function** (ELF) on the same grid layout as a CHGCAR.

## What the entries are

- **ELF** – The primary ELF contained in the file for a non-spin-polarized calculation.
- **ELF-up** and **ELF-down** – a spin-polarised run (`ISPIN = 2`) writes one localization function
  per spin channel.


## Reading ELF values

ELF is dimensionless and bounded between 0 and 1 — unlike a charge density it is *not* scaled by
the cell volume, so its values mean the same thing in every file:

- **1.0** – perfect localization: a covalent bond pair, a lone pair, a closed shell.
- **0.5** – the value of a homogeneous electron gas, the reference metallic-like case.
- **0** – regions where finding a second same-spin electron is essentially certain not to happen.