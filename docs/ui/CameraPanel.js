import {general,app} from '../state/store.js'
import * as THREE from '../external/three/three.module.js';
import {switchCameraType, setCameraSpeedFactor} from  '../ui/WindowAndSceneControls.js'
import {getPanelPref, setPanelPref, onPanelsReset} from './panels/PanelManager.js'
import {cameraSyncSupported, isCameraSyncOn, getCameraSyncMode, getCameraSyncCentre, cameraSyncPeerCount, setCameraSync, setCameraSyncMode, setCameraSyncCentre, lineUpCameraSync, onCameraSyncChange} from './CameraSync.js'

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

// ---- "Sync camera across tabs" (ui/CameraSync.js) --------------------------
//
// A card of its own at the foot of the Camera panel: a title with the link
// state (Off / waiting for other tabs / linked to N tabs), a three-way switch
// (Off, Same view, Same turns; see CameraSync's header), a line saying what
// the choice does, and while on the option that mode has: "Also match pan and
// rotation centre" (Same view: for one structure in two tabs; angle and zoom
// already match) or "Line up all tabs with this one" (Same turns: drops every
// tab's own angle; in Same view the tabs are lined up already). The switch is native radios, so the
// keyboard and the feature search treat it as one choice.

const SYNC_HINTS = {
  off: 'Link the camera of CrysViz tabs in this browser. Turn it on in each tab.',
  view: 'Every linked tab shows the same angle and zoom.',
  turns: 'Tabs keep their own angle and turn together. To re-aim this tab, switch Off, turn, switch back.',
};

const SYNC_ICON = `<svg class="camera_sync_icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
  <path d="M13.5 6.5A5.5 5.5 0 0 0 3.2 4.3M2.5 9.5a5.5 5.5 0 0 0 10.3 2.2"/>
  <path d="M3 1.8v2.7h2.7M13 14.2v-2.7h-2.7"/></svg>`;

const ALIGN_ICON = `<svg class="camera_sync_btn_icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
  <circle cx="8" cy="8" r="2.2"/><path d="M8 1v3M8 12v3M1 8h3M12 8h3"/></svg>`;

function syncStatus(on, peers) {
  if (!on) return { state: 'off', text: 'Off' };
  if (peers === 0) return { state: 'waiting', text: 'Waiting for tabs' };
  return { state: 'linked', text: `Linked to ${peers} tab${peers === 1 ? '' : 's'}` };
}

function makeCameraSyncRow() {
  const card = document.createElement('section');
  card.className = 'camera_sync';
  card.setAttribute('aria-labelledby', 'cameraSyncTitle');
  card.innerHTML = `
    <div class="camera_sync_head">
      ${SYNC_ICON}
      <h4 id="cameraSyncTitle" class="camera_sync_title">Sync camera across tabs</h4>
      <span class="camera_sync_status" id="cameraSyncStatus" role="status" data-state="off">
        <span class="camera_sync_dot" aria-hidden="true"></span><span class="camera_sync_status_text">Off</span>
      </span>
    </div>
    <div class="camera_sync_modes" role="radiogroup" aria-labelledby="cameraSyncTitle" aria-describedby="cameraSyncHint">
      <label class="camera_sync_mode"><input type="radio" name="cameraSyncMode" id="cameraSyncOff" value="off"><span>Off</span></label>
      <label class="camera_sync_mode"><input type="radio" name="cameraSyncMode" id="cameraSyncView" value="view"><span>Same view</span></label>
      <label class="camera_sync_mode"><input type="radio" name="cameraSyncMode" id="cameraSyncTurns" value="turns"><span>Same turns</span></label>
    </div>
    <p class="camera_sync_hint" id="cameraSyncHint"></p>
    <div class="camera_sync_options">
      <label class="camera_sync_check" title="Angle and zoom always match. This also puts the structure at the same place on screen (pan) and turns it around the same point (rotation centre). For the same structure open in several tabs.">
        <span class="toggle_switch toggle_switch--sm"><input type="checkbox" id="cameraSyncCentre"><span class="toggle_slider"></span></span>
        <span class="toggle_text">Also match pan and rotation centre</span>
      </label>
      <button type="button" id="cameraSyncAlign" class="camera_sync_align"
        title="Every linked tab gives up its own starting angle and zoom and takes this tab's view; they keep turning together">${ALIGN_ICON}<span>Line up all tabs with this one</span></button>
    </div>`;
  const radios = /** @type {HTMLInputElement[]} */ ([...card.querySelectorAll('input[name="cameraSyncMode"]')]);
  const options = /** @type {HTMLElement} */ (card.querySelector('.camera_sync_options'));
  const hint = /** @type {HTMLElement} */ (card.querySelector('.camera_sync_hint'));
  const status = /** @type {HTMLElement} */ (card.querySelector('.camera_sync_status'));
  const statusText = /** @type {HTMLElement} */ (card.querySelector('.camera_sync_status_text'));
  const centreBox = /** @type {HTMLInputElement} */ (card.querySelector('#cameraSyncCentre'));
  const centreRow = /** @type {HTMLElement} */ (card.querySelector('.camera_sync_check'));
  const alignBtn = /** @type {HTMLElement} */ (card.querySelector('#cameraSyncAlign'));

  if (!cameraSyncSupported()) {
    radios.forEach((r) => { r.disabled = true; });
    radios[0].checked = true;
    card.dataset.state = 'unsupported';
    options.hidden = true;
    statusText.textContent = 'Not available';
    hint.textContent = 'This browser cannot pass messages between tabs (no BroadcastChannel).';
    return card;
  }
  const refresh = () => {
    const on = isCameraSyncOn();
    const mode = getCameraSyncMode();
    const value = on ? mode : 'off';
    radios.forEach((r) => { r.checked = r.value === value; });
    const { state, text } = syncStatus(on, cameraSyncPeerCount());
    card.dataset.state = state;
    status.dataset.state = state;
    statusText.textContent = text;
    hint.textContent = SYNC_HINTS[value];
    options.hidden = !on;
    centreRow.hidden = mode !== 'view';
    alignBtn.hidden = mode !== 'turns';
    status.title = state === 'waiting' ? 'Switch sync on in another CrysViz tab of this browser' : '';
    centreBox.checked = getCameraSyncCentre();
  };
  radios.forEach((r) => r.addEventListener('change', () => {
    if (!r.checked) return;
    if (r.value === 'off') {
      setCameraSync(false);
    } else {
      setCameraSyncMode(r.value);
      setCameraSync(true);
    }
  }));
  centreBox.addEventListener('change', () => setCameraSyncCentre(centreBox.checked));
  alignBtn.addEventListener('click', () => lineUpCameraSync());
  onCameraSyncChange(refresh);
  refresh();
  return card;
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

  // Follow the camera of other CrysViz tabs (ui/CameraSync.js).
  content.appendChild(makeCameraSyncRow());

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

