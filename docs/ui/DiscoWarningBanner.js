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
  banner.className = 'cv-disco-warning';
  banner.textContent = 'Time to disco! Release Ctrl+D to restore colors';
  banner.style.cssText = `
    position: absolute;
    top: 71px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 2000;
    padding: 6px 14px;
    border-radius: 6px;
    background: rgba(40, 30, 0, 0.85);
    border: 1px solid rgba(255, 193, 7, 0.6);
    color: #ffc107;
    font-size: 12px;
    font-family: inherit;
    font-weight: 500;
    white-space: nowrap;
    pointer-events: none;
    display: none;
  `;
  view.appendChild(banner);
  return banner;
}

export function setDiscoWarningVisible(visible) {
  const el = ensureBanner();
  if (!el) return;
  el.style.display = visible ? 'block' : 'none';
}
