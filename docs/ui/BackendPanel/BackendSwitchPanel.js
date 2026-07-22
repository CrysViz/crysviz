import { general } from '../../state/store.js';
import { removeAtomisticPanel, addRelaxPanel, addMDPanel } from './AtomisticPanels.js';
import { refreshBackendTheme } from './BackendTheme.js';
import { addMDStreamPanel, removeMDStreamPanel } from './MDStreamPanel.js';

const BackendModeSwitch = document.getElementById("BackendModeSwitch");

export function addErrorPanel(message="Default") {
  removeErrorPanel();

  const panel = document.createElement("div");
  panel.id = "backendErrorPanel";
  panel.style.position = "fixed"
  panel.style.top = "20%";
  panel.style.left = "var(--popup-left)";
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
  acceptBtn.style.fontSize = "12px";
  acceptBtn.style.background = "var(--bg-color)";

  const denyBtn = document.createElement("button");
  denyBtn.className="denyBtn";
  denyBtn.textContent = "Deny";
  denyBtn.style.flex = "1";
  denyBtn.style.fontSize = "12px";
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
    const { panel: _panel, acceptBtn, denyBtn } = addErrorPanel(message);

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
    const alreadyActive = btn.classList.contains(mode);

    // Reset UI
    BackendModeSwitch.querySelectorAll("button").forEach(b => {
      b.classList.remove("active", "relax", "md");
    });

    if (alreadyActive) {
      general.backendState = "none";
      refreshBackendTheme();
      removeAtomisticPanel();
      removeMDStreamPanel();
      return;
    }

    if (mode === "relax") {
            btn.classList.add("relax");
            general.backendState = "relax";
            general.atomisticPotential = general.atomisticPotential || "nep";
            refreshBackendTheme();
            addRelaxPanel();
    } else if (mode === "md") {
            btn.classList.add("md");
            general.backendState = "md";
            general.atomisticPotential = general.atomisticPotential || "nep";
            refreshBackendTheme();
            removeMDStreamPanel();
            addMDPanel();
    }
  });

  // Default: open the panel in Relax mode (reuse the click handler so there is
  // a single source of truth for what entering relax does).
  const relaxBtn = BackendModeSwitch.querySelector('button[data-mode="relax"]');
  if (relaxBtn) relaxBtn.click();
}


export function resetSwitch(defaultMode = "None") {
  // Update internal state
  general["backendState"] = defaultMode;

  // Remove active class from all buttons
  const buttons = BackendModeSwitch.querySelectorAll("button");
  buttons.forEach(btn => btn.classList.remove("active"));
  buttons.forEach(btn => btn.classList.remove("relax"));
  buttons.forEach(btn => btn.classList.remove("md"));

  // Find button with matching data-mode (case-insensitive)
  const defaultBtn = Array.from(buttons).find(
    btn => btn.dataset.mode && btn.dataset.mode.trim().toLowerCase() === defaultMode.toLowerCase()
  );

  if (defaultBtn) {
    defaultBtn.classList.add("active");
  }
}

// Convenience functions
