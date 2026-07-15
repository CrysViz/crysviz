// Central directory of the color-bar widgets each panel (ForcePanel,
// SpinPanel, ColorPanel's Atoms/Bonds bars) may currently have on screen.
// render/ImageExportModule.js uses this to offer a checkbox per active bar
// and to redraw the checked ones onto the exported PNG, without needing to
// import each panel module directly (and without those panels needing to
// know anything about export).
//
// A panel registers ONCE, at module load, with a getter that reads its own
// module-scope instance variable — that variable's value changes many times
// over the app's life (colormap switches, mode switches, panel rebuilds all
// tear down and recreate the widget), but the getter closure always reads
// whatever it currently holds, so one registration call covers the whole
// lifecycle.

const sources = new Map();

/**
 * @param {string} id stable key (e.g. "force", "atom")
 * @param {string} label shown next to the export checkbox (e.g. "Force (eV/Å)")
 * @param {() => (ReturnType<typeof import('./ColorBarWidget.js').createColorBar> | null)} getInstance
 */
export function registerColorBarSource(id, label, getInstance) {
  sources.set(id, { label, getInstance });
}

/** Bars that are actually showing right now, for building export checkboxes
 *  and for the export's own redraw pass. */
export function listActiveColorBars() {
  const out = [];
  for (const [id, { label, getInstance }] of sources) {
    const instance = getInstance();
    if (instance) out.push({ id, label, instance });
  }
  return out;
}
