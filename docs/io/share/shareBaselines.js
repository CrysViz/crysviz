// Frozen settings baselines and the short-key table for compact share links
// (docs/io/share/shareCodec.js, ShareURLPlan.md section 2.6).
//
// A compact link only writes the settings that differ from the baseline it
// names (its `b` field); the decoder fills every other setting from that same
// baseline. Baseline 1 is the settings part of captureState() taken from a
// FRESHLY BOOTED app (tools/browsertest/gen_share_fixtures.js writes it to
// tools/unittest/fixtures/share/baseline.json). It is not store.js: boot
// overwrites some store constants from the slider markup.
//
// RULES — links live forever (QR codes on posters), so:
//   * Never edit an existing baseline. When a default changes, the guard test
//     tools/browsertest/tests/sharebaseline.test.js fails; add baseline N+1
//     (a copy with the new values) and bump LATEST_BASELINE_ID.
//   * SETTING_KEYS is append-only. Never reuse or re-point a short key; a
//     removed setting keeps its entry so old links still parse.
//   * A setting captureState() emits without a short key still round-trips
//     through the codec's `X` escape hatch, and the unit tests flag it.

/** @typedef {{ colors: Record<string, any>, display: Record<string, any>, style: Record<string, any> }} SettingsBaseline */

function deepFreeze(o) {
  if (o && typeof o === 'object') {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

/** @type {Readonly<Record<number, SettingsBaseline>>} */
export const BASELINES = deepFreeze({
  1: {
    colors: {
      useDefaultColors: true,
      elementMaterialsMap: 'standard'
    },
    display: {
      atomSize: 0.399903512,
      bondRadius: 0.100003595,
      showAtoms: true,
      showBonds: true,
      showCharges: false,
      showLattice: true,
      showPeriodic: true,
      linkPeriodicCopies: true,
      periodicFaceTol: 0.001,
      periodicBounds: {
        xmin: 0,
        xmax: 1,
        ymin: 0,
        ymax: 1,
        zmin: 0,
        zmax: 1
      },
      showPBCBonds: false,
      showAxes: true,
      showPolyhedra: false,
      completePolyhedra: false,
      axesLineWidth: 0.015,
      latticeLineWidth: 0.015,
      forcesActive: false,
      forceScale: 1,
      forceRadius: 0.08,
      forceMin: 0,
      forceMax: 2,
      forceColorScale: 'linear',
      forceLengthLogScale: false,
      forceColorMap: 'heatmap',
      spinsActive: false,
      spinScale: 1,
      spinRadius: 0.08,
      spinMin: 0,
      spinMax: 2,
      spinColorScale: 'linear',
      spinLengthLogScale: false,
      spinColorMap: 'none'
    },
    style: {
      renderStyle: 'metallic',
      renderPipeline: 'depthpeel',
      depthPeelLayers: 15,
      rtResolutionScale: 0.95,
      rtTiledRender: true,
      rtRasterPreview: true,
      rtBackgroundMatch: true,
      rtToneMapLegacy: false,
      rtReflectivity: 0.15,
      ptDenoise: true,
      ptLightSoftness: 0.3,
      rtDofAperture: 0,
      rtDofFocus: 1,
      rtGroundPlane: false,
      rtGroundPattern: 'solid',
      rtGroundColor1: null,
      rtGroundColor2: null,
      rtGroundScale: 2,
      rtGroundOffset: 0.75,
      rtGroundSize: 2.5,
      rtGroundReflect: 0,
      rtLightIntensity: 1.2,
      rtAmbient: 0.3,
      rtSaturation: 1,
      celOutlineWidth: 0.025,
      celHullWidth: 0.025,
      celOutlineColorMode: 'auto',
      celOutlineColor: '#000000',
      polyEdgeWidth: 1,
      atomsColor: 'elements',
      bondsColor: 'elements',
      background: '#ffffff'
    }
  },
});

export const LATEST_BASELINE_ID = 1;

/**
 * [settings path, short key] — append-only (see RULES above).
 * @type {ReadonlyArray<readonly [string, string]>}
 */
export const SETTING_KEYS = deepFreeze([
  ['colors.useDefaultColors', 'ud'],
  ['colors.elementMaterialsMap', 'em'],
  ['display.atomSize', 'as'],
  ['display.bondRadius', 'br'],
  ['display.showAtoms', 'sa'],
  ['display.showBonds', 'sb'],
  ['display.showCharges', 'sq'],
  ['display.showLattice', 'sl'],
  ['display.showPeriodic', 'sp'],
  ['display.linkPeriodicCopies', 'lp'],
  ['display.periodicFaceTol', 'pt'],
  ['display.periodicBounds', 'pb'],
  ['display.showPBCBonds', 'pc'],
  ['display.showAxes', 'sx'],
  ['display.showPolyhedra', 'sh'],
  ['display.completePolyhedra', 'ch'],
  ['display.axesLineWidth', 'aw'],
  ['display.latticeLineWidth', 'lw'],
  ['display.forcesActive', 'fa'],
  ['display.forceScale', 'fs'],
  ['display.forceRadius', 'fr'],
  ['display.forceMin', 'fn'],
  ['display.forceMax', 'fx'],
  ['display.forceColorScale', 'fc'],
  ['display.forceLengthLogScale', 'fl'],
  ['display.forceColorMap', 'fm'],
  ['display.spinsActive', 'na'],
  ['display.spinScale', 'ns'],
  ['display.spinRadius', 'nr'],
  ['display.spinMin', 'nn'],
  ['display.spinMax', 'nx'],
  ['display.spinColorScale', 'nc'],
  ['display.spinLengthLogScale', 'nl'],
  ['display.spinColorMap', 'nm'],
  ['style.renderStyle', 'rs'],
  ['style.renderPipeline', 'rp'],
  ['style.depthPeelLayers', 'dl'],
  ['style.rtResolutionScale', 'rr'],
  ['style.rtTiledRender', 'rt'],
  ['style.rtRasterPreview', 'rv'],
  ['style.rtBackgroundMatch', 'rb'],
  ['style.rtToneMapLegacy', 'rl'],
  ['style.rtReflectivity', 'rf'],
  ['style.ptDenoise', 'pd'],
  ['style.ptLightSoftness', 'ps'],
  ['style.rtDofAperture', 'da'],
  ['style.rtDofFocus', 'df'],
  ['style.rtGroundPlane', 'gp'],
  ['style.rtGroundPattern', 'gt'],
  ['style.rtGroundColor1', 'g1'],
  ['style.rtGroundColor2', 'g2'],
  ['style.rtGroundScale', 'gs'],
  ['style.rtGroundOffset', 'go'],
  ['style.rtGroundSize', 'gz'],
  ['style.rtGroundReflect', 'gr'],
  ['style.rtLightIntensity', 'li'],
  ['style.rtAmbient', 'ra'],
  ['style.rtSaturation', 'su'],
  ['style.celOutlineWidth', 'cw'],
  ['style.celHullWidth', 'cu'],
  ['style.celOutlineColorMode', 'cm'],
  ['style.celOutlineColor', 'cc'],
  ['style.polyEdgeWidth', 'pw'],
  ['style.atomsColor', 'ac'],
  ['style.bondsColor', 'bc'],
  ['style.background', 'bg'],
]);

/**
 * captureState() keys that are derived from the structure (per-species or
 * per-atom tables) or are per-structure style stores. They never come from a
 * baseline: the codec writes them explicitly (species tables always, stores
 * and per-atom maps when non-empty).
 */
export const STRUCTURE_DERIVED_KEYS = deepFreeze([
  'colors.atomColors', 'colors.elementColors', 'colors.atomOpacities', 'colors.atomRadiusScales',
  'colors.atomImageStyles', 'colors.bondUserStyles', 'colors.bondCategoryStyles',
  'colors.polyhedraUserStyles', 'colors.polyhedraCategoryStyles', 'colors.atomMaterials',
  'colors.atomUserMaterials', 'colors.spinCategoryStyles', 'colors.forceCategoryStyles',
  'colors.fieldMaterial',
  'display.bondLengths', 'display.bondVisibility', 'display.atomVisibility',
  'display.bondCutImmunity', 'display.focusRegions', 'display.spinSpeciesVisibility',
]);
