// TabSwitcher.js
//
// Generic tab-switching helper built on the app's existing
// `.segmented-backend-control` / `.tab-content` markup (see backendPanel.css)
// so it drops into any panel that already uses that visual style with no CSS
// changes. Replaces the hand-rolled tab-button wiring that used to be
// duplicated per caller (add-atom/add-vacuum tabs, lattice parameters/matrix
// tabs, the add-structure modal's top-level tabs).

// createTabSwitcher(container, tabs) -> { setActive(tabId), container }
//   tabs: [{ id, label, render(bodyEl), onActivate(bodyEl), disabled }]
//   render() runs once, the first time a tab is shown (lazy). onActivate(),
//   if given, runs every time the tab is shown (including the first, after
//   render()) - useful for panels whose fields need to resync from shared
//   state each time they become visible (e.g. lattice params <-> matrix).
//   The first non-disabled tab is active by default.
export function createTabSwitcher(container, tabs) {
  const switchRow = document.createElement('div');
  switchRow.className = 'segmented-backend-control';

  const bodyWrap = document.createElement('div');

  const buttons = new Map();
  const bodies = new Map();
  const rendered = new Set();

  const defaultTab = tabs.find(t => !t.disabled) || tabs[0];

  tabs.forEach(tab => {
    const button = document.createElement('button');
    button.textContent = tab.label;
    button.dataset.tab = tab.id;
    if (tab.disabled) {
      button.disabled = true;
      button.style.opacity = '0.4';
      button.style.cursor = 'not-allowed';
    }
    switchRow.appendChild(button);
    buttons.set(tab.id, button);

    const body = document.createElement('div');
    body.className = 'tab-content';
    body.style.display = 'none';
    bodyWrap.appendChild(body);
    bodies.set(tab.id, body);

    if (!tab.disabled) {
      button.addEventListener('click', () => setActive(tab.id));
    }
  });

  function setActive(tabId) {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab || tab.disabled) return;

    buttons.forEach(b => b.classList.remove('active'));
    bodies.forEach(b => b.style.display = 'none');

    buttons.get(tabId).classList.add('active');
    const body = bodies.get(tabId);
    body.style.display = 'block';

    if (!rendered.has(tabId)) {
      rendered.add(tabId);
      tab.render(body);
    }
    if (tab.onActivate) tab.onActivate(body);
  }

  container.appendChild(switchRow);
  container.appendChild(bodyWrap);

  if (defaultTab) setActive(defaultTab.id);

  return { setActive, container };
}
