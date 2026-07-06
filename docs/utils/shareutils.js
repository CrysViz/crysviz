// shareutils.js - Complete state sharing functionality for crystal structure viewer

// Comprehensive state capture for full sharing
export function captureCompleteState(structureData, globalState) {
  if (!structureData) return null;

  const {
    userColorOverrides,
    individualAtomColors,
    useVestaColors,
    atomSize,
    bondRadius,
    showBonds,
    showLattice,
    showNeighborBonds,
    useOrthographicCamera,
    bondLengths,
    bondVisibility,
    camera,
    controls,
    measureMode
  } = globalState;

  const state = {
    // Version for future compatibility
    version: '1.0',

    // Structure data (current basic sharing)
    structure: {
      comment: structureData.comment || 'Shared structure',
      lattice: structureData.unitCellLattice,
      elements: structureData.elements,
      positions: structureData.unitCellPositions
    },

    // Visual appearance
    appearance: {
      userColorOverrides: userColorOverrides || {},
      individualAtomColors: individualAtomColors || {},
      useVestaColors: useVestaColors || false
    },

    // Display settings
    display: {
      atomSize: parseFloat(atomSize) || 1.0,
      bondWidth: parseFloat(bondRadius) || 0.08,
      showBonds: Boolean(showBonds),
      showLattice: Boolean(showLattice),
      showNeighborBonds: Boolean(showNeighborBonds),
      useOrthographicCamera: Boolean(useOrthographicCamera)
    },

    // Bond settings
    bonds: {
      bondLengths: bondLengths || {},
      bondVisibility: bondVisibility || {}
    },

    // Camera state
    camera: {
      position: camera ? [camera.position.x, camera.position.y, camera.position.z] : null,
      target: controls ? [controls.target.x, controls.target.y, controls.target.z] : null,
      zoom: camera ? (camera.zoom || null) : null
    },

    // UI state. "open" = the formula box inside the Structure window is
    // expanded (its details visible).
    ui: {
      structurePanelOpen: document.getElementById('composition')?.classList.contains('open') || false,
      expandedElements: getExpandedElements(),
      measurementMode: measureMode || 'none'
    }
  };

  return state;
}

// Helper function to get currently expanded elements
function getExpandedElements() {
  const expanded = [];
  const atomContainers = document.querySelectorAll('.individual-atoms');
  atomContainers.forEach((container, index) => {
    if (container.style.display !== 'none') {
      // Find the element from the parent container's data attribute (positional
      // span selectors broke when the header gained the visibility checkbox).
      const elementName = /** @type {HTMLElement} */ (container.parentElement)?.dataset?.element;
      if (elementName) {
        expanded.push(elementName);
      }
    }
  });
  return expanded;
}

// Enhanced URL creation with complete state
export function createCompleteShareableURL(structureData, globalState) {
  const completeState = captureCompleteState(structureData, globalState);
  if (!completeState) return null;

  console.log('Captured complete state:', completeState);

  // Encode complete state to base64
  const stateJSON = JSON.stringify(completeState);
  const base64Data = btoa(stateJSON);

  // Create URL with complete state parameter
  const currentURL = new URL(window.location.href);
  currentURL.searchParams.set('state', base64Data);

  return currentURL.toString();
}

// Legacy POSCAR generation for backwards compatibility
export function generatePOSCARString(structureData) {
  if (!structureData) return null;

  const { elements, positions, lattice } = structureData;
  const comment = 'Shared structure';
  const scale = 1.0;

  // Build POSCAR string with proper formatting
  let poscar = `${comment}\n`;
  poscar += `${scale.toFixed(1)}\n`;  // Remove leading spaces from scale line

  // Lattice vectors
  for (let i = 0; i < 3; i++) {
    poscar += `  ${lattice[i][0].toFixed(8)}  ${lattice[i][1].toFixed(8)}  ${lattice[i][2].toFixed(8)}\n`;
  }

  // Element names and counts
  const elementCounts = {};
  elements.forEach(el => elementCounts[el] = (elementCounts[el] || 0) + 1);
  const uniqueElements = Object.keys(elementCounts).sort();

  poscar += uniqueElements.join(' ') + '\n';
  poscar += uniqueElements.map(el => elementCounts[el]).join(' ') + '\n';
  poscar += 'Direct\n';

  // Atomic positions grouped by element
  uniqueElements.forEach(element => {
    elements.forEach((el, i) => {
      if (el === element) {
        poscar += `  ${positions[i][0].toFixed(8)}  ${positions[i][1].toFixed(8)}  ${positions[i][2].toFixed(8)}\n`;
      }
    });
  });

  return poscar.trim(); // Remove trailing newlines
}

// Legacy function for basic structure sharing (keep for compatibility)
export function createLegacyShareableURL(structureData) {
  const poscarString = generatePOSCARString(structureData);
  if (!poscarString) return null;

  console.log('Generated POSCAR string:', poscarString);

  // Encode to base64
  const base64Data = btoa(poscarString);

  // Create URL with structure parameter
  const currentURL = new URL(window.location.href);
  currentURL.searchParams.set('structure', base64Data);

  return currentURL.toString();
}

// Function to restore complete state from shared URL
export function restoreCompleteState(state, globalSetters) {
  console.log('Restoring complete state:', state);

  const {
    setStructureData,
    setOriginalStructureData,
    setUserColorOverrides,
    setIndividualAtomColors,
    setUseVestaColors,
    setAtomSize,
    setBondRadius,
    setShowBonds,
    setShowLattice,
    setShowNeighborBonds,
    setUseOrthographicCamera,
    setBondLengths,
    setBondVisibility,
    loadColorOverrides: _loadColorOverrides,
    loadIndividualAtomColors: _loadIndividualAtomColors,
    updateVisualization,
    createBondLengthControls,
    createShareButton,
    switchCameraType,
    resetView,
    clearMeasure,
    resizeRenderer,
    setStatus,
    camera,
    controls
  } = globalSetters;

  // 1. Restore structure data
  const structureData = {
    comment: state.structure.comment,
    lattice: state.structure.lattice,
    elements: state.structure.elements,
    positions: state.structure.positions
  };
  setStructureData(structureData);
  setOriginalStructureData(JSON.parse(JSON.stringify(structureData)));

  // 2. Restore appearance settings
  setUserColorOverrides(state.appearance.userColorOverrides || {});
  setIndividualAtomColors(state.appearance.individualAtomColors || {});
  setUseVestaColors(state.appearance.useVestaColors || false);

  // 3. Restore display settings
  setAtomSize(state.display.atomSize || 1.0);
  setBondRadius(state.display.bondWidth || 0.08);
  setShowBonds(state.display.showBonds);
  setShowLattice(state.display.showLattice);
  setShowNeighborBonds(state.display.showNeighborBonds || false);
  setUseOrthographicCamera(state.display.useOrthographicCamera || false);

  // 4. Restore bond settings
  setBondLengths(state.bonds.bondLengths || {});
  setBondVisibility(state.bonds.bondVisibility || {});

  // 5. Update UI controls to match restored state
  updateUIControlsFromState(state);

  // 6. Recreate interface
  createBondLengthControls();
  createShareButton();

  // 7. Update visualization
  updateVisualization();

  // 8. Restore camera state
  if (state.camera.position && state.camera.target) {
    setTimeout(() => {
      camera.position.set(...state.camera.position);
      controls.target.set(...state.camera.target);
      if (state.camera.zoom && camera.zoom !== undefined) {
        camera.zoom = state.camera.zoom;
        camera.updateProjectionMatrix();
      }
      controls.update();
    }, 100);
  } else {
    // Fallback to default view setup
    switchCameraType();
    resetView();
  }

  // 9. Restore UI panel states
  restoreUIPanelStates(state.ui);

  clearMeasure();
  resizeRenderer();

  setStatus('Loaded shared state with complete settings');
  return true;
}

// Helper function to update UI controls
function updateUIControlsFromState(state) {
  // Update sliders and checkboxes to match restored state
  const atomSizeSlider = document.getElementById('atomSize');
  const atomSizeValue = document.getElementById('atomSizeValue');
  if (atomSizeSlider && atomSizeValue) {
    const atomSizeNum = parseFloat(state.display.atomSize) || 1.00;
    atomSizeSlider.value = atomSizeNum;
    atomSizeValue.textContent = atomSizeNum.toFixed(1);
  }

  const bondWidthSlider = document.getElementById('bondWidth');
  const bondWidthValue = document.getElementById('bondWidthValue');
  if (bondWidthSlider && bondWidthValue) {
    const bondWidthNum = parseFloat(state.display.bondWidth) || 0.08;
    bondWidthSlider.value = bondWidthNum;
    bondWidthValue.textContent = bondWidthNum.toFixed(2);
  }

  // Update checkboxes
  const showBondsEl = document.getElementById('showBonds');
  if (showBondsEl) showBondsEl.checked = state.display.showBonds;

  const showLatticeEl = document.getElementById('showLattice');
  if (showLatticeEl) showLatticeEl.checked = state.display.showLattice;

  const neighborBondsEl = document.getElementById('neighborBonds');
  if (neighborBondsEl) neighborBondsEl.checked = state.display.showNeighborBonds;

  const orthoCameraEl = document.getElementById('orthographicCamera');
  if (orthoCameraEl) orthoCameraEl.checked = state.display.useOrthographicCamera;

  const vestaColorsEl = document.getElementById('vestaColors');
  if (vestaColorsEl) vestaColorsEl.checked = state.appearance.useVestaColors;
}

// Helper function to restore UI panel states
function restoreUIPanelStates(uiState) {
  // Shared-structure restore runs before the unified panel windows exist, so
  // leave a marker on #composition; ui/panels/defaultPanels.js expands the
  // info panel when it registers it.
  if (uiState.structurePanelOpen) {
    const composition = document.getElementById('composition');
    if (composition) composition.dataset.restoreOpen = '1';
  }

  // Note: Element expansions will be restored when renderComposition() is called
}

