import { general } from '../store.js';
import { addTrajectoryPlayer,removeTrajectoryPlayer} from './TrajectoryPanel.js';
import { addLatticeComparisonPanel } from './LatticeComparisonPanel.js';

const ControlPanelModeSwitch = document.getElementById("ControlPanelModeSwitch");
export function addControlPanelModeSwitch() {
  ControlPanelModeSwitch.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn || !btn.dataset.mode) return;

    const mode = btn.dataset.mode;
    general.playerModeState = mode;

    // Update UI
    ControlPanelModeSwitch.querySelectorAll("button").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");

    // Handle different modes
    if (general.playerModeState == "trajectory") {
      console.log("calling addTrajectoryPlayer()")
        const frames = Array.from({ length: 200 }, (_, i) => i * 0.05);
        addTrajectoryPlayer(frames);
      } 
    else if (general.playerModeState == "comparison") {
      const trajPanel = document.getElementById("TrajControlPanel");
      if (trajPanel) {
        removeTrajectoryPlayer();
        }
      } 
    else {
      const trajPanel = document.getElementById("TrajControlPanel");
      if (trajPanel) {
        removeTrajectoryPlayer();
      }
    }

    console.log(general.playerModeState);
  });
}
