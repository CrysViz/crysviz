import { general } from '../store.js';

const BackendModeSwitch = document.getElementById("BackendModeSwitch");

export function addBackendModeSwitch() {
  BackendModeSwitch.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn || !btn.dataset.mode) return;

    const mode = btn.dataset.mode;
    general.backendState = mode;

    // Update UI
    BackendModeSwitch.querySelectorAll("button").forEach(b => {
     b.classList.remove("active");
     b.classList.remove("symmetry");
     b.classList.remove("ai");
     });


    if (general.backendState == "Symmetry") {
      btn.classList.add("symmetry");
    }
    else if (general.backendState == "AI") {
      btn.classList.add("ai");
    }
    else {
      btn.classList.add("active");
    }

    console.log(general.backendState);
  });
}

export function resetSwitch(switchContainer, stateKey, defaultMode = "None") {
  // Update internal state
  general[stateKey] = defaultMode;

  // Remove active class from all buttons
  const buttons = switchContainer.querySelectorAll("button");
  buttons.forEach(btn => btn.classList.remove("active"));

  // Find button with matching data-mode (case-insensitive)
  const defaultBtn = Array.from(buttons).find(
    btn => btn.dataset.mode && btn.dataset.mode.trim().toLowerCase() === defaultMode.toLowerCase()
  );

  if (defaultBtn) {
    defaultBtn.classList.add("active");
  } else {
    console.warn(`No button with data-mode="${defaultMode}" found in`, switchContainer);
  }
}

// Convenience functions

