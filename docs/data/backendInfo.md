#  Backend


It is possible to choose three different modes in CrysViz. These give mostly access to the same functionalities with some differences:

- **Viz**: Purely visualisation. Supercells can be created and downloaded in POSCAR format. 

- **Symmetry**: Symmetry analysis using the WASM module of the [MOYO package](https://github.com/spglib/moyo) (from the developers of spglib). So far it is possible to perform symmetry analysis, and symmetrization to conventional and primitive unit cells. This is running in your browser. No data is send. 

- **NEP**: Loads a WASM module based on the [NEP-CPU](https://github.com/brucefan1983/NEP_CPU) which allows loading neuroevolution potentials (NEPs). Using WASM this means that the calculation runs on YOUR device. No data is sent to a backend for this calculation. It allows currently the calculation of energy, forces and stress. A relaxed and MD enginge will be added in the future. 

- **AI**: This mode allows to connect to a machine-learned interatomic potential backend. Which runs NOT in your browser but on either your own (github release soon) or our backend server. You can get energy, forces and the stress tensor for you strucuture and relax the structures by either adding a trajectory to your structure or creating a new trajectory. These can then be viewed with the trajectory player. If you start your own local server on the computer from which you visit the website, no data is leaving your system.  

Click the **i** button in the storage selection panel for more information on when data is sent to a backend server. 
