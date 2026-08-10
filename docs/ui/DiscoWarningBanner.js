// Top-center banner over the 3D view (#view), shown while Disco Mode
// (Ctrl+D held, see render/AnimateModule.js + ui/DiscoModule.js) is active.
// Stacked below the Forces+Spins and Polyhedra-comparison banners (top: 71px)
// so all three can be visible at once without overlapping.
// Reactive: call setDiscoWarningVisible(bool) from DiscoModule.js's
// startDisco()/stopDisco(), the only place disco mode turns on/off.

let banner = null;

function ensureBanner() {
  if (banner) return banner;
  const view = document.getElementById('view');
  if (!view) return null;

  banner = document.createElement('div');
  banner.className = 'cv-warning-banner cv-disco-warning';
  banner.textContent = 'Time to disco! Release Ctrl+D to restore colors';
  view.appendChild(banner);
  return banner;
}

export function setDiscoWarningVisible(visible) {
  const el = ensureBanner();
  if (!el) return;
  el.style.display = visible ? 'block' : 'none';
}
