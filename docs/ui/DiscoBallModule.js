// A hand-drawn (SVG, not a photo/import) mirror ball that drops down from
// above the 3D view (#view) while Disco Mode is active, then retracts when
// it ends. Purely decorative — no scene/render-pipeline involvement.

let wrap = null;

function ensureBall() {
  if (wrap) return wrap;
  const view = document.getElementById('view');
  if (!view) return null;

  const styleEl = document.createElement('style');
  styleEl.textContent = `
    .cv-disco-ball-wrap {
      position: absolute;
      left: 50%;
      top: -160px;
      transform: translateX(-50%);
      transition: top 0.9s cubic-bezier(0.32, 1.4, 0.64, 1);
      z-index: 1999;
      pointer-events: none;
    }
    .cv-disco-ball-wrap.visible {
      top: 0px;
    }
    .cv-disco-ball-spin {
      transform-box: fill-box;
      transform-origin: 50% 50%;
      animation: cv-disco-spin 4s linear infinite;
      animation-play-state: paused;
    }
    .cv-disco-ball-wrap.visible .cv-disco-ball-spin {
      animation-play-state: running;
    }
    @keyframes cv-disco-spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
  `;
  document.head.appendChild(styleEl);

  wrap = document.createElement('div');
  wrap.className = 'cv-disco-ball-wrap';
  wrap.innerHTML = `
    <svg viewBox="0 0 100 140" width="90" height="126">
      <line x1="50" y1="0" x2="50" y2="22" stroke="#8a8a8a" stroke-width="2"/>
      <rect x="44" y="18" width="12" height="7" rx="1.5" fill="#5a5a5a"/>
      <g class="cv-disco-ball-spin">
        <defs>
          <radialGradient id="cvDiscoBallGrad" cx="35%" cy="30%" r="75%">
            <stop offset="0%" stop-color="#f7f7f7"/>
            <stop offset="45%" stop-color="#cfd4d8"/>
            <stop offset="100%" stop-color="#6a7075"/>
          </radialGradient>
          <pattern id="cvDiscoBallFacets" width="9" height="9" patternUnits="userSpaceOnUse">
            <rect width="9" height="9" fill="none" stroke="#8b9296" stroke-width="0.6"/>
          </pattern>
        </defs>
        <circle cx="50" cy="70" r="42" fill="url(#cvDiscoBallGrad)"/>
        <circle cx="50" cy="70" r="42" fill="url(#cvDiscoBallFacets)" opacity="0.55"/>
        <circle cx="35" cy="52" r="9" fill="#ffffff" opacity="0.5"/>
        <circle cx="63" cy="86" r="4" fill="#ffffff" opacity="0.3"/>
      </g>
    </svg>
  `;
  view.appendChild(wrap);
  return wrap;
}

export function showDiscoBall() {
  const el = ensureBall();
  if (!el) return;
  el.classList.add('visible');
}

export function hideDiscoBall() {
  const el = ensureBall();
  if (!el) return;
  el.classList.remove('visible');
}
