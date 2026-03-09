export function createColorPicker({ onChange }) {
  const container = document.createElement('div');
  container.className = 'custom-color-picker-2d';

  const canvas = document.createElement('canvas');
  canvas.width = 200;
  canvas.height = 150;
  canvas.style.cursor = 'crosshair';

  const preview = document.createElement('div');
  preview.className = 'color-preview';
  preview.style.marginTop = '10px';

  container.appendChild(canvas);
  container.appendChild(preview);

  const ctx = canvas.getContext('2d');

  // Render the 2D gradient: hue (x) + brightness (y)
  function renderGradient() {
    const width = canvas.width;
    const height = canvas.height;

    // 1. Create hue gradient horizontally
    const hueGradient = ctx.createLinearGradient(0, 0, width, 0);
    for (let i = 0; i <= 360; i += 60) {
      hueGradient.addColorStop(i / 360, `hsl(${i}, 100%, 50%)`);
    }

    ctx.fillStyle = hueGradient;
    ctx.fillRect(0, 0, width, height);

    // 2. Overlay brightness gradient vertically
    const brightnessGradient = ctx.createLinearGradient(0, 0, 0, height);
    brightnessGradient.addColorStop(0, 'rgba(255,255,255,0)');
    brightnessGradient.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.fillStyle = brightnessGradient;
    ctx.fillRect(0, 0, width, height);
  }

  function getColorAt(x, y) {
    const pixel = ctx.getImageData(x, y, 1, 1).data;
    const [r, g, b] = pixel;
    const rgb = `rgb(${r}, ${g}, ${b})`;
    const hex = rgbToHex(r, g, b);
    return { r, g, b, rgb, hex };
  }

  function rgbToHex(r, g, b) {
    const toHex = (n) => n.toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }

  function handlePick(e) {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const { rgb, hex } = getColorAt(x, y);
    preview.style.background = rgb;
    if (onChange) onChange({ rgb, hex });
  }

  canvas.addEventListener('mousedown', (e) => {
    handlePick(e);

    const move = (e) => handlePick(e);
    const stop = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', stop);
    };

    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', stop);
  });

  renderGradient();

  return container;
}

