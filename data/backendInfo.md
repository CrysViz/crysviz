#  Backend


It is possible to choose four different modes in CrysViz. These give mostly access to the same functionalities with some differences:

- **Viz**: Purely visualisation. Supercells can be created and downloaded in POSCAR format. 

- **Symmetry**: Symmetry analysis using the WASM module of the [MOYO package](https://github.com/spglib/moyo) (from the developers of spglib). So far it is possible to perform symmetry analysis, and symmetrization to conventional and primitive unit cells. This is running in your browser. No data is send. 

- **Relax**: Structure relaxation tools. You can choose the built-in **NEP** potential, which runs directly in your browser, or **ASE**, which requires a backend server connection.

- **MD**: Molecular dynamics tools. The current in-browser workflow is based on the built-in **NEP** potential. The **ASE** option still requires a backend server and is not fully wired for MD yet in this UI.

Click the **i** button in the storage selection panel for more information on when data is sent to a backend server. 
