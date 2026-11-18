# Atomistic

Energies, forces, relaxations and molecular dynamics with interatomic potentials. Pick a **potential** (NEP, PET-MAD or ASE), then:

- **Relax**: **EFS** computes the energy, forces and stress of the current structure; **Relax** optimises positions and cell towards a target pressure until forces and stress fall below their tolerances (**Stop** ends it after the current step and keeps the steps so far); **Rattle** displaces atoms at random (and optionally strains the cell) to leave a saddle point or test stability.
- **MD**: molecular dynamics at constant temperature (**NVT**) or temperature and pressure (**NPT**), with an optional annealing schedule. The run is recorded as a trajectory and plotted live.

The **EOS** (Compute from potential), **Order Structure** (Compare Energy) and **phonon mode map** windows compute with the potential chosen here; each says which one it uses.

## ⚠ Check before you trust

All potentials here are machine-learned approximations to DFT (xTB on an ASE server is semi-empirical). **They come with their own errors**, which grow for structures unlike their training data: unusual compositions or coordinations, high pressures or temperatures, defects, surfaces, molecules. Use them to explore, screen and pre-relax. **Check the results that matter (energies, lattice parameters, phase order, barriers, phonons) against DFT before using them in production runs or publications.** The warning saying so in this and the other windows that compute with a potential folds to a small orange **⚠** with its **Collapse** button; click the ⚠ to show it again (Settings ▸ Warnings ▸ **Collapse potential accuracy warning** does the same). The NEP high-pressure warning below always shows in full.

**NEP at high pressure.** NEP89 is not reliable at high pressure. CrysViz warns when NEP is used with a target or computed pressure of 5 GPa or more, and for EOS scans that reach it: for pressures above 5 GPa, PET-MAD models are recommended (and their results need checking against DFT too).

Different models are fitted to different DFT data (PBE, PBEsol, r2SCAN, …) with different energy references: compare energies only within one model.

## The potentials

### NEP (in your browser)

**NEP89**, a general-purpose neuroevolution potential (NEP, from the GPUMD project) covering 89 elements. It is small and fast: up to 15,000 atoms, and the quickest choice for MD on large cells. Of the three it is the least accurate. Nothing leaves your computer.

### PET-MAD (in your browser)

**PET-MAD**, a Point Edge Transformer trained on the MAD dataset (PBEsol, 85 elements), run by mlip.cpp compiled to WebAssembly. Up to 1,000 atoms; nothing leaves your computer.

- **model**: **xs** (17 MB) is fast; **s** (100 MB) is more accurate and slower. **from a link…** adds other PET models: a link to a `.gguf` file, or to a catalogue (a list of models someone hosts, such as PET-MAD-XS models fine-tuned for particular materials), shown with what each was trained for, its DFT reference and how to cite it. **local .gguf** loads a file from your computer. Models download once and are then cached by your browser.
- A fine-tuned model still runs for elements outside its training set; the status line says when the structure has such elements, since results for them are extrapolation.
- **backend**: **cpu**, **webgpu** (the graphics card; fastest in most browsers) or **auto**. **multi-threaded** lets the cpu backend use several cores. Switching it reloads the page, which loses loaded structures, calculations still running and results not downloaded, so CrysViz asks first; **threads** sets how many: **auto** times all cores, one and half on the first evaluation of each system size and keeps the fastest; a number leaves cores free for other work.

### ASE (on your machine)

A server you run yourself, `python backend/server.py` from the CrysViz repository, computes with full models on your CPU or GPU, without the in-browser size limits. Pick **ASE**, check the **server** address and press **Connect**; a server started with several models (`--model A --model B`) shows a **model** menu. `python backend/server.py --list` shows what it can run (details in `backend/README.md`):

- **MACE**: MACE-MPA-0 (the default, shipped with CrysViz), MACE-MP-0, MACE-OMAT, MACE-MATPES; MACE-OFF for organic molecules.
- **PET**: PET-MAD and the other uPET models (PET-OMat, PET-OAM, …), and fine-tuned PET checkpoints.
- **Orb**, **SevenNet**, **MatterSim**, **CHGNet**, **UMA** (FAIRChem), **GRACE**: other universal potentials; **NequIP / Allegro** models you trained.
- **GFN2-xTB**: semi-empirical tight binding, a quantum-mechanical baseline (slower).
- **+d3**: Grimme's D3 dispersion added to any of them. Most universal potentials are fitted to PBE-type energies that miss van der Waals attraction; layered and molecular crystals need it.
- Any other ASE calculator.

The structures you compute are sent to that server, and only there.

## Size limits

The in-browser potentials run as WebAssembly with a fixed memory ceiling, so they refuse structures above a size they cannot evaluate: **NEP** up to 15,000 atoms, **PET-MAD** up to 1,000 atoms. Larger cells can still be built, viewed and played back; for energies, relaxation or MD on them, use a smaller cell or an ASE server.

Click the **i** button in the storage selection panel for more on when data is sent to a server.
