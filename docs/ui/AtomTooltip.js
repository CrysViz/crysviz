// Atom hover tooltip. Extracted from crystal-viewer.js (Stage 3).
// On mouse move over the scene, raycasts the atom group and shows a small
// tooltip with the element symbol and its per-element index.

import * as THREE from '../external/three/three.module.js';
import { app, groups, fileBrowser, highlightHover } from '../state/store.js';

export function setupAtomTooltip() {
  const view = document.getElementById('view');

  const atomTooltip = document.createElement('div');
  atomTooltip.className = 'atom-tooltip';
  atomTooltip.setAttribute('aria-hidden', 'true');
  view.appendChild(atomTooltip);

  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();

  function hideAtomTooltip() {
    if (!atomTooltip) return;
    atomTooltip.classList.remove('visible');
    atomTooltip.setAttribute('aria-hidden', 'true');
    highlightHover.hoveredAtom = null;
  }

  function updateAtomTooltip(event) {
    if (!groups.atomsGroup || !groups.atomsGroup.children.length || !atomTooltip) {
      hideAtomTooltip();
      return;
    }

    const rect = app.renderer.domElement.getBoundingClientRect();
    const clientX = event.clientX;
    const clientY = event.clientY;
    if (clientX == null || clientY == null) {
      hideAtomTooltip();
      return;
    }

    const x = ((clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((clientY - rect.top) / rect.height) * 2 + 1;
    mouse.set(x, y);
    raycaster.setFromCamera(mouse, app.camera);

    const hits = raycaster.intersectObjects(groups.atomsGroup.children, true);
    if (!hits.length) {
      hideAtomTooltip();
      return;
    }
    const hit = hits[0].object;
    const element = hit?.userData?.element || hit?.parent?.userData?.element || null;
    const sourceIndex = hit?.userData?.sourceIndex ?? hit?.parent?.userData?.sourceIndex ?? null;

    if (!element) {
      hideAtomTooltip();
      return;
    }

    // Build list of all atom indices for this element
    const elementAtomIndices = [];
    let elements = [...fileBrowser.selectedStructure.elements];
    for (let i = 0; i < elements.length; i++) {
      if (elements[i] === element) {
        elementAtomIndices.push(i);
      }
    }

    if (highlightHover.hoveredAtom !== hit) {
      highlightHover.hoveredAtom = hit;

      if (sourceIndex == null) {
        atomTooltip.textContent = `${element}`;
      } else {
        // compute atom number within this element type
        const elementLocalIndex = elementAtomIndices.indexOf(sourceIndex) + 1; // +1 for 1-based display
        const displayIndex = elementLocalIndex || sourceIndex; // fallback if not found
        atomTooltip.textContent = `${element} ${displayIndex}`;
      }
    }


    atomTooltip.style.left = `${clientX - rect.left}px`;
    atomTooltip.style.top = `${clientY - rect.top}px`;
    atomTooltip.classList.add('visible');
    atomTooltip.setAttribute('aria-hidden', 'false');
  }

  app.renderer.domElement.addEventListener('mousemove', updateAtomTooltip);
  app.renderer.domElement.addEventListener('mouseleave', hideAtomTooltip);
  app.renderer.domElement.addEventListener('touchstart', hideAtomTooltip, { passive: true });
}
