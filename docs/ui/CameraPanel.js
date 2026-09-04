import {general,app} from '../state/store.js'
import * as THREE from '../external/three/three.module.js';
import {switchCameraType, setCameraSpeedFactor} from  '../ui/WindowAndSceneControls.js'
import {getPanelPref, setPanelPref, onPanelsReset} from './panels/PanelManager.js'

// 1× = the app's tuned default sensitivity (see WindowAndSceneControls BASE_*).
const DEFAULT_CAMERA_SPEED = 1;

/** Apply a rotate/pan speed factor everywhere: live controls, persisted pref,
 *  and the slider row's UI (value label + range position) when it is mounted. */
function applyCameraSpeed(factor) {
  setCameraSpeedFactor(factor);
  setPanelPref('cameraSpeedFactor', factor);
  const input = document.getElementById('cameraSpeedFactor');
  if (input) {
    input.value = String(factor);
    const value = input.closest('.camera_speed_row')?.querySelector('.slider-value');
    if (value) value.textContent = `${factor.toFixed(2)}×`;
  }
}

// Reset UI restores the speed to 1× along with the rest of the settings, even
// when the Camera panel is not currently mounted (applyCameraSpeed no-ops the
// UI part in that case).
onPanelsReset(() => applyCameraSpeed(DEFAULT_CAMERA_SPEED));

/** Build the "Rotate & pan speed" slider row. The value is a multiplier on the
 *  mouse/touch rotate + pan sensitivity: 1 = the app's tuned default, lower is
 *  slower, higher is faster. Persisted via the panelPref of the same name and
 *  applied to the live controls through setCameraSpeedFactor. */
function makeCameraSpeedSliderRow() {
  const stored = getPanelPref('cameraSpeedFactor');
  const initial = Number.isFinite(stored) && stored > 0 ? stored : DEFAULT_CAMERA_SPEED;

  const label = document.createElement('label');
  label.className = 'camera_speed_row';
  label.append('Rotate & pan speed: ');

  const value = document.createElement('span');
  value.className = 'slider-value';
  value.textContent = `${initial.toFixed(2)}×`;
  label.appendChild(value);

  const input = document.createElement('input');
  input.type = 'range';
  input.id = 'cameraSpeedFactor';
  input.min = '0.25';   // quarter speed
  input.max = '5';      // 5x speed
  input.step = '0.05';
  input.value = String(initial);
  input.setAttribute('aria-label', 'Rotate and pan speed');
  input.addEventListener('input', () => applyCameraSpeed(parseFloat(input.value)));

  // Reset the slider to the tuned 1× default. Shares the row with the range.
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'camera_speed_reset';
  reset.textContent = 'Reset';
  reset.title = 'Reset rotate & pan speed to 1×';
  reset.setAttribute('aria-label', 'Reset rotate and pan speed to default');
  reset.addEventListener('click', () => applyCameraSpeed(DEFAULT_CAMERA_SPEED));

  // A flex row keeps the range and the Reset button on one line, the range
  // taking the remaining width.
  const controlsRow = document.createElement('div');
  controlsRow.className = 'camera_speed_controls';
  controlsRow.appendChild(input);
  controlsRow.appendChild(reset);
  label.appendChild(controlsRow);
  return label;
}

export function addCameraPanel(target = "cameraContainer") {

  console.warn("addCameraPanel called")
  const targetPanel = document.getElementById(target);
  if (document.getElementById("cameraControlsGroup")) {
    console.warn("Camera Controls already exist.");
    return;
  }
  if (!targetPanel){
    console.warn("CamaraContainer does not exists!")
    return;
  }

  // Outer wrapper. Collapse/expand is handled by the unified panel window
  // (ui/panels/) hosting this content, so no header/toggle is built here.
  const group = document.createElement("div");
  group.id = "cameraControlsGroup";

  const content = document.createElement("div");
  content.id = "cameraControlsContent";

  // --- Camera Toggles ---
  // Perspective/Parallel Toggle
  const perspectiveToggle = document.createElement("label");
  perspectiveToggle.className = "camera_toggle";

  const perspectiveLabel = document.createElement("span");
  perspectiveLabel.className = "camera_label";
  perspectiveLabel.textContent = "Perspective";

  const perspectiveSwitch = document.createElement("span");
  perspectiveSwitch.className = "toggle_switch";

  const perspectiveCheckbox = document.createElement("input");
  perspectiveCheckbox.type = "checkbox";
  perspectiveCheckbox.id = "orthographicCamera";
  perspectiveCheckbox.checked = true;


  const perspectiveSlider = document.createElement("span");
  perspectiveSlider.className = "toggle_slider_dual";

  perspectiveSwitch.appendChild(perspectiveCheckbox);
  perspectiveSwitch.appendChild(perspectiveSlider);

  const parallelLabel = document.createElement("span");
  parallelLabel.className = "camera_label_r";
  parallelLabel.textContent = "Parallel";

  perspectiveToggle.appendChild(perspectiveLabel);
  perspectiveToggle.appendChild(perspectiveSwitch);
  perspectiveToggle.appendChild(parallelLabel);

  // Drag/Auto Rotation Toggle
  const dragToggle = document.createElement("label");
  dragToggle.className = "camera_toggle";

  const dragLabel = document.createElement("span");
  dragLabel.className = "camera_label";
  dragLabel.textContent = "Damped";

  const dragSwitch = document.createElement("span");
  dragSwitch.className = "toggle_switch";

  const dragCheckbox = document.createElement("input");
  dragCheckbox.type = "checkbox";
  dragCheckbox.id = "autoRotate";

  const dragSlider = document.createElement("span");
  dragSlider.className = "toggle_slider_dual";

  dragSwitch.appendChild(dragCheckbox);
  dragSwitch.appendChild(dragSlider);

  const autoRotateLabel = document.createElement("span");
  autoRotateLabel.className = "camera_label_r";
  autoRotateLabel.textContent = "Rotation";

  dragToggle.appendChild(dragLabel);
  dragToggle.appendChild(dragSwitch);
  dragToggle.appendChild(autoRotateLabel);

  // Push/Random Toggle
  const pushToggle = document.createElement("label");
  pushToggle.className = "camera_toggle";

  const pushLabel = document.createElement("span");
  pushLabel.className = "camera_label";
  pushLabel.textContent = "Push & Release";

  const pushSwitch = document.createElement("span");
  pushSwitch.className = "toggle_switch";

  const pushCheckbox = document.createElement("input");
  pushCheckbox.type = "checkbox";
  pushCheckbox.id = "pushRandom";

  const pushSlider = document.createElement("span");
  pushSlider.className = "toggle_slider_dual";

  pushSwitch.appendChild(pushCheckbox);
  pushSwitch.appendChild(pushSlider);

  const randomLabel = document.createElement("span");
  randomLabel.className = "camera_label_r";
  randomLabel.textContent = "Random";

  pushToggle.appendChild(pushLabel);
  pushToggle.appendChild(pushSwitch);
  pushToggle.appendChild(randomLabel);

  // Append all toggles to content
  content.appendChild(perspectiveToggle);
  content.appendChild(dragToggle);
  content.appendChild(pushToggle);

  // Rotate & pan speed slider (mouse/touch sensitivity multiplier).
  content.appendChild(makeCameraSpeedSliderRow());

  // Build hierarchy
  group.appendChild(content);

  // Insert into DOM
  targetPanel.appendChild(group);

   // New control handlers
  document.getElementById('orthographicCamera').onchange = (e) => {
    app.useOrthographicCamera = e.target.checked;
    switchCameraType();
  };

// Variable to track random rotation interval

// Toggle logic
document.getElementById("pushRandom").addEventListener("change", (e) => {
    general.autoRandomEnabled = e.target.checked;

    if (e.target.checked) {
      app.angularVelocity = new THREE.Vector3();  
      // Give a single impulse in a random direction
      app.angularVelocity.add(new THREE.Vector3(
        (Math.random() - 0.5) * 0.5,
        (Math.random() - 0.5) * 0.5,
        (Math.random() - 0.5) * 0.5
      ));
  } else {
    // Optional: zero out velocity when toggled off
    app.angularVelocity = null;
  }
});

  

// --- Push & Release Logic ---
document.getElementById("autoRotate").addEventListener("change", (e) => {
  // Optional: If you want to tie "Auto Rotation" to damping
   app.controls.dynamicDampingFactor = e.target.checked ? 0 : 0.2;
   // No damping means no inertia to arrest a zoom drag, which reads as the
   // scene lurching uncontrollably — disallow zoom while undamped.
   app.controls.noZoom = e.target.checked;
});

// --- Push & Release Toggle ---
//  document.getElementById("pushRandom").addEventListener("change", (e) => {
//  // Disable damping for "Push & Release"
//  app.controls.dynamicDampingFactor = e.target.checked ? 0 : 0.2;
//});


}

