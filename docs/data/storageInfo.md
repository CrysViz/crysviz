# Storage Information

There are three planned options for which information is stored on **YOUR device**. Switching between them is not available yet: CrysViz currently always uses **Minimal**.

- **None** (not yet available): Default settings are restored on reload, structures are not saved. As if you have never been here

- **Minimal** (default, currently always on): For each structure you work with, CrysViz remembers the settings below in this browser. They come back when you load the same file again, also after closing the browser. The structures themselves are not stored. **Clear local data** in the Settings window removes all of it, together with your window layout, theme and custom settings.
  - atom colours
  - atom and bond sizes
  - bond lengths you changed
  - focus regions
  - the isosurface value, colour and opacity of a volumetric field
  - crystal planes, including the field and colour map shown on them
  - spin and force arrow settings (length, size, colours and colour map)
  - the supercell
  - the cell boundary

- **Structure** (not yet available): The structures you are working with are stored in the browser tmp storage on your device. Reload will preserved all settings and loaded structures. This has limitations depending on the browser and device. Usually 50MB. Using the purge button you can delete all stored information 
**Important:** No data is leaving your device unless you connnect to the backend server hosted by the Theoretical Physics Division at Linköping University. If you do so we can at this point not guarantee that filenames or information about your structure are not saved on our server in log files. However, these log files are only used for performance analysis and error tracking, and will be periodically deleted. 


Contact *Florian Trybel (florian.trybel@liu.se)* if you need any more information. 
