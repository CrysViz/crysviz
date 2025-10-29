// Share functionality - moved to shareutils.js
//
import { app, general,mode,defaultPOSCAR, polyStyle, defaultColorMap, jmolColorMap, atomicRadii,getAtomVisSettings,getBondVisSettings,getLatticeVisSettings } from '../store.js';

export function shareStructure() {
  // Prepare global state object for sharing
  const globalState = {
    userColorOverrides,
    individualAtomColors,
    useDefaultColors,
    atomSize,
    bondRadius,
    showBonds,
    showLattice,
    showSecond,
    showCompInfo,
    showNeighborBonds,
    useOrthographicCamera,
    bondLengths,
    bondVisibility,
    measureMode
  };

  // Use complete state sharing instead of basic structure sharing
  const shareURL = createCompleteShareableURL(structureData, globalState);
  if (!shareURL) {
    alert('No structure loaded to share!');
    return;
  }

  // Try modern clipboard API first, then fallback
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(shareURL).then(() => {
      // Show success message
      const shareBtn = document.getElementById('shareBtn');
      const originalText = shareBtn.textContent;
      shareBtn.textContent = '✓ Copied!';
      shareBtn.style.backgroundColor = '#4CAF50';

      setTimeout(() => {
        shareBtn.textContent = originalText;
        shareBtn.style.backgroundColor = '';
      }, 2000);
    }).catch(() => {
      // Fallback: show URL in prompt for manual copying
      prompt('Copy this URL to share:', shareURL);
    });
  } else {
    // Clipboard API not available, use fallback method
    try {
      // Try the older document.execCommand method
      const textArea = document.createElement('textarea');
      textArea.value = shareURL;
      textArea.style.position = 'fixed';
      textArea.style.left = '-999999px';
      textArea.style.top = '-999999px';
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();

      const success = document.execCommand('copy');
      document.body.removeChild(textArea);

      if (success) {
        // Show success message
        const shareBtn = document.getElementById('shareBtn');
        const originalText = shareBtn.textContent;
        shareBtn.textContent = '✓ Copied!';
        shareBtn.style.backgroundColor = '#4CAF50';

        setTimeout(() => {
          shareBtn.textContent = originalText;
          shareBtn.style.backgroundColor = '';
        }, 2000);
      } else {
        throw new Error('execCommand failed');
      }
    } catch (err) {
      // Final fallback: show URL in prompt for manual copying
      prompt('Copy this URL to share:', shareURL);
    }
  }
}


// Function to create share button UI
export function createShareButton() {
  // Check if button already exists
  let shareBtn = document.getElementById('shareBtn');
  if (shareBtn) return;

  shareBtn = document.createElement('button');
  shareBtn.id = 'shareBtn';
  shareBtn.textContent = '🔗 Share All';
  shareBtn.style.cssText = `
    padding: 8px 16px;
    margin-top: 8px;
    background: linear-gradient(135deg, #4CAF50, #45a049);
    color: white;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    transition: all 0.2s ease;
    width: 100%;
  `;

  shareBtn.addEventListener('mouseenter', () => {
    shareBtn.style.background = 'linear-gradient(135deg, #45a049, #4CAF50)';
    shareBtn.style.transform = 'translateY(-1px)';
  });

  shareBtn.addEventListener('mouseleave', () => {
    shareBtn.style.background = 'linear-gradient(135deg, #4CAF50, #45a049)';
    shareBtn.style.transform = 'translateY(0)';
  });

  shareBtn.onclick = shareStructure;

  // Try multiple locations to ensure the button appears
  const structureControls = document.getElementById('structureControls');

  const bondControlsGroup = document.getElementById('bondControlsGroup');
  const spinControlsGroup = document.getElementById('spinControlsGroup');
  const composition = document.getElementById('composition');

  if (structureControls) {
    structureControls.appendChild(shareBtn);
    console.log('Share button added to structureControls');
  } else if (bondControlsGroup) {
    bondControlsGroup.appendChild(shareBtn);
    console.log('Share button added to bondControlsGroup (fallback)');
  } else if (composition) {
    composition.parentElement.appendChild(shareBtn);
    console.log('Share button added near composition (fallback 2)');
  } else {
    console.error('Could not find a suitable container for share button');
  }
}


// Function to load structure from URL parameter
export function loadSharedStructure() {
  const urlParams = new URLSearchParams(window.location.search);
  const stateParam = urlParams.get('state');
  const structureParam = urlParams.get('structure'); // Legacy support

  // Try new complete state format first
  if (stateParam) {
    try {
      const stateJSON = atob(stateParam);
      const completeState = JSON.parse(stateJSON);

      console.log('Loading complete shared state');
      restoreCompleteState(completeState, {
        setStructureData: (data) => { structureData = data; },
        setOriginalStructureData: (data) => { originalStructureData = data; },
        setUserColorOverrides: (overrides) => { userColorOverrides = overrides; },
        setIndividualAtomColors: (colors) => { individualAtomColors = colors; },
        setUseDefaultColors: (use) => { useDefaultColors = use; },
        setAtomSize: (size) => { atomSize = size; },
        setBondRadius: (radius) => { bondRadius = radius; },
        setShowBonds: (show) => { showBonds = show; },
        setShowLattice: (show) => { showLattice = show; },
        setShowSecond: (show) => {showSecond = show; },
        setShowPolyhedra: (show) => {showPolyhedra = show; },
        setShowCompInfo: (show) => {showCompInfo = show; },
        setShowNeighborBonds: (show) => { showNeighborBonds = show; },
        setUseOrthographicCamera: (use) => { useOrthographicCamera = use; },
        setBondLengths: (lengths) => { bondLengths = lengths; },
        setBondVisibility: (visibility) => { bondVisibility = visibility; },
        loadColorOverrides,
        loadIndividualAtomColors,
        updateVisualization,
        addSecondStructure,
        createBondLengthControls,
        createSpinControls,
        createBackgroundControl,
        createShareButton,
        switchCameraType,
        resetView,
        clearMeasure,
        resizeRenderer,
        setStatus,
      });

      // Clear the URL parameter
      const newUrl = new URL(window.location);
      newUrl.searchParams.delete('state');
      window.history.replaceState({}, document.title, newUrl.toString());
      general.sharedStructureLoaded = true;
      return;
    } catch (error) {
      console.error('Failed to load complete state:', error);
      setStatus('Failed to load shared state');
      general.sharedStructureLoaded = true; // Prevent default structure from loading
      return;
    }
  }
  // Fallback to legacy structure-only sharing
  if (structureParam) {
    try {
      // Decode base64 to get POSCAR string
      const poscarString = atob(structureParam);
      console.log('Decoded POSCAR string:', poscarString);

      // Debug: check the individual lines
      const lines = poscarString.split('\n');
      console.log('POSCAR lines:', lines);
      console.log('Scale line (line 1):', `"${lines[1]}"`);
      console.log('parseFloat of scale line:', parseFloat(lines[1]));
      console.log('isFinite check:', Number.isFinite(parseFloat(lines[1])));

      // Parse the POSCAR string
      console.log('About to call parsePOSCAR...');
      let parsedStructureData;
      try {
        parsedStructureData = parsePOSCAR(poscarString);
        console.log('parsePOSCAR succeeded:', parsedStructureData);
      } catch (parseError) {
        console.error('parsePOSCAR failed:', parseError);
        console.error('Error stack:', parseError.stack);
        throw parseError;
      }

      if (parsedStructureData) {
        // Set the global structure data variable
        structureData = parsedStructureData;
        originalStructureData = JSON.parse(JSON.stringify(structureData));
        loadColorOverrides();
        loadIndividualAtomColors();
        setStatus('Loaded shared structure');

        // Show structure controls and create share button
        document.getElementById('structureControls').style.display = 'block';
        document.getElementById('bondControlsGroup').style.display = 'block';
        document.getElementById('spinControlsGroup').style.display = 'block';
        createBondLengthControls();
        createSpinControls();
        createShareButton();

        console.log('About to call updateVisualization with structure data:', structureData);
        updateVisualization();
        console.log('updateVisualization completed');

        // Rebuild camera and reset view
        console.log('About to rebuild camera and reset view');
        switchCameraType();
        resetView();
        clearMeasure();
        resizeRenderer(app.orthographicFrustumSize);
        console.log('Camera rebuild and view reset completed');

        // Clear the URL parameter to clean up the URL
        const newUrl = new URL(window.location);
        newUrl.searchParams.delete('structure');
        window.history.replaceState({}, document.title, newUrl.toString());

        // Set flag to prevent loading default structure
        general.sharedStructureLoaded = true;
      }
    } catch (error) {
      console.error('Failed to load shared structure:', error);
      console.error('POSCAR string was:', atob(structureParam));
      setStatus('Failed to load shared structure');
    }
  }
}

  
