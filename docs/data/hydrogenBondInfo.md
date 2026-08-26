# Hydrogen bonds

A hydrogen bond is a **D–H···A** contact: a hydrogen covalently bonded to an electronegative *donor* (D) sits close to a second electronegative *acceptor* (A). This second slider draws those contacts as dashed lines for the selected pair (e.g. O–H, N–H, F–H).

Eligible elements — as donor or acceptor — are **N, O, F, Cl, S, Br, I**.

## What controls whether a line is drawn

- **Distance**: the H···A separation must fall inside this slider's range (default **1.5–2.6 Å**). Below it lies the covalent X–H bond; above it the interaction is too weak to show.
- **Angle**: the **D–H···A angle** must be at least **120°**. Each hydrogen is assigned a single covalent donor (its nearest electronegative neighbour), and only acceptors lying roughly *opposite* that bond qualify.

## Why the angle criterion matters

A real hydrogen bond is close to **linear** (D–H···A ≈ 180°) — that near-linear geometry is what distinguishes a genuine hydrogen bond from an atom that merely happens to be nearby. Requiring the angle to exceed 120° enforces this, and it is why a symmetric or interstitial hydrogen sitting in a cage of equidistant acceptors will show only the contact(s) that are actually directional, not one line to every neighbour within range.

The 120° threshold is a deliberate, physically motivated default. It is a shared setting (`general.hydrogenBondMinAngle`) that governs every pair.
