# File Upload 


The most inportant information is that CrysViz is mainly a static html page using the resources from you computer. There is no backend unless you choose AI mode. This means that the structures you upload are stored in the temporary browser storage on **your computer**. 


Currently it is possible to view the following file types: 

- **VASP**:
    - POSCAR: structure only.
    - OUTCAR: structure, forces, stress, spin for the complete trajectory of a MD or relaxation.

- **Quantum Espresso**:
    - Input file: structure only.
    - Output vc relax: structure forces, stress, spin for the complete trajectory.
    - Output relax: not implemented at the moment 
    - Output md: implemented but experimental

- **CIF**: CrysViz provides a CIF reader which currently is not able to handle all intricacies of the CIF format. It works in many cases. The more advanced CIF reader from the HTTK package will be adapted as soon as possible.  
- **.xyz and .exzy format**: Currently under implementation
- **FHI-AIMS**: geometry.in files are under development. Output files will be readible in the future depending on demand. 
