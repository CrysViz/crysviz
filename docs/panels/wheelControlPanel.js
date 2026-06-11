// CameraWheel Class
function CameraWheel(config) {
  const {
    modes = [],
    size = 200,
    steps = 4,
    visiblePortion = 1.0,
    innerCircleRatio = 0.48,
    symbolRadiusRatio = 0.70,
    onModeChange = () => {}
  } = config;

  if (modes.length < 2 || modes.length > 9) {
    throw new Error('CameraWheel: Requires 2-8 modes');
  }

  const container = document.createElement('div');
  container.className = 'camera-wheel-wrapper';

  const viewport = document.createElement('div');
  viewport.className = 'camera-wheel-viewport';
  viewport.style.width = `${size * visiblePortion}px`;
  viewport.style.height = `${size}px`;

  const wheelContainer = document.createElement('div');
  wheelContainer.className = 'camera-wheel';
  wheelContainer.style.width = `${size}px`;
  wheelContainer.style.height = `${size}px`;
  wheelContainer.style.left = `calc(-${size}px * ${1 - visiblePortion})`;

  const outerRing = document.createElement('div');
  outerRing.className = 'camera-wheel-outer-ring';
  wheelContainer.appendChild(outerRing);

  const wheelEl = document.createElement('div');
  wheelEl.id = 'camera-wheel';
  wheelEl.style.transform = 'rotate(0deg)';
  wheelContainer.appendChild(wheelEl);

  const innerCircle = document.createElement('div');
  innerCircle.className = 'camera-wheel-inner';
  const innerInset = size * (1 - innerCircleRatio) / 2;
  innerCircle.style.inset = `${innerInset}px`;
  innerCircle.innerHTML = `<span>${modes[0].name}</span>`;
  wheelContainer.appendChild(innerCircle);

  const indicator = document.createElement('div');
  indicator.className = 'camera-wheel-indicator';
  wheelContainer.appendChild(indicator);

  const triangle = document.createElement('div');
  triangle.className = 'camera-wheel-triangle';
  wheelContainer.appendChild(triangle);

  viewport.appendChild(wheelContainer);
  container.appendChild(viewport);

  const angleStep = 360 / modes.length;
  const wheelRadius = size / 2;
  const symbolRadius = wheelRadius * symbolRadiusRatio;
  let rotation = 0;
  let selectedMode = 0;
  let isDragging = false;
  let startAngle = 0;
  let rafId = null;

  function animateTo(targetRotation, callback) {
    const startRot = rotation;
    const delta = (targetRotation - startRot + 180) % 360 - 180;
    let startTime = null;

    const animate = (ts) => {
      if (!startTime) startTime = ts;
      const progress = Math.min((ts - startTime) / 300, 1);
      const easeOut = 1 - Math.pow(1 - progress, 5);
      rotation = startRot + delta * easeOut;
      wheelEl.style.transform = `rotate(${rotation}deg)`;

      if (progress < 1) {
        rafId = requestAnimationFrame(animate);
      } else {
        rotation = targetRotation;
        wheelEl.style.transition = 'transform 0.1s linear';
        callback?.();
      }
    };
    rafId = requestAnimationFrame(animate);
  }

  function updateCenter() {
    innerCircle.innerHTML = `<span>${modes[selectedMode].name}</span>`;
    onModeChange(modes[selectedMode]);
  }

  // Add keyboard shortcuts (case-sensitive)
  function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      // Skip if typing in an input field
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      // Check for mode shortcuts (case-sensitive)
      for (let i = 0; i < modes.length; i++) {
        const mode = modes[i];
        if (mode.shortcut && e.key === mode.shortcut) {
          e.preventDefault();
          const delta = (i - selectedMode + modes.length) % modes.length;
          animateTo(rotation + delta * angleStep, () => {
            rotation = i * angleStep;
            selectedMode = i;
            updateCenter();
          });
          return;
        }
      }

      // Check for number keys (1-7)
      if (e.key >= '1' && e.key <= '7') {
        const index = parseInt(e.key) - 1;
        if (index >= 0 && index < modes.length) {
          e.preventDefault();
          const delta = (index - selectedMode + modes.length) % modes.length;
          animateTo(rotation + delta * angleStep, () => {
            rotation = index * angleStep;
            selectedMode = index;
            updateCenter();
          });
        }
      }
    });
  }

  modes.forEach((mode, index) => {
    const iconContainer = document.createElement('div');
    iconContainer.className = 'camera-wheel-icon';

    const angle = -index * angleStep;
    const angleRad = (angle * Math.PI) / 180;
    const x = symbolRadius * Math.cos(angleRad);
    const y = symbolRadius * Math.sin(angleRad);

    iconContainer.style.left = `calc(50% + ${x}px)`;
    iconContainer.style.top = `calc(50% + ${y}px)`;
    iconContainer.style.transform = `translate(-50%, -50%) rotate(${angle}deg)`;

    function renderIcon(icon) {
      if (typeof icon === 'string' && icon.trim().endsWith('.svg')) {
        return `<img src="${icon}" style="width: 24px; height: 24px;" alt="Icon" />`;
      }
      return icon;
    }

    iconContainer.innerHTML = `
      <div style="width: 24px; height: 24px; display: flex; align-items: center; justify-content: center;">
        ${renderIcon(mode.icon)}
      </div>
    `;

    iconContainer.addEventListener('click', (e) => {
      e.stopPropagation();
      const delta = (index - selectedMode + modes.length) % modes.length;
      animateTo(rotation + delta * angleStep, () => {
        rotation = index * angleStep;
        selectedMode = index;
        updateCenter();
      });
    });

    wheelEl.appendChild(iconContainer);
  });

  const handleStart = (e) => {
    isDragging = true;
    const rect = wheelEl.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    startAngle = Math.atan2(clientY - cy, clientX - cx);
    cancelAnimationFrame(rafId);
    wheelEl.style.transition = 'none';
    e.preventDefault();
  };

  const handleMove = (e) => {
    if (!isDragging) return;
    const rect = wheelEl.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const angle = Math.atan2(clientY - cy, clientX - cx);
    const delta = angle - startAngle;
    startAngle = angle;
    const deltaDeg = delta * (180 / Math.PI);
    const quantized = Math.round(deltaDeg / steps) * steps;
    rotation += quantized * 0.6;
    rotation = (rotation + 180) % 360 - 180;
    wheelEl.style.transform = `rotate(${rotation}deg)`;
    e.preventDefault();
  };

  const handleEnd = () => {
    isDragging = false;
    const normalized = (rotation + 180) % 360 - 180;
    const snapped = Math.round(normalized / angleStep) * angleStep;
    const delta = snapped - normalized;

    let startTime = null;
    const animate = (ts) => {
      if (!startTime) startTime = ts;
      const progress = Math.min((ts - startTime) / 200, 1);
      const easeOut = 1 - Math.pow(1 - progress, 5);
      wheelEl.style.transform = `rotate(${normalized + delta * easeOut}deg)`;

      if (progress < 1) {
        rafId = requestAnimationFrame(animate);
      } else {
        rotation = snapped;
        selectedMode = ((Math.round(rotation / angleStep) % modes.length) + modes.length) % modes.length;
        updateCenter();
        wheelEl.style.transition = 'transform 0.1s linear';
      }
    };
    rafId = requestAnimationFrame(animate);
  };

  wheelEl.addEventListener('mousedown', handleStart);
  window.addEventListener('mousemove', handleMove);
  window.addEventListener('mouseup', handleEnd);
  wheelEl.addEventListener('touchstart', handleStart, { passive: false });
  window.addEventListener('touchmove', handleMove, { passive: false });
  window.addEventListener('touchend', handleEnd);

  // Set up keyboard shortcuts
  setupKeyboardShortcuts();

  updateCenter();

  this.getSelectedMode = () => modes[selectedMode];
  this.setMode = (index) => {
    if (index >= 0 && index < modes.length) {
      const delta = (index - selectedMode + modes.length) % modes.length;
      animateTo(rotation + delta * angleStep, () => {
        rotation = index * angleStep;
        selectedMode = index;
        updateCenter();
      });
    }
  };

  return container;
}

// Hardcoded modes for the combined wheel (with case-sensitive shortcuts)
const combinedModes = [
  { name: 'None', dataMode: 'none', icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="24" height="24"><g stroke="#ffffff" stroke-width="12" fill="none" stroke-linecap="round" stroke-linejoin="round"><line x1="40" y1="40" x2="160" y2="160"/><line x1="160" y1="40" x2="40" y2="160"/></g></svg>', shortcut: 'x' },
  { name: 'Forces', dataMode: 'Forces', icon: '../data/icons/wheel/force.svg', shortcut: 'f' },
  { name: 'Spins', dataMode: 'Spins', icon: '../data/icons/wheel/spin.svg', shortcut: 's' },
  { name: 'Field', dataMode: 'Field', icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 120" width="32" height="32" transform="rotate(90)"><g stroke="#ffffff" stroke-width="10" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="10" y="10" width="180" height="100" rx="10"/><line x1="100" y1="10" x2="100" y2="110"/><circle cx="100" cy="60" r="20"/><rect x="20" y="40" width="20" height="40"/><rect x="160" y="40" width="20" height="40"/></g></svg>', shortcut: 'F' },
  { name: 'Planes', dataMode: 'Planes', icon: '../data/icons/wheel/plane-icon.svg', shortcut: 'P' },  // Uppercase P for Planes
  { name: 'Bonds', dataMode: 'Bonds', icon: '../data/icons/wheel/bonds.svg', shortcut: 'b' },
  { name: 'Cell', dataMode: 'Lattice', icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="24" height="24"><g stroke="#ffffff" stroke-width="12" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M50 50 L150 50 L150 150 L50 150 Z"/><path d="M100 0 L200 0 L200 100 L100 100 Z"/><line x1="50" y1="50" x2="100" y2="0"/><line x1="150" y1="50" x2="200" y2="0"/><line x1="150" y1="150" x2="200" y2="100"/><line x1="50" y1="150" x2="100" y2="100"/></g></svg>', shortcut: 'c' },
  { name: 'Polyhedra', dataMode: 'Polyhedra', icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="24" height="24"> <g stroke="#ffffff" stroke-width="12" fill="none" stroke-linejoin="round"><path d="M100 20 L180 100 L100 180 L20 100 Z" /><path d="M100 20 L20 100 L100 180" /><path d="M100 20 L180 100 L100 180" /> <path d="M20 100 L180 100" /> </g> </svg>', shortcut: 'p' },  // Lowercase p for Polyhedra
  {name: 'EOS', dataMode:"EOS", icon: '../data/icons/wheel/EOS.svg',shortcut:"e"}
];

// Function to add a combined control wheel to a container
export function addControlWheel(containerId) {
  const container = document.getElementById(containerId);
  if (!container) {
    console.error(`Container ${containerId} not found.`);
    return;
  }

  // Clear the container
  container.innerHTML = '';

  // Create the wheel with hardcoded modes
  const wheel = new CameraWheel({
    modes: combinedModes,
    onModeChange: (selectedMode) => {
      // Emit a custom event with the same data structure as the segmented controls
      container.dispatchEvent(new CustomEvent('modeChange', {
        detail: {
          mode: selectedMode.dataMode, // Use the dataMode value to match the segmented controls
          target: container
        }
      }));
    }
  });

  container.appendChild(wheel);
}
