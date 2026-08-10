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
  banner.className = 'cv-warning-banner cv-scanline-warning';
  banner.textContent = 'A wild 8-BIT MODE appeared! Press Alt+8 to flee';
  view.appendChild(banner);
  return banner;
}

export function setScanlineBannerVisible(visible) {
  const el = ensureBanner();
  if (!el) return;
  el.style.display = visible ? 'block' : 'none';
}
