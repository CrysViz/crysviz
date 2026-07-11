// Shared lazy Plotly loader. Plotly is heavy (~1MB) so it is only fetched
// the first time any plot actually draws, and the promise is memoized so
// every caller (EOS plots, the bond-length/coordination histograms, ...)
// shares the same in-flight/loaded module instead of double-fetching it.

const PLOTLY_MODULE_URL = 'https://esm.sh/plotly.js-dist-min@2.27.0';

let plotlyPromise = null;
export function loadPlotly() {
  if (!plotlyPromise) {
    plotlyPromise = import(PLOTLY_MODULE_URL).then((m) => m.default || m);
  }
  return plotlyPromise;
}
