export function createColorPicker(initialHex, onChange) {
  // --- Utility Functions ---
  function rgbToString({ r, g, b }) {
    return `${r}, ${g}, ${b}`;
  }

  function rgbToHex({ r, g, b }) {
    const toHex = n => n.toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
  }

  function hexToRgb(hex) {
    if (typeof hex !== 'string') return null;
    hex = hex.trim().replace(/^#/, '');
    if (hex.length === 3) {
      hex = hex.split('').map(c => c + c).join('');
    }
    if (hex.length !== 6) return null;
    const num = parseInt(hex, 16);
    if (isNaN(num)) return null;
    return {
      r: (num >> 16) & 255,
      g: (num >> 8) & 255,
      b: num & 255
    };
  }

  function parseRgbString(str) {
    const parts = str.split(',').map(s => parseInt(s.trim()));
    if (parts.length !== 3 || parts.some(n => isNaN(n) || n < 0 || n > 255)) return null;
    return { r: parts[0], g: parts[1], b: parts[2] };
  }

  function hsvToRgb(h, s, v) {
    let c = v * s;
    let x = c * (1 - Math.abs((h / 60) % 2 - 1));
    let m = v - c;
    let r = 0, g = 0, b = 0;
    if (h < 60) [r, g, b] = [c, x, 0];
    else if (h < 120) [r, g, b] = [x, c, 0];
    else if (h < 180) [r, g, b] = [0, c, x];
    else if (h < 240) [r, g, b] = [0, x, c];
    else if (h < 300) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];
    return {
      r: Math.round((r + m) * 255),
      g: Math.round((g + m) * 255),
      b: Math.round((b + m) * 255)
    };
  }

  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d !== 0) {
      switch (max) {
        case r: h = ((g - b) / d + (g < b ? 6 : 0)) * 60; break;
        case g: h = ((b - r) / d + 2) * 60; break;
        case b: h = ((r - g) / d + 4) * 60; break;
      }
    }
    const s = max === 0 ? 0 : d / max;
    const v = max;
    return { h, s, v };
  }

  // --- Default & Initial Values ---
  //const fallbackHex = '#FF0000';
  //if (typeof initialHex !== 'string') {
   //   console.warn('Invalid initialHex value. Using fallback.');
   // initialHex = fallbackHex;
 // }

  const initialRgb = hexToRgb(initialHex) || hexToRgb("#FF0000");
  let hsv = rgbToHsv(initialRgb.r, initialRgb.g, initialRgb.b);
  let rgb = initialRgb;

  // --- Dimensions ---
  const WIDTH = 200;
  const HEIGHT = 150;
  const HUE_WIDTH = 30;

  // --- Create DOM elements ---
  const container = document.createElement('div');
  container.style.display = 'inline-flex';
  container.style.flexDirection = 'column';
  container.style.width = WIDTH + 'px';
  container.style.fontFamily = 'sans-serif';
  container.style.userSelect = 'none';

  const svCanvas = document.createElement('canvas');
  svCanvas.width = WIDTH - HUE_WIDTH;
  svCanvas.height = HEIGHT;
  svCanvas.style.cursor = 'crosshair';
  svCanvas.style.userSelect = 'none';

  const svCtx = svCanvas.getContext('2d');

  const hueCanvas = document.createElement('canvas');
  hueCanvas.width = HUE_WIDTH;
  hueCanvas.height = HEIGHT;
  hueCanvas.style.cursor = 'ns-resize';
  hueCanvas.style.marginLeft = '4px';
  hueCanvas.style.userSelect = 'none';
  const hueCtx = hueCanvas.getContext('2d');

  const canvasWrapper = document.createElement('div');
  canvasWrapper.style.display = 'flex';
  canvasWrapper.appendChild(svCanvas);
  canvasWrapper.appendChild(hueCanvas);

  container.appendChild(canvasWrapper);

  // Input wrappers
  const inputsWrapper = document.createElement('div');
  inputsWrapper.style.cssText = 'display: flex; flex-direction: column; gap: 4px; margin-top: 6px;';

  // RGB input row
  const rgbRow = document.createElement('div');
  rgbRow.style.cssText = 'display: flex; align-items: center; gap: 4px;';

  const rgbLabel = document.createElement('label');
  rgbLabel.textContent = 'RGB:';
  rgbLabel.style.cssText = 'font-size: 12px; color: #ccc; min-width: 30px;';

  const rgbInput = document.createElement('input');
  rgbInput.type = 'text';
  rgbInput.placeholder = '255,128,64';
  rgbInput.style.cssText = 'flex: 1; padding: 2px 4px; font-size: 12px;';

  // HEX input row
  const hexRow = document.createElement('div');
  hexRow.style.cssText = 'display: flex; align-items: center; gap: 4px;';

  const hexLabel = document.createElement('label');
  hexLabel.textContent = 'HEX:';
  hexLabel.style.cssText = 'font-size: 12px; color: #ccc; min-width: 30px;';

  const hexInput = document.createElement('input');
  hexInput.type = 'text';
  hexInput.placeholder = '#ffcc00';
  hexInput.style.cssText = 'flex: 1; padding: 2px 4px; font-size: 12px;';




  rgbRow.appendChild(rgbLabel);
  rgbRow.appendChild(rgbInput);

  hexRow.appendChild(hexLabel);
  hexRow.appendChild(hexInput);

  inputsWrapper.appendChild(rgbRow);
  inputsWrapper.appendChild(hexRow);
  container.appendChild(inputsWrapper);


  // --- Rendering Functions ---
  function drawHue() {
    const hueGradient = hueCtx.createLinearGradient(0, 0, 0, HEIGHT);
    for (let i = 0; i <= 360; i += 10) {
      hueGradient.addColorStop(i / 360, `hsl(${i}, 100%, 50%)`);
    }
    hueCtx.fillStyle = hueGradient;
    hueCtx.fillRect(0, 0, HUE_WIDTH, HEIGHT);
  }

  function drawSV() {
    const satGradient = svCtx.createLinearGradient(0, 0, svCanvas.width, 0);
    satGradient.addColorStop(0, 'white');
    satGradient.addColorStop(1, `hsl(${hsv.h}, 100%, 50%)`);
    svCtx.fillStyle = satGradient;
    svCtx.fillRect(0, 0, svCanvas.width, svCanvas.height);

    const valGradient = svCtx.createLinearGradient(0, 0, 0, svCanvas.height);
    valGradient.addColorStop(0, 'rgba(0,0,0,0)');
    valGradient.addColorStop(1, 'black');
    svCtx.fillStyle = valGradient;
    svCtx.fillRect(0, 0, svCanvas.width, svCanvas.height);
  }

  function drawCursors() {
    const x = hsv.s * svCanvas.width;
    const y = (1 - hsv.v) * svCanvas.height;

    // SV cursor
    svCtx.strokeStyle = 'white';
    svCtx.lineWidth = 2;
    svCtx.beginPath();
    svCtx.arc(x, y, 8, 0, 2 * Math.PI);
    svCtx.stroke();

    svCtx.strokeStyle = 'black';
    svCtx.lineWidth = 1;
    svCtx.beginPath();
    svCtx.arc(x, y, 7, 0, 2 * Math.PI);
    svCtx.stroke();

    // Hue cursor
    const hy = (hsv.h / 360) * hueCanvas.height;
    hueCtx.strokeStyle = 'white';
    hueCtx.lineWidth = 2;
    hueCtx.beginPath();
    hueCtx.rect(0, hy - 3, HUE_WIDTH, 6);
    hueCtx.stroke();
    hueCtx.strokeStyle = 'black';
    hueCtx.lineWidth = 1;
    hueCtx.beginPath();
    hueCtx.rect(0, hy - 2, HUE_WIDTH, 4);
    hueCtx.stroke();
  }

  function render() {
    drawHue();
    drawSV();
    drawCursors();
  }

  // --- Color Update Logic ---
  function updateColorFromHSV() {
    rgb = hsvToRgb(hsv.h, hsv.s, hsv.v);
    updateInputsFromRGB(rgb);
    onChange(rgbToHex(rgb));
  }

  function updateInputsFromRGB(rgb) {
    rgbInput.value = rgbToString(rgb);
    hexInput.value = rgbToHex(rgb);
  }

  // --- Event Handlers ---
  function svPointerEvent(e) {
    const rect = svCanvas.getBoundingClientRect();
    let sx = e.clientX - rect.left;
    let sy = e.clientY - rect.top;
    hsv.s = Math.max(0, Math.min(1, sx / svCanvas.width));
    hsv.v = Math.max(0, Math.min(1, 1 - sy / svCanvas.height));
    updateColorFromHSV();
    render();
  }

  function huePointerEvent(e) {
    const rect = hueCanvas.getBoundingClientRect();
    let hy = e.clientY - rect.top;
    hsv.h = Math.max(0, Math.min(360, (hy / hueCanvas.height) * 360));
    updateColorFromHSV();
    render();
  }

  svCanvas.addEventListener('pointerdown', e => {
    svPointerEvent(e);
    const move = e => svPointerEvent(e);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  hueCanvas.addEventListener('pointerdown', e => {
    huePointerEvent(e);
    const move = e => huePointerEvent(e);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });


  svCanvas.addEventListener('touchstart', e => e.preventDefault(), { passive: false });
  svCanvas.addEventListener('touchmove', e => e.preventDefault(), { passive: false });

  hueCanvas.addEventListener('touchstart', e => e.preventDefault(), { passive: false });
  hueCanvas.addEventListener('touchmove', e => e.preventDefault(), { passive: false });

  rgbInput.addEventListener('change', () => {
    const parsed = parseRgbString(rgbInput.value);
    if (!parsed) return;
    hsv = rgbToHsv(parsed.r, parsed.g, parsed.b);
    updateColorFromHSV();
    render();
  });

  hexInput.addEventListener('change', () => {
    const parsed = hexToRgb(hexInput.value);
    if (!parsed) return;
    hsv = rgbToHsv(parsed.r, parsed.g, parsed.b);
    updateColorFromHSV();
    render();
  });

  // --- Initial Render ---
  updateInputsFromRGB(rgb);
  render();

  return {
  element: container,
  getHex: () => rgbToHex(rgb),
  getRgb: () => ({ ...rgb }),
  setHex: (hexStr) => {
    const parsed = hexToRgb(hexStr);
    if (!parsed) return;
    hsv = rgbToHsv(parsed.r, parsed.g, parsed.b);
    updateColorFromHSV();
    render();
  }
};
}
