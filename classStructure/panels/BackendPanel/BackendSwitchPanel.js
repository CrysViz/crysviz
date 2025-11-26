import { general } from '../../store.js';
import {addBackendCalcPanel,removeBackendCalcPanel} from './BackendCalculator.js';
import {addBackendRelaxPanel,removeBackendRelaxPanel} from './BackendRelaxer.js';

const BackendModeSwitch = document.getElementById("BackendModeSwitch");

export function addErrorPanel(message="Default") {
  removeErrorPanel();

  const panel = document.createElement("div");
  panel.id = "backendErrorPanel";
  panel.style.position = "fixed"
  panel.style.top = "20%";
  panel.style.left = "430px";
  panel.style.background = "rgba(25,25,25,0.9)";
  panel.style.color = "white";
  panel.style.padding = "12px 16px";
  panel.style.borderRadius = "10px";
  panel.style.zIndex = "99999";
  panel.style.fontFamily = "sans-serif";
  panel.style.display = "flex";
  panel.style.flexDirection = "column";
  panel.style.gap = "10px";
  panel.style.maxWidth = "300px";

  const header = document.createElement("div");
  header.textContent = "⚠️   Warning!  ⚠️"
  header.style.justifyContent= "center";
  header.style.display= "flex";

  const msg = document.createElement("div");
  msg.innerHTML = message;
  msg.style.lineHeight = "1.6";

  const actions = document.createElement("div");
  actions.style.display = "flex";
  actions.style.justifyContent = "space-between";
  actions.style.gap = "10px";

  const acceptBtn = document.createElement("button");
  acceptBtn.className="acceptBtn";
  acceptBtn.textContent = "Accept";
  acceptBtn.style.flex = "1";
  acceptBtn.style.fontsize = "12px";
  acceptBtn.style.background = "var(--bg-color)";

  const denyBtn = document.createElement("button");
  denyBtn.className="denyBtn";
  denyBtn.textContent = "Deny";
  denyBtn.style.flex = "1";
  denyBtn.style.fontsize = "12px";
  denyBtn.style.background = "rgba(240, 132, 18,0.90)" 

  actions.appendChild(acceptBtn);
  actions.appendChild(denyBtn);
  
  panel.appendChild(header);
  panel.appendChild(msg);
  panel.appendChild(actions);

  document.body.appendChild(panel);

  return { panel, acceptBtn, denyBtn };
}

export function removeErrorPanel() {
  const existing = document.getElementById("backendErrorPanel");
  if (existing) existing.remove();
}

export function showWarning(message) {
  return new Promise(resolve => {
    const { panel, acceptBtn, denyBtn } = addErrorPanel(message);

    function accept() {
      cleanup();
      resolve("accept");
    }
    function deny() {
      cleanup();
      resolve("deny");
    }

    acceptBtn.addEventListener("click", accept);
    denyBtn.addEventListener("click", deny);

    function cleanup() {
      removeErrorPanel();
      acceptBtn.removeEventListener("click", accept);
      denyBtn.removeEventListener("click", deny);
    }
  });
}

export function addBackendModeSwitch() {
  BackendModeSwitch.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn || !btn.dataset.mode) return;

    const mode = btn.dataset.mode;

    // Reset UI
    BackendModeSwitch.querySelectorAll("button").forEach(b => {
      b.classList.remove("active", "symmetry", "ai");
    });

    if (mode === "symmetry") {
      showWarning(`Using symmetry mode will start a Python backend.\nSome data will temporarily be stored on our server!\n <a href="https://github.com/ftrybel/CrysViz_hot_develop/" target="_blank">Learn more</a>`)
        .then(result => {
          if (result === "accept") {
            btn.classList.add("symmetry");
            general.backendState = "symmetry";
            setTheme("symmetry");
            addBackendCalcPanel();
          } else {
            general.backendState = "none";
            setTheme("standard")
            resetSwitch();
          }
          console.log("Backend state:", general.backendState);
        });

    } else if (mode === "ai") {
        showWarning(`Using AI mode will start a Python backend.\nSome data will temporarily be stored on our server!\n <a href="https://github.com/ftrybel/CrysViz_hot_develop/" targe    t="_blank">Learn more</a>`)
        .then(result => {
          if (result === "accept") {
            btn.classList.add("ai");
            general.backendState = "ai";
            setTheme("ai");
            addBackendRelaxPanel();
          } else {
            general.backendState = "none";
            setTheme("standard");
            resetSwitch();
            removeBackendCalcPanel();
            removeBackendRelaxPanel()
          }
          console.log("Backend state:", general.backendState);
        });

    } else {
      btn.classList.add("active");
      general.backendState = mode.toLowerCase();
      console.log("Backend state:", general.backendState);
      setTheme("standard")
      removeBackendCalcPanel();
    }
  });
}

function setTheme(themeName) {
  document.body.className = '';               // clear old themes
  document.body.classList.add(`theme-${themeName}`);
  const figure = document.getElementById("aboutTrigger");
  let theme=`theme-${themeName}`;
  if (theme === "theme-standard") {
    figure.src = "../data/CrysViz_logo_clear_back_beta.png";
  } else if (theme === "theme-ai") {
    figure.src = "../data/CrysViz_logo_clear_back_beta_red.png";
  } else if (theme === "theme-symmetry") {
    figure.src = "../data/CrysViz_logo_clear_back_beta_blue.png";
  }
}


export function resetSwitch(defaultMode = "None") {
  // Update internal state
  general["backendState"] = defaultMode;

  // Remove active class from all buttons
  const buttons = BackendModeSwitch.querySelectorAll("button");
  buttons.forEach(btn => btn.classList.remove("active"));
  buttons.forEach(btn => btn.classList.remove("symmetry"));
  buttons.forEach(btn => btn.classList.remove("ai"));

  // Find button with matching data-mode (case-insensitive)
  const defaultBtn = Array.from(buttons).find(
    btn => btn.dataset.mode && btn.dataset.mode.trim().toLowerCase() === defaultMode.toLowerCase()
  );

  if (defaultBtn) {
    defaultBtn.classList.add("active");
  } else {
    console.warn(`No button with data-mode="${defaultMode}" found in`, BackendModeSwitch);
  }
}

// Convenience functions

