# File Upload 


The most important information is that CrysViz is mainly a static html page using the resources from your computer. There is no backend unless you choose *AI mode*. This means that the structures you upload are stored in the temporary browser storage on **your computer**. Reloading the website will remove the data. Clearing browser history will make sure no data is left.

Currently it is possible to view the following file types: 

- **VASP**:
    - POSCAR: structure only.
    - OUTCAR: structure, forces, and spin for the complete trajectory of a MD or relaxation.

- **Quantum Espresso**:
    - Input file: structure only.
    - Output vc relax: structure forces, stress, spin for the complete trajectory.
    - Output relax: not implemented at the moment 
    - Output md: implemented but experimental

- **CIF**: CrysViz provides a CIF reader.

- **.xyz and .exzy format**: Currently under implementation

- **FHI-AIMS**: geometry.in files are under development. Output files will be readible in the future depending on demand. 
