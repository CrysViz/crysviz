// CollisionWarningUI.js
//
// Shared "collision-guarded commit" UX: wraps a commit button so that its
// click runs AtomCollisionCheck.js, and if any atoms are too close it renders
// an inline warning banner (naming the offending pairs) and turns the button
// into an explicit "Add Anyway" / "Create Anyway" confirmation instead of
// committing. Editing the watched atoms (fixing the conflict) re-arms the
// check, so the next click re-validates rather than blindly forcing through -
// only a click with no edits since the warning bypasses it. This is the one
// place the warning/resolve/"Add anyway" behavior lives, so the add-atom
// panel, the add-structure modal, and a future Wyckoff generator all get
// identical behavior for free.

function formatEndpoint(endpoint) {
  return `${endpoint.element} (${endpoint.group} atom ${endpoint.index + 1})`;
}

// wireCollisionGuardedButton({ button, warningContainer, watchContainer, defaultLabel, anywayLabel, checkCollisions, commit, onWarn, onClear })
//   button: the commit <button> element
//   warningContainer: element the warning banner is inserted into (cleared between attempts)
//   watchContainer: element to watch for 'input' events (e.g. the atom table)
//     - editing anything inside it after a warning re-arms the check
//   checkCollisions: () => { tooClose: [{a, b, distance}] } (see AtomCollisionCheck.js)
//   commit: () => void, called once the add is confirmed (clean, or after "Add Anyway")
//   onWarn(tooClose): optional, called when a warning is shown (e.g. to highlight rows)
//   onClear(): optional, called whenever the warning/armed state clears
export function wireCollisionGuardedButton({ button, warningContainer, watchContainer, defaultLabel, anywayLabel, checkCollisions, commit, onWarn, onClear }) {
  let armed = false;

  function clearWarning() {
    warningContainer.innerHTML = '';
    armed = false;
    button.textContent = defaultLabel;
    button.classList.remove('add-anyway-btn');
    onClear?.();
  }

  function showWarning(tooClose) {
    const items = tooClose
      .map(t => `<li>${formatEndpoint(t.a)} is ${t.distance.toFixed(3)} Å from ${formatEndpoint(t.b)}</li>`)
      .join('');
    warningContainer.innerHTML = `
      <div class="collision-warning-banner">
        <strong>Warning:</strong> some atoms are closer than 0.5 Å.
        <ul>${items}</ul>
      </div>
    `;
    armed = true;
    button.textContent = anywayLabel;
    button.classList.add('add-anyway-btn');
    onWarn?.(tooClose);
  }

  button.addEventListener('click', () => {
    const result = checkCollisions();
    if (result.tooClose.length && !armed) {
      showWarning(result.tooClose);
      return;
    }
    commit();
    clearWarning();
  });

  // Editing atoms after a warning means the user is trying to resolve the
  // conflict - re-check on the next click instead of letting a stale "Add
  // Anyway" arm silently bypass a fix (or an unrelated new conflict).
  watchContainer?.addEventListener('input', () => {
    if (armed) clearWarning();
  });

  return { reset: clearWarning };
}
