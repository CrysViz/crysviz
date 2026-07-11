// Depth Peeling for order-independent transparency in CrysViz
// Adapted from: https://github.com/gkjohnson/three-depthpeeling-demo
// Handles atoms, bonds, and polyhedra with correct transparency ordering.

import * as THREE from '../external/three/three.module.js';
import { app, groups, general } from '../state/store.js';

// Depth textures and render targets for peeling
let depthTexture, depthTexture2, opaqueDepthTexture;
let renderTarget, compositeTarget;
let copyQuad;

// Groups for opaque and transparent objects
let transparentGroup, opaqueGroup;

// Layer render targets for multi-pass peeling
const layers = [];

// Track if depth peeling is initialized
let isInitialized = false;

// Default peeling settings
const DEFAULT_LAYERS = 3;

/**
 * Initialize depth peeling resources (textures, targets, groups).
 */
export function initDepthPeeling() {
  if (isInitialized) return;
  
  const w = app.renderer.domElement.width || window.innerWidth;
  const h = app.renderer.domElement.height || window.innerHeight;
  const dpr = app.renderer.getPixelRatio();

  // Create depth textures
  depthTexture = new THREE.DepthTexture(w * dpr, h * dpr, THREE.FloatType);
  depthTexture2 = new THREE.DepthTexture(w * dpr, h * dpr, THREE.FloatType);
  opaqueDepthTexture = new THREE.DepthTexture(w * dpr, h * dpr, THREE.FloatType);

  // Create render targets
  renderTarget = new THREE.WebGLRenderTarget(w * dpr, h * dpr, {
    colorSpace: THREE.SRGBColorSpace,
    depthBuffer: true,
    samples: 0,
  });
  compositeTarget = new THREE.WebGLRenderTarget(w * dpr, h * dpr, {
    colorSpace: THREE.SRGBColorSpace,
    depthBuffer: true,
    samples: 0,
  });

  // Create full-screen quad for copying textures
  copyQuad = new FullScreenQuad(
    new THREE.MeshBasicMaterial({
      depthTest: false,
      depthWrite: false,
    })
  );

  // Create groups for opaque and transparent objects
  transparentGroup = new THREE.Group();
  opaqueGroup = new THREE.Group();
  transparentGroup.visible = false; // Hidden by default (shown during peeling)
  opaqueGroup.visible = true;

  // Add groups to the scene
  app.scene.add(transparentGroup);
  app.scene.add(opaqueGroup);

  // Initialize layer targets
  for (let i = 0; i < DEFAULT_LAYERS; i++) {
    layers.push(
      new THREE.WebGLRenderTarget(w * dpr, h * dpr, {
        colorSpace: THREE.SRGBColorSpace,
        depthBuffer: true,
        samples: 0,
      })
    );
  }

  isInitialized = true;
  console.log('[DepthPeeling] Initialized');
}

/**
 * Dispose of depth peeling resources.
 */
export function disposeDepthPeeling() {
  if (!isInitialized) return;

  depthTexture?.dispose();
  depthTexture2?.dispose();
  opaqueDepthTexture?.dispose();
  renderTarget?.dispose();
  compositeTarget?.dispose();
  layers.forEach(rt => rt.dispose());
  layers.length = 0;

  if (transparentGroup) app.scene.remove(transparentGroup);
  if (opaqueGroup) app.scene.remove(opaqueGroup);

  transparentGroup = null;
  opaqueGroup = null;
  copyQuad = null;
  isInitialized = false;
  console.log('[DepthPeeling] Disposed');
}

/**
 * Update the size of depth peeling resources (e.g., on window resize).
 */
export function resizeDepthPeeling() {
  if (!isInitialized) return;

  const w = app.renderer.domElement.width || window.innerWidth;
  const h = app.renderer.domElement.height || window.innerHeight;
  const dpr = app.renderer.getPixelRatio();

  // Update depth textures
  depthTexture.image.width = w * dpr;
  depthTexture.image.height = h * dpr;
  depthTexture.dispose();

  depthTexture2.image.width = w * dpr;
  depthTexture2.image.height = h * dpr;
  depthTexture2.dispose();

  opaqueDepthTexture.image.width = w * dpr;
  opaqueDepthTexture.image.height = h * dpr;
  opaqueDepthTexture.dispose();

  // Update render targets
  renderTarget.setSize(w * dpr, h * dpr);
  compositeTarget.setSize(w * dpr, h * dpr);

  // Update layer targets
  layers.forEach(rt => rt.setSize(w * dpr, h * dpr));
}

/**
 * Add an object to the transparent group (for depth peeling).
 */
export function addToTransparentGroup(object) {
  if (!isInitialized || !transparentGroup) return;
  transparentGroup.add(object);
}

/**
 * Remove an object from the transparent group.
 */
export function removeFromTransparentGroup(object) {
  if (!isInitialized || !transparentGroup) return;
  transparentGroup.remove(object);
}

/**
 * Add an object to the opaque group (not peeled).
 */
export function addToOpaqueGroup(object) {
  if (!isInitialized || !opaqueGroup) return;
  opaqueGroup.add(object);
}

/**
 * Remove an object from the opaque group.
 */
export function removeFromOpaqueGroup(object) {
  if (!isInitialized || !opaqueGroup) return;
  opaqueGroup.remove(object);
}

/**
 * Clear all objects from both groups.
 */
export function clearDepthPeelingGroups() {
  if (!isInitialized) return;
  if (transparentGroup) {
    while (transparentGroup.children.length > 0) {
      const child = transparentGroup.children[0];
      transparentGroup.remove(child);
      app.scene.add(child); // Return to main scene
    }
  }
  if (opaqueGroup) {
    while (opaqueGroup.children.length > 0) {
      const child = opaqueGroup.children[0];
      opaqueGroup.remove(child);
      app.scene.add(child); // Return to main scene
    }
  }
}

/**
 * Update the groups based on current scene state.
 * Call this after rebuilding atoms/bonds/polyhedra.
 */
export function updateDepthPeelingGroups() {
  if (!isInitialized || !general.useDepthPeeling) {
    clearDepthPeelingGroups();
    return;
  }

  clearDepthPeelingGroups();

  // Add transparent objects to the transparent group
  const addTransparent = (obj) => {
    if (!obj) return;
    if (obj.material) {
      const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
      if (materials.some(m => m.transparent)) {
        transparentGroup.add(obj);
        return;
      }
    }
    // Check children for InstancedMesh (e.g., atoms, bonds)
    if (obj.isInstancedMesh && obj.material?.transparent) {
      transparentGroup.add(obj);
      return;
    }
    // Recursively check children
    if (obj.children) {
      obj.children.forEach(addTransparent);
    }
  };

  // Add atoms mesh if transparent
  if (groups.atomsMesh?.material?.transparent) {
    transparentGroup.add(groups.atomsMesh);
  }

  // Add bonds mesh if transparent
  if (groups.bondsMesh?.material?.transparent) {
    transparentGroup.add(groups.bondsMesh);
  }

  // Add polyhedra group (check individual polyhedra)
  if (groups.polyhedraGroup) {
    groups.polyhedraGroup.traverse((obj) => {
      if (obj.isMesh && obj.material?.transparent) {
        transparentGroup.add(obj);
      }
    });
  }

  // Add other transparent objects from the scene
  app.scene.traverse((obj) => {
    if (obj !== transparentGroup && obj !== opaqueGroup && 
        obj !== groups.atomsMesh && obj !== groups.bondsMesh && 
        obj !== groups.polyhedraGroup) {
      addTransparent(obj);
    }
  });

  // All other objects remain in the main scene (opaque)
  opaqueGroup.visible = true;
  transparentGroup.visible = false; // Will be shown during peeling
}

/**
 * Depth peel material mixer for THREE.MeshStandardMaterial and similar.
 * Adds depth peeling uniforms and shader modifications.
 */
function DepthPeelMaterialMixin(baseMaterial) {
  return class extends baseMaterial {
    constructor(...args) {
      super(...args);
      this._enableDepthPeeling = false;
      this._uniforms = {
        nearDepth: { value: null },
        opaqueDepth: { value: null },
        resolution: { value: new THREE.Vector2() },
      };
    }

    get nearDepth() {
      return this._uniforms.nearDepth.value;
    }
    set nearDepth(v) {
      this._uniforms.nearDepth.value = v;
      this.needsUpdate = true;
    }

    get opaqueDepth() {
      return this._uniforms.opaqueDepth.value;
    }
    set opaqueDepth(v) {
      this._uniforms.opaqueDepth.value = v;
    }

    get enableDepthPeeling() {
      return this._enableDepthPeeling;
    }
    set enableDepthPeeling(v) {
      if (this._enableDepthPeeling !== v) {
        this._enableDepthPeeling = v;
        this.needsUpdate = true;
      }
    }

    get resolution() {
      return this._uniforms.resolution.value;
    }

    customProgramCacheKey() {
      return `${Number(this.enableDepthPeeling)}|${Number(this.nearDepth)}`;
    }

    onBeforeCompile(shader) {
      shader.uniforms = {
        ...shader.uniforms,
        ...this._uniforms,
      };

      shader.fragmentShader = `
        #define DEPTH_PEELING ${Number(this.enableDepthPeeling)}
        #define FIRST_PASS ${Number(!this.nearDepth)}
        
        #if DEPTH_PEELING
        uniform sampler2D nearDepth;
        uniform sampler2D opaqueDepth;
        uniform vec2 resolution;
        #endif
        
        ${shader.fragmentShader}
      `.replace(
        'void main() {',
        `void main() {
          #if DEPTH_PEELING
          vec2 screenUV = gl_FragCoord.xy / resolution;
          if (texture2D(opaqueDepth, screenUV).r < gl_FragCoord.z) {
            discard;
          }
          #if !FIRST_PASS
          if (texture2D(nearDepth, screenUV).r >= gl_FragCoord.z - 1e-6) {
            discard;
          }
          #endif
          #endif
        `
      );
    }
  };
}

// Create depth peel material variants
const DepthPeelStandardMaterial = DepthPeelMaterialMixin(THREE.MeshStandardMaterial);
const DepthPeelPhysicalMaterial = DepthPeelMaterialMixin(THREE.MeshPhysicalMaterial);
const DepthPeelToonMaterial = DepthPeelMaterialMixin(THREE.MeshToonMaterial);

/**
 * Apply depth peeling material to an object.
 * Replaces the object's material with a depth-peelable version.
 */
export function applyDepthPeelMaterial(object) {
  if (!isInitialized) return;

  if (!object.material) return;

  const materials = Array.isArray(object.material) ? object.material : [object.material];
  const newMaterials = materials.map(m => {
    let PeelMaterial;
    if (m instanceof THREE.MeshStandardMaterial) {
      PeelMaterial = DepthPeelStandardMaterial;
    } else if (m instanceof THREE.MeshPhysicalMaterial) {
      PeelMaterial = DepthPeelPhysicalMaterial;
    } else if (m instanceof THREE.MeshToonMaterial) {
      PeelMaterial = DepthPeelToonMaterial;
    } else {
      // Fallback to standard
      PeelMaterial = DepthPeelStandardMaterial;
    }

    const newMat = new PeelMaterial();
    newMat.copy(m);
    newMat.transparent = true;
    newMat.depthWrite = false; // Let peeling handle depth
    return newMat;
  });

  object.material = newMaterials.length === 1 ? newMaterials[0] : newMaterials;
}

/**
 * Restore original material to an object.
 */
export function restoreOriginalMaterial(object, originalMaterial) {
  if (!object) return;
  object.material = originalMaterial;
}

/**
 * Full-screen quad helper (similar to THREE.FullScreenQuad but standalone).
 */
class FullScreenQuad {
  constructor(material) {
    this.material = material;
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3)
    );
    this.geometry.setAttribute(
      'uv',
      new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2)
    );
    this.mesh = new THREE.Mesh(this.geometry, this.material);
  }

  render(renderer) {
    this.mesh.render(renderer);
  }
}

/**
 * Perform depth peeling render pass.
 * Call this instead of renderer.render() when depth peeling is enabled.
 */
export function depthPeelRender() {
  if (!isInitialized || !app.renderer || !app.camera || !app.scene) return;

  const w = app.renderer.domElement.width || window.innerWidth;
  const h = app.renderer.domElement.height || window.innerHeight;
  const dpr = app.renderer.getPixelRatio();
  const layersCount = general.depthPeelingLayers || DEFAULT_LAYERS;

  // Ensure we have enough layers
  while (layers.length < layersCount) {
    layers.push(
      new THREE.WebGLRenderTarget(w * dpr, h * dpr, {
        colorSpace: THREE.SRGBColorSpace,
        depthBuffer: true,
        samples: 0,
      })
    );
  }
  while (layers.length > layersCount) {
    layers.pop().dispose();
  }

  // Save current state
  const clearAlpha = app.renderer.getClearAlpha();
  const clearColor = app.renderer.getClearColor ? app.renderer.getClearColor().clone() : new THREE.Color();

  // Render opaque objects first
  opaqueGroup.visible = true;
  transparentGroup.visible = false;
  renderTarget.depthTexture = opaqueDepthTexture;
  app.renderer.setRenderTarget(renderTarget);
  app.renderer.render(app.scene, app.camera);
  app.renderer.setRenderTarget(null);

  // Copy opaque layer to screen
  copyQuad.material.map = renderTarget.texture;
  copyQuad.material.blending = THREE.NoBlending;
  copyQuad.material.transparent = false;
  copyQuad.material.depthTest = false;
  copyQuad.material.depthWrite = false;
  copyQuad.render(app.renderer);
  renderTarget.depthTexture = null;

  // Perform depth peeling for transparent objects
  for (let i = 0; i < layersCount; i++) {
    opaqueGroup.visible = false;
    transparentGroup.visible = true;

    const depthTextures = [depthTexture, depthTexture2];
    const writeDepthTexture = depthTextures[(i + 1) % 2];
    const nearDepthTexture = depthTextures[i % 2];

    // Update materials for depth peeling
    transparentGroup.traverse(({ material }) => {
      if (material) {
        const materials = Array.isArray(material) ? material : [material];
        materials.forEach(m => {
          if (m.enableDepthPeeling !== undefined) {
            m.enableDepthPeeling = true;
            m.opaqueDepth = opaqueDepthTexture;
            m.nearDepth = i === 0 ? null : nearDepthTexture;
            m.blending = THREE.CustomBlending;
            m.blendDst = THREE.ZeroFactor;
            m.blendSrc = THREE.OneFactor;
            m.depthWrite = true;
            m.opacity = general.transparencyOpacity !== undefined 
              ? general.transparencyOpacity 
              : 0.5;
            m.side = general.doubleSidedTransparency ? THREE.DoubleSide : THREE.FrontSide;
            m.forceSinglePass = true;
            app.renderer.getDrawingBufferSize(m.resolution);
          }
        });
      }
    });

    // Render to layer
    const currTarget = layers[i];
    currTarget.depthTexture = writeDepthTexture;
    app.renderer.setRenderTarget(currTarget);
    app.renderer.setClearColor(0, 0);
    app.renderer.render(app.scene, app.camera);
    app.renderer.setRenderTarget(null);
  }

  // Restore clear color
  if (app.renderer.setClearColor) {
    app.renderer.setClearColor(clearColor, clearAlpha);
  }

  // Composite layers (back to front)
  for (let i = layersCount - 1; i >= 0; i--) {
    app.renderer.autoClear = false;
    layers[i].depthTexture = null;
    copyQuad.material.map = layers[i].texture;
    copyQuad.material.blending = THREE.NormalBlending;
    copyQuad.material.transparent = true;
    copyQuad.material.depthTest = false;
    copyQuad.material.depthWrite = false;
    copyQuad.render(app.renderer);
  }

  app.renderer.autoClear = true;

  // Reset visibility
  opaqueGroup.visible = true;
  transparentGroup.visible = false;
}

/**
 * Standard render (no depth peeling).
 */
export function standardRender() {
  if (!isInitialized) {
    app.renderer.render(app.scene, app.camera);
    return;
  }

  // Reset materials for standard rendering
  transparentGroup.traverse(({ material }) => {
    if (material) {
      const materials = Array.isArray(material) ? material : [material];
      materials.forEach(m => {
        if (m.enableDepthPeeling !== undefined) {
          m.enableDepthPeeling = false;
          m.opaqueDepth = null;
          m.nearDepth = null;
          m.blending = THREE.NormalBlending;
          m.depthWrite = false;
          m.opacity = general.transparencyOpacity !== undefined 
            ? general.transparencyOpacity 
            : 0.5;
          m.side = general.doubleSidedTransparency ? THREE.DoubleSide : THREE.FrontSide;
          m.forceSinglePass = false;
        }
      });
    }
  });

  opaqueGroup.visible = true;
  transparentGroup.visible = true;
  app.renderer.render(app.scene, app.camera);
}

/**
 * Check if depth peeling is enabled and initialized.
 */
export function isDepthPeelingEnabled() {
  return isInitialized && general.useDepthPeeling;
}
