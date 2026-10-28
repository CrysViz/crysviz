// The search's vocabulary: what people call a feature when they don't know
// its name in CrysViz. Each concept maps the terms people know (scientific
// terms, other programs' names, file names, tasks) to a target the palette already lists — a panel by id, a control by
// its element id, or an app action by label — and the palette matches a query
// against each phrase AS A WHOLE, so "lattice vibrations" finds Phonons even
// though neither word is in "Phonons". Results matched this way say which
// phrase they matched ("≈ lattice vibrations").
//
// Single words that are simply other names for a panel can also go in that
// panel's `keywords` (ui/panels/defaultPanels.js); this table is for phrases,
// and for pointing straight at a control. Word forms (plurals, -ation/-ise/
// -ize, British/American spelling) are matched by search/fuzzy.js, so list
// each phrase once. A target missing from the palette is skipped at run time;
// the searchindex browser test fails on one (FeatureSearch.unresolvedConcepts),
// so a renamed control id or panel is caught here, not by users.

/** @type {{ to: { panel?: string, label?: string, control?: string, structure?: string, action?: string }, phrases: string[] }[]} */
export const CONCEPTS = [
  // ---- simulation (Atomistic) ---------------------------------------------------
  { to: { panel: 'backend' }, phrases: [
    'relaxation', 'structure relaxation', 'structural relaxation', 'ionic relaxation', 'atomic relaxation',
    'geometry optimisation', 'structure optimisation', 'optimise structure', 'energy minimisation', 'minimise energy',
    'relax cell', 'variable cell relaxation', 'vc-relax', 'fixed cell relaxation', 'full relaxation', 'relax lattice',
    'equilibrium structure', 'ground state structure', 'minimum energy structure', 'local minimum',
    'bfgs', 'lbfgs', 'fire optimiser', 'conjugate gradient',
    'molecular dynamics', 'md simulation', 'finite temperature', 'thermostat', 'barostat', 'nvt ensemble',
    'npt ensemble', 'canonical ensemble', 'isothermal isobaric', 'langevin', 'berendsen', 'nose hoover',
    'machine learning potential', 'machine learned force field', 'mlip', 'mlff', 'neural network potential',
    'universal potential', 'foundation model', 'interatomic potential', 'force field', 'neuroevolution potential',
    'pet-mad', 'ase calculator', 'atomic simulation environment', 'calculator', 'simulation',
  ] },
  { to: { control: 'relaxEfsCard' }, phrases: [
    'single point energy', 'energy and forces', 'compute energy', 'total energy', 'energy per atom',
    'compute forces', 'max force', 'stress tensor', 'efs',
  ] },
  { to: { control: 'relaxBtn' }, phrases: [
    'start relaxation', 'run relaxation', 'relax structure', 'optimise geometry', 'run optimisation', 'minimise structure',
  ] },
  { to: { control: 'relaxMaxStepsInput' }, phrases: ['maximum relaxation steps', 'max iterations', 'optimisation steps', 'nsw relaxation'] },
  { to: { control: 'relaxForceTolInput' }, phrases: ['force convergence', 'force tolerance', 'fmax', 'ediffg', 'convergence criterion'] },
  { to: { control: 'relaxTargetPressureInput' }, phrases: ['target pressure', 'external pressure', 'relax under pressure', 'hydrostatic pressure', 'pstress'] },
  { to: { control: 'relaxStressTolInput' }, phrases: ['stress convergence', 'stress tolerance'] },
  { to: { control: 'relaxRattleBtn' }, phrases: ['rattle atoms', 'perturb structure', 'random displacement', 'break symmetry', 'shake atoms'] },
  { to: { control: 'relaxRattleAmpInput' }, phrases: ['rattle amplitude', 'displacement amplitude'] },
  { to: { control: 'relaxRattleLatticePctInput' }, phrases: ['random strain', 'rattle lattice', 'perturb lattice'] },
  { to: { control: 'mdStartBtn' }, phrases: ['start md', 'run md', 'run molecular dynamics', 'start simulation', 'run simulation'] },
  { to: { control: 'mdStopBtn' }, phrases: ['stop md', 'stop simulation', 'abort md'] },
  { to: { control: 'mdStepsInput' }, phrases: ['number of md steps', 'simulation length', 'md steps'] },
  { to: { control: 'mdTimestepInput' }, phrases: ['time step', 'potim', 'integration step', 'femtoseconds'] },
  { to: { control: 'mdTemperatureInput' }, phrases: ['set temperature', 'md temperature', 'kelvin', 'tebeg'] },
  { to: { control: 'mdPressureInput' }, phrases: ['md pressure', 'npt pressure'] },
  { to: { control: 'mdSaveStrideInput' }, phrases: ['save frequency', 'output frequency', 'trajectory stride', 'sampling interval', 'write every'] },
  { to: { control: 'mdCouplingHeader' }, phrases: ['coupling time', 'thermostat coupling', 'barostat coupling', 'coupling constant'] },
  { to: { control: 'mdAnnealHeader' }, phrases: ['simulated annealing', 'annealing', 'temperature ramp', 'heat and cool', 'melt and quench'] },

  // ---- vibrations, energetics ---------------------------------------------------
  { to: { panel: 'phonon' }, phrases: [
    'lattice vibrations', 'lattice dynamics', 'phonon dispersion', 'phonon band structure', 'phonon bands',
    'vibrational modes', 'normal modes', 'vibrational frequencies', 'phonon frequencies', 'density of states', 'phonon dos',
    'projected dos', 'imaginary modes', 'imaginary frequencies', 'negative frequencies', 'soft modes', 'dynamical stability',
    'animate mode', 'mode animation', 'animate phonon', 'eigenvectors', 'acoustic modes', 'optical modes',
    'phonopy', 'band.yaml', 'mesh.yaml', 'qpoints.yaml', 'total_dos.dat', 'force constants', 'harmonic approximation',
    'vibrations', 'thz', 'wavenumber',
  ] },
  { to: { panel: 'eos' }, phrases: [
    'equation of state', 'bulk modulus', 'birch murnaghan', 'murnaghan', 'vinet', 'pressure derivative of bulk modulus',
    'energy volume curve', 'e-v curve', 'energy vs volume', 'pressure volume', 'p-v curve', 'pressure vs volume',
    'compression curve', 'equilibrium volume', 'compressibility', 'fit energy', 'volume scan',
  ] },
  { to: { control: 'eosComputeBtn' }, phrases: ['compute equation of state', 'eos from potential', 'pressure scan', 'calculate bulk modulus'] },
  { to: { control: 'eosDropZone' }, phrases: ['load eos data', 'import pressure volume data', 'p v data file'] },
  { to: { control: 'eosRefDropZone' }, phrases: ['experimental reference', 'compare with experiment', 'reference eos'] },
  { to: { control: 'eosEnergyUnits' }, phrases: ['energy units', 'hartree', 'rydberg'] },
  { to: { control: 'eosPressureUnits' }, phrases: ['pressure units', 'kbar', 'gpa'] },
  { to: { control: 'eosVolumeUnits' }, phrases: ['volume units', 'cubic angstrom', 'bohr cubed'] },
  { to: { control: 'eosErrorPlotsToggleMini' }, phrases: ['fit residuals', 'eos error plot'] },
  { to: { panel: 'eosPlots' }, phrases: ['e vs v plot', 'p vs v plot', 'eos plot'] },
  { to: { panel: 'landscape' }, phrases: [
    'energy landscape', 'potential energy surface', 'pes', 'energy scan', 'energy heatmap', 'energy map',
    'displacement scan', 'landscape json',
  ] },

  // ---- trajectories ---------------------------------------------------------------
  { to: { panel: 'trajectory' }, phrases: [
    'play trajectory', 'trajectory player', 'animation', 'movie', 'video', 'replay', 'md trajectory', 'relaxation trajectory',
    'step through frames', 'frame by frame', 'ionic steps', 'time evolution', 'xdatcar', 'extxyz', 'multi frame',
  ] },
  { to: { control: 'playPauseBtn' }, phrases: ['play animation', 'pause animation', 'start playback'] },
  { to: { control: 'stepFwdBtn' }, phrases: ['next step', 'forward one frame'] },
  { to: { control: 'stepBackBtn' }, phrases: ['previous step', 'back one frame'] },
  { to: { control: 'speedSelect' }, phrases: ['playback speed', 'animation speed', 'frames per second', 'fps', 'slow motion'] },
  { to: { control: 'frameStepInput' }, phrases: ['go to frame', 'jump to frame', 'frame number', 'skip frames'] },
  { to: { control: 'recenterEachStep' }, phrases: ['recentre structure', 'recenter structure', 'follow structure', 'remove drift', 'drift correction'] },
  { to: { control: 'combineTrajectoriesButton' }, phrases: [
    'combine trajectories', 'merge trajectories', 'concatenate trajectories', 'join frames', 'make trajectory from files',
  ] },
  { to: { panel: 'latticeAnalysis' }, phrases: [
    'lattice parameters vs pressure', 'cell parameters over time', 'cell evolution', 'volume vs step', 'volume over time',
    'strain', 'lattice constants', 'thermal expansion', 'lattice vs temperature', 'track lattice', 'lattice statistics',
  ] },
  { to: { control: 'laExportCsvBtn' }, phrases: ['export lattice data', 'lattice csv', 'spreadsheet'] },
  { to: { control: 'laCopyTableBtn' }, phrases: ['copy lattice table'] },
  { to: { control: 'laCustomAxisBtn' }, phrases: ['plot against temperature', 'plot against pressure'] },
  { to: { panel: 'latticePlots' }, phrases: ['lattice parameter plot', 'cell length plot', 'cell angle plot'] },

  // ---- symmetry, cell ---------------------------------------------------------------
  { to: { panel: 'symmetry' }, phrases: [
    'space group', 'symmetry analysis', 'find symmetry', 'standardise cell', 'wyckoff positions', 'point group',
    'symmetry operations', 'crystal system', 'bravais lattice', 'hermann mauguin', 'international symbol', 'hall symbol',
    'pearson symbol', 'protostructure', 'prototype', 'aflow prototype', 'symmetrise structure', 'spglib', 'moyo',
  ] },
  { to: { control: 'getSymBtn' }, phrases: ['detect symmetry', 'find space group', 'get space group', 'which space group'] },
  { to: { control: 'symTolInput' }, phrases: ['symmetry tolerance', 'symprec'] },
  { to: { control: 'getPrimBtn' }, phrases: ['primitive cell', 'reduce cell', 'smallest cell'] },
  { to: { control: 'getConvBtn' }, phrases: ['conventional cell', 'standard cell', 'conventional standard cell'] },
  { to: { control: 'showAsuBtn' }, phrases: ['asymmetric unit', 'irreducible wedge', 'fundamental domain'] },
  { to: { control: 'asuHighlightChk' }, phrases: ['highlight unique atoms', 'symmetry unique atoms'] },
  { to: { control: 'getWyckoffBtn' }, phrases: [
    'wyckoff editor', 'edit wyckoff positions', 'move atoms keeping symmetry', 'symmetry constrained editing',
  ] },
  { to: { panel: 'cell' }, phrases: [
    'supercell', 'make supercell', 'supercell builder', 'repeat cell', 'repeat unit cell', 'replicate cell', 'expand cell',
    'tile cell', 'multiply cell', '2x2x2', 'lattice transformation', 'transformation matrix', 'change basis',
    'redefine lattice vectors', 'lattice vectors', 'cell boundary', 'show more of the crystal', 'crop cell',
    'order disordered structure', 'partial occupancies', 'site disorder', 'occupancy', 'random alloy', 'solid solution',
  ] },
  { to: { control: 'applyVacuum' }, phrases: [
    'add vacuum', 'vacuum layer', 'vacuum gap', 'make slab', 'surface slab', 'slab model', 'surface',
    'molecule in a box', 'vacuum padding',
  ] },
  { to: { control: 'resetVacuum' }, phrases: ['remove vacuum', 'undo vacuum'] },
  { to: { control: 'osBuildBtn' }, phrases: ['random configurations', 'sample orderings', 'enumerate configurations', 'special quasirandom structure'] },
  { to: { control: 'osCompareBtn' }, phrases: ['compare configuration energies', 'lowest energy ordering'] },
  { to: { control: 'osMajorityBtn' }, phrases: ['majority occupant', 'most likely element'] },

  // ---- comparing, analysing ----------------------------------------------------------
  { to: { panel: 'comparison' }, phrases: [
    'compare structures', 'structure difference', 'structural difference', 'difference between structures',
    'before and after relaxation', 'displacement between structures', 'displacement field', 'rmsd', 'diff structures',
  ] },
  { to: { control: 'enableOverlayToggle' }, phrases: ['overlay structures', 'superimpose', 'superimpose structures', 'ghost structure'] },
  { to: { control: 'showLatticeComparison' }, phrases: ['compare cells', 'lattice difference'] },
  { to: { panel: 'bonds' }, phrases: [
    'bond lengths', 'bond cutoff', 'bond distance', 'neighbour distance', 'coordination number', 'bonding',
    'bond criteria', 'bond detection', 'connectivity', 'nearest neighbours', 'neighbour list', 'cutoff radius',
    'max bond length', 'hydrogen bonds', 'h-bonds', 'donor acceptor',
  ] },
  { to: { control: 'openBondLengthHistogram' }, phrases: [
    'bond length histogram', 'bond length distribution', 'distance histogram', 'bond statistics',
    'radial distribution function', 'rdf', 'pair distances',
  ] },
  { to: { control: 'resetBondLengths' }, phrases: ['default bond lengths', 'reset bonds'] },
  { to: { control: 'showBonds' }, phrases: ['hide bonds', 'turn off bonds', 'toggle bonds'] },
  { to: { panel: 'polyhedra' }, phrases: [
    'coordination polyhedra', 'octahedra', 'tetrahedra', 'octahedral', 'tetrahedral', 'polyhedron',
    'polyhedral connectivity', 'corner sharing', 'edge sharing', 'face sharing', 'octahedral tilting',
    'coordination environment', 'coordination shell', 'framework', 'cages', 'clathrate', 'zeolite',
  ] },
  { to: { control: 'openPolyhedraTypeHistogram' }, phrases: ['polyhedra statistics', 'polyhedron types', 'coordination statistics'] },
  { to: { control: 'polyhedraDetectCagesToggle' }, phrases: ['detect cages', 'find cages'] },
  { to: { control: 'showPolyhedra' }, phrases: ['hide polyhedra', 'toggle polyhedra'] },
  { to: { control: 'completePolyhedraToggle' }, phrases: ['whole polyhedra', 'polyhedra across boundary'] },
  { to: { control: 'polyEdgeWidth' }, phrases: ['polyhedra edges', 'polyhedron outline'] },
  { to: { panel: 'focusRegions' }, phrases: [
    'highlight defect', 'focus on molecule', 'focus on defect', 'fade surroundings', 'dim the rest',
    'transparent surroundings', 'region of interest', 'local environment', 'dopant', 'impurity', 'adsorbate',
    'active site', 'vacancy',
  ] },
  { to: { panel: 'planes' }, phrases: [
    'miller planes', 'miller indices', 'lattice planes', 'hkl plane', 'crystal plane', 'crystallographic plane',
    'cut structure', 'cross section', 'cleavage plane', 'slice structure', 'look inside the cell',
  ] },
  { to: { control: 'addPlaneBtn' }, phrases: ['add miller plane', 'new plane'] },
  { to: { control: 'createFromAtomsBtn' }, phrases: ['plane through atoms', 'plane through selected atoms', 'plane from three atoms'] },
  { to: { control: 'calcFromAtomsBtn' }, phrases: ['miller indices of selection', 'fit plane to atoms'] },
  { to: { control: 'showPlanesMasterToggle' }, phrases: ['hide planes', 'toggle planes'] },

  // ---- vectors, fields -------------------------------------------------------------------
  { to: { panel: 'forces' }, phrases: [
    'force arrows', 'atomic forces', 'force vectors', 'residual forces', 'forces on atoms', 'force magnitude',
    'hellmann feynman forces', 'outcar forces',
  ] },
  { to: { control: 'openForceHistogram' }, phrases: ['force histogram', 'force distribution', 'force statistics', 'largest forces'] },
  { to: { control: 'forceLogLengthCheckbox' }, phrases: ['logarithmic force arrows', 'log force length'] },
  { to: { control: 'showForcesToggle' }, phrases: ['hide forces', 'toggle forces'] },
  { to: { panel: 'spins' }, phrases: [
    'magnetic moments', 'spin arrows', 'magnetism', 'magnetic structure', 'magnetic order', 'magnetisation', 'magmom',
    'ferromagnetic', 'antiferromagnetic', 'spin polarised', 'spin texture', 'skyrmion', 'non-collinear spins',
    'noncollinear', 'collinear spins', 'saxis', 'spin quantisation axis',
  ] },
  { to: { control: 'spinTextInput' }, phrases: [
    'enter spins manually', 'manual spin vectors', 'type vectors', 'custom arrows', 'draw arrows', 'arrows on atoms',
  ] },
  { to: { control: 'spinShowCopiesCheckbox' }, phrases: ['spins on periodic images'] },
  { to: { control: 'spinLogLengthCheckbox' }, phrases: ['logarithmic spin arrows', 'log spin length'] },
  { to: { control: 'spinAutoScaleBtn' }, phrases: ['auto scale spins', 'spin arrow length'] },
  { to: { control: 'showSpinsToggle' }, phrases: ['hide spins', 'toggle spins'] },
  { to: { panel: 'field' }, phrases: [
    'charge density', 'electron density', 'isosurface', 'iso surface', 'isovalue', 'volumetric data', 'grid data',
    'electron localisation function', 'elf', 'wavefunction', 'orbital', 'band decomposed charge', 'partial charge',
    'parchg', 'spin density', 'charge density difference', 'combine fields', 'cube file', 'chgcar', 'elfcar', 'wavecar',
    'cut plane through density', 'density slice',
  ] },
  { to: { control: 'showFieldToggle' }, phrases: ['hide isosurface', 'toggle field'] },

  // ---- files ------------------------------------------------------------------------------
  { to: { control: 'uploadButton' }, phrases: [
    'open file', 'import structure', 'load structure', 'drag and drop', 'browse files', 'import file',
    'open poscar', 'open cif', 'load xyz', 'load outcar', 'read vasp output', 'open trajectory',
  ] },
  { to: { control: 'pasteTextButton' }, phrases: [
    'paste structure', 'paste poscar', 'paste cif', 'paste coordinates', 'paste from clipboard', 'type structure',
    'optimade', 'materials project id', 'fetch structure from database',
  ] },
  { to: { control: 'downloadButton' }, phrases: ['export structure', 'save structure', 'convert format', 'file conversion', 'write file'] },
  { to: { control: 'saveImageButton' }, phrases: [
    'screenshot', 'snapshot', 'export image', 'save picture', 'save as image', 'render image', 'png', 'svg',
    'vector graphics', 'transparent png', 'figure', 'publication figure', 'journal figure', 'high resolution image', 'high dpi',
  ] },
  { to: { control: 'saveButton' }, phrases: ['export poscar', 'save poscar', 'write poscar', 'vasp format', 'vasp input', 'contcar'] },
  { to: { control: 'saveCifButton' }, phrases: ['export cif', 'save cif', 'write cif'] },
  { to: { control: 'saveCifSymButton' }, phrases: ['cif with symmetry', 'symmetrised cif'] },
  { to: { control: 'qeInputButton' }, phrases: ['quantum espresso input', 'pw.x input', 'qe input', 'pwscf input'] },
  { to: { control: 'saveCellButton' }, phrases: ['castep cell file', 'castep input'] },
  { to: { control: 'saveGeometryButton' }, phrases: ['fhi-aims geometry', 'geometry.in', 'aims input'] },
  { to: { control: 'saveCrysvizButton' }, phrases: [
    'save session', 'save everything', 'project file', 'save workspace', 'save state', 'keep my structures',
    'back up structures', 'continue later',
  ] },
  { to: { control: 'shareBtn' }, phrases: ['share link', 'share url', 'qr code', 'send structure', 'permalink', 'send to a colleague'] },
  { to: { control: 'fssFracBtn' }, phrases: ['fractional coordinates', 'direct coordinates'] },
  { to: { control: 'fssCartBtn' }, phrases: ['cartesian coordinates'] },
  { to: { control: 'addButton' }, phrases: [
    'edit structure', 'structure editor', 'build structure', 'add atom', 'insert atom', 'remove atom', 'delete atom',
    'move atom', 'change element', 'substitute atom', 'replace element', 'doping', 'create vacancy',
    'modify lattice', 'change lattice parameters', 'edit lattice',
  ] },

  // ---- looks ----------------------------------------------------------------------------------
  { to: { control: 'atomSize' }, phrases: [
    'atom radius', 'ball size', 'sphere size', 'bigger atoms', 'smaller atoms', 'atom scale',
    'ball and stick', 'space filling', 'van der waals spheres',
  ] },
  { to: { control: 'bondWidth' }, phrases: ['bond thickness', 'stick radius', 'thicker bonds', 'thinner bonds'] },
  { to: { control: 'showLattice' }, phrases: ['unit cell box', 'show cell', 'hide cell', 'cell edges'] },
  { to: { control: 'latticeWidth' }, phrases: ['cell line thickness'] },
  { to: { control: 'showAxes' }, phrases: ['coordinate axes', 'axis indicator', 'abc axes', 'xyz axes'] },
  { to: { control: 'showPeriodic' }, phrases: ['periodic images', 'boundary atoms', 'image atoms'] },
  { to: { control: 'PBCBondToggle' }, phrases: ['bonds across boundary', 'bonds to periodic images'] },
  { to: { control: 'showCharges' }, phrases: ['oxidation states', 'formal charges', 'charge labels', 'ionic charges'] },
  { to: { control: 'atomsMenu' }, phrases: [
    'atom colours', 'colour atoms', 'colour atoms by', 'colour by force', 'colour by property', 'colour scheme',
  ] },
  { to: { control: 'atomsElementColorMapMenu' }, phrases: ['element colour scheme', 'jmol colours', 'cpk colours', 'default colours'] },
  { to: { control: 'bondsMenu' }, phrases: ['bond colours', 'colour bonds', 'colour bonds by length', 'two coloured bonds'] },
  { to: { control: 'renderPipelineMenu' }, phrases: [
    'ray tracing', 'path tracing', 'render quality', 'realistic rendering', 'high quality render', 'photorealistic',
    'global illumination', 'shadows', 'reflections',
  ] },
  { to: { control: 'renderStyleMenu' }, phrases: [
    'cel shading', 'cartoon look', 'toon shading', 'metallic look', 'matte look', 'glossy', 'shiny atoms', 'outlines',
  ] },
  { to: { control: 'depthPeelLayersSlider' }, phrases: ['transparency quality', 'depth peeling', 'order independent transparency'] },
  { to: { control: 'rtGroundToggle' }, phrases: ['ground shadow', 'floor', 'shadow plane'] },
  { to: { control: 'resetRenderingBtn' }, phrases: ['default rendering'] },
  { to: { control: 'backgroundSwatch' }, phrases: ['background colour', 'white background', 'black background', 'transparent background'] },
  { to: { control: 'orthographicCamera' }, phrases: [
    'orthographic projection', 'parallel projection', 'perspective projection', 'orthographic', 'isometric view', 'no perspective',
  ] },
  { to: { control: 'autoRotate' }, phrases: ['auto rotate', 'turntable', 'spin the structure', 'keep rotating', 'momentum'] },
  { to: { control: 'cameraSpeedFactor' }, phrases: ['mouse sensitivity', 'rotation speed', 'zoom speed', 'pan speed', 'trackpad sensitivity'] },
  { to: { control: 'featureSharedViewToggle' }, phrases: ['same camera for all structures', 'sync views', 'link cameras'] },
  { to: { control: 'forceCompactIconsToggle' }, phrases: ['compact toolbars', 'icon only toolbars', 'smaller toolbars'] },
  { to: { control: 'measureToolLabelsToggle' }, phrases: ['measurement labels'] },
  { to: { panel: 'customSettings' }, phrases: [
    'custom colours', 'default element colours', 'custom radii', 'element radii', 'covalent radii', 'bond length rules',
    'custom bond distances', 'periodic table', 'import settings', 'export settings', 'my settings', 'preferences file',
    'custom shortcuts', 'change shortcuts', 'rebind keys', 'hotkeys',
  ] },
  { to: { control: 'compositionLegendButton' }, phrases: ['legend', 'colour legend', 'element legend', 'composition legend'] },
  { to: { control: 'resetAllColorsBtn' }, phrases: ['reset colours', 'undo colour changes'] },
  { to: { control: 'applyStylesToTrajectoryBtn' }, phrases: ['apply colours to all frames', 'style whole trajectory'] },
  { to: { control: 'linkPeriodicCopiesToggle' }, phrases: ['periodic copies same colour'] },

  // ---- scene tools ------------------------------------------------------------------------------
  { to: { control: 'distanceModeBtn' }, phrases: ['measure distance', 'interatomic distance', 'ruler', 'distance between atoms', 'measure bond'] },
  { to: { control: 'angleModeBtn' }, phrases: ['measure angle', 'bond angle', 'angle between atoms'] },
  { to: { control: 'clearAllMeasurements' }, phrases: ['clear measurements', 'remove measurements', 'delete measurements'] },
  { to: { control: 'hideAtomsBtn' }, phrases: ['hide atoms', 'hide some atoms', 'hide selected atoms'] },
  { to: { control: 'restoreBtn' }, phrases: ['show hidden atoms', 'unhide atoms', 'show all atoms'] },
  { to: { control: 'resetView' }, phrases: [
    'reset camera', 'default view', 'zoom to fit', 'fit to screen', 'home view', 'centre structure', 'center structure', 'recentre',
  ] },
  { to: { panel: 'view' }, phrases: ['view along axis', 'look along', 'align view', 'rotate view', 'rotate by 90 degrees', 'step rotation'] },
  { to: { control: 'viewX' }, phrases: ['look down x', 'view along x'] },
  { to: { control: 'viewY' }, phrases: ['look down y', 'view along y'] },
  { to: { control: 'viewZ' }, phrases: ['look down z', 'view along z', 'top view'] },
  { to: { control: 'viewA' }, phrases: ['view along a', 'view along 100', 'along a axis'] },
  { to: { control: 'viewB' }, phrases: ['view along b', 'view along 010', 'along b axis'] },
  { to: { control: 'viewC' }, phrases: ['view along c', 'view along 001', 'along c axis'] },
  { to: { panel: 'info' }, phrases: [
    'chemical formula', 'atom list', 'list of atoms', 'composition', 'stoichiometry', 'atomic positions',
    'coordinates table', 'site list', 'colour one atom', 'style single atom', 'structure information',
  ] },

  // ---- the app ------------------------------------------------------------------------------------
  { to: { action: 'Add panels' }, phrases: [
    'more panels', 'more features', 'show all features', 'hidden features', 'missing panel', 'missing window', 'add window',
  ] },
  { to: { action: 'Reset to Essentials' }, phrases: ['simplify sidebar', 'fewer panels', 'too many panels', 'clean sidebar'] },
  { to: { action: 'Light mode' }, phrases: ['white mode', 'bright theme'] },
  { to: { action: 'Dark mode' }, phrases: ['night mode', 'dark theme'] },
  { to: { action: 'Colour palette' }, phrases: ['theme colours', 'accent colour', 'colour theme'] },
  { to: { action: 'About CrysViz' }, phrases: ['how to cite', 'cite crysviz', 'citation', 'licence', 'privacy policy'] },
  { to: { control: 'fontScaleSlider' }, phrases: ['font size', 'text size', 'bigger text', 'ui scale', 'zoom interface'] },
  { to: { control: 'resetUiButton' }, phrases: ['reset layout', 'reset windows', 'default layout', 'windows in a mess'] },
  { to: { control: 'clearLocalDataButton' }, phrases: ['clear cache', 'forget settings', 'reset everything', 'factory reset', 'delete stored data'] },
  { to: { control: 'disableLeaveWarningToggle' }, phrases: ['reload warning', 'leave site warning', 'stop asking before reload'] },
  { to: { control: 'disableRaytraceWarningToggle' }, phrases: ['ray tracing warning'] },
  { to: { control: 'exportGpuMemorySlider' }, phrases: ['gpu memory', 'vram', 'large image export'] },
  { to: { control: 'measureLabelSize' }, phrases: ['measurement label size', 'measurement font size'] },
  { to: { control: 'measureLineStyle' }, phrases: ['dashed line', 'measurement line style'] },
  { to: { control: 'dragIntoDockToggle' }, phrases: ['docking behaviour', 'prevent docking', 'stop windows docking'] },
];

// Best bets: for a broad word that matches dozens of controls ("colour"), the
// ones people most likely mean, in order. A target is a window ({ panel }),
// a control by id ({ control }), a control without an id by its window and
// label ({ panel, label }: the Structure window's Atoms tab), a structure
// result by key ({ structure }: the Structure window's colour dots,
// search/structureEntries.js) or an app action. They lead the results when the query
// is that word — in any word form ("colours", "color") — or its start while it
// is typed (four letters on: "colo"); every other match follows as usual. Keep
// this to words whose plain ranking puts something niche first.
/** @type {{ words: string[], targets: { panel?: string, label?: string, control?: string, structure?: string, action?: string }[] }[]} */
export const BEST_BETS = [
  { words: ['colour', 'colouring'], targets: [
    { structure: 'element-colors' }, { structure: 'bond-colors' }, { control: 'atomsMenu' }, { control: 'bondsMenu' },
    { control: 'atomsElementColorMapMenu' }, { structure: 'polyhedra-colors' }, { control: 'backgroundSwatch' },
    { panel: 'customSettings' },
  ] },
  { words: ['atom colour', 'element colour'], targets: [
    { structure: 'element-colors' }, { control: 'atomsMenu' }, { control: 'atomsElementColorMapMenu' }, { panel: 'customSettings' },
  ] },
  { words: ['bond colour', 'bond pair colour'], targets: [{ structure: 'bond-colors' }, { control: 'bondsMenu' }] },
  { words: ['colour map', 'colormap', 'colourmap'], targets: [
    { control: 'atomsElementColorMapMenu' }, { control: 'atomsMenu' }, { control: 'bondsMenu' }, { panel: 'field' },
  ] },
  { words: ['atom', 'atoms'], targets: [
    { control: 'showAtoms' }, { panel: 'info', label: 'Atoms' }, { control: 'atomsMenu' }, { control: 'atomSize' },
    { panel: 'info' }, { control: 'addButton' },
  ] },
  { words: ['size', 'sizes'], targets: [
    { control: 'atomSize' }, { control: 'bondWidth' }, { panel: 'customSettings' }, { control: 'fontScaleSlider' },
  ] },
  { words: ['radius', 'radii'], targets: [
    { control: 'atomSize' }, { panel: 'customSettings' }, { control: 'bondWidth' },
  ] },
  { words: ['export', 'save', 'download'], targets: [
    { control: 'downloadButton' }, { control: 'saveImageButton' }, { control: 'saveCrysvizButton' },
    { control: 'saveButton' }, { control: 'saveCifButton' },
  ] },
  { words: ['camera'], targets: [
    { control: 'orthographicCamera' }, { control: 'resetView' }, { panel: 'view' }, { control: 'cameraSpeedFactor' },
    { control: 'featureSharedViewToggle' },
  ] },
  { words: ['rotate', 'rotation'], targets: [
    { panel: 'view' }, { control: 'autoRotate' }, { control: 'cameraSpeedFactor' },
  ] },
  { words: ['reset'], targets: [
    { control: 'resetView' }, { control: 'resetUiButton' }, { action: 'Reset to Essentials' },
    { control: 'resetAllColorsBtn' }, { control: 'resetRenderingBtn' },
  ] },
  { words: ['hide', 'hiding'], targets: [
    { control: 'hideAtomsBtn' }, { control: 'showBonds' }, { control: 'showLattice' }, { control: 'showAtoms' },
  ] },
  { words: ['energy'], targets: [
    { control: 'relaxEfsCard' }, { panel: 'eos' }, { panel: 'landscape' }, { panel: 'backend' },
  ] },
  { words: ['arrow', 'arrows', 'vector', 'vectors'], targets: [
    { panel: 'forces' }, { panel: 'spins' }, { control: 'spinTextInput' },
  ] },
  { words: ['quality'], targets: [
    { control: 'renderPipelineMenu' }, { control: 'depthPeelLayersSlider' },
    { control: 'exportGpuMemorySlider' },
  ] },
  { words: ['pressure'], targets: [
    { control: 'relaxTargetPressureInput' }, { control: 'mdPressureInput' }, { panel: 'eos' }, { control: 'eosComputeBtn' },
  ] },
  { words: ['temperature'], targets: [{ control: 'mdTemperatureInput' }, { control: 'mdAnnealHeader' }] },
  { words: ['font'], targets: [{ control: 'fontScaleSlider' }, { control: 'measureLabelSize' }] },
  { words: ['cell'], targets: [
    { panel: 'cell' }, { control: 'showLattice' }, { control: 'getPrimBtn' }, { control: 'getConvBtn' }, { control: 'latticeWidth' },
  ] },
];

// Result names for controls whose own label needs its section to make sense
// out of context: Visual > Colors > "Atoms" reads "Atom colors" in the
// results. The original label still matches.
/** @type {Record<string, string>} */
export const RESULT_LABELS = {
  atomsMenu: 'Atom colors',
  bondsMenu: 'Bond colors',
};
