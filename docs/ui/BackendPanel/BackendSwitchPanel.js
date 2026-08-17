import { general } from '../../state/store.js';
import { removeAtomisticPanel, addRelaxPanel, addMDPanel } from './AtomisticPanels.js';
import { refreshBackendTheme } from './BackendTheme.js';
import { removeMDStreamPanel } from './MDStreamPanel.js';

const BackendModeSwitch = document.getElementById("BackendModeSwitch");

export function addErrorPanel(message="Default") {
  removeErrorPanel();

  const panel = document.createElement("div");
  panel.id = "backendErrorPanel";
  panel.className = "backend-error-panel";

  const header = document.createElement("div");
  header.textContent = "⚠   Warning!  ⚠"
  header.className = "backend-error-header";

  const msg = document.createElement("div");
  msg.innerHTML = message;
  msg.className = "backend-error-msg";

  const actions = document.createElement("div");
  actions.className = "backend-error-actions";

  const acceptBtn = document.createElement("button");
  acceptBtn.className = "acceptBtn backend-error-accept-btn";
  acceptBtn.textContent = "Accept";

  const denyBtn = document.createElement("button");
  denyBtn.className = "denyBtn backend-error-deny-btn";
  denyBtn.textContent = "Deny";

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
