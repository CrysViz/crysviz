// Top-center banner over the 3D view (#view), shown while scanline mode
// (Alt+8, see render/ScanlinePass.js) is active. Shares the Polyhedra-
// comparison banner's slot (top: 38px) rather than stacking below Disco's —
// scanline mode is unlikely to coincide with either, and sitting higher keeps
// it readable without drifting down the view.
// Reactive: call setScanlineBannerVisible(bool) from ScanlinePass.js's
// toggleScanlineMode(), the only place scanline mode turns on/off.

let banner = null;

function ensureBanner() {
  if (banner) return banner;
  const view = document.getElementById('view');
  if (!view) return null;

  banner = document.createElement('div');
  banner.className = 'cv-scanline-warning';
  banner.textContent = 'A wild 8-BIT MODE appeared! Press Alt+8 to flee';
  banner.style.cssText = `
    position: absolute;
    top: 38px;
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

export function setScanlineBannerVisible(visible) {
  const el = ensureBanner();
  if (!el) return;
  el.style.display = visible ? 'block' : 'none';
}
