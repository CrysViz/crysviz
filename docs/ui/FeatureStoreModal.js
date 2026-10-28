// "Add panels" popup (the feature store's UI): pick which optional panels sit
// in the sidebar. Never called a "store" or "features" on screen — the
// Features panel already owns that word.
//
// The solid "＋ Add panels" button under the search field (#featureStoreButton,
// index.html, beside "Reset to Essentials") opens a card list of every feature-store window
// (panels/featureStore.js), grouped by category. Add/Remove go through
// PanelManager's addStoreFeature/removeStoreFeature, so the popup is only a
// view: a window opened by any other route (search, a shortcut, a data load)
// shows up here as added the next time the list renders.
//
// The button also counts the store windows NOT in the sidebar that have data
// in the selected structure (a trajectory, forces, a field, ...) — the
// `store.suggest()` hints in defaultPanels.js — so a slim sidebar still points
// at the feature a freshly loaded file needs.

import {
  listStoreFeatures, addStoreFeature, removeStoreFeature, onPanelAvailabilityRefreshed,
} from './panels/PanelManager.js';
import { onFeatureStoreChange } from './panels/featureStore.js';
import { showInfoPanel } from './InfoPanel.js';
import { choiceDialog, noticeDialog } from './ConfirmModal.js';

// Display order of the categories named in the store blocks (defaultPanels.js);
// a category missing here sorts after these, alphabetically.
const CATEGORY_ORDER = ['Display', 'Structure', 'Vectors & fields', 'Analysis', 'Simulation', 'Customisation'];

let modal = null;
let listEl = null;
let previousFocus = null;

function categoryRank(name) {
  const i = CATEGORY_ORDER.indexOf(name);
  return i >= 0 ? i : CATEGORY_ORDER.length;
}

function build() {
  if (modal) return;
  modal = document.createElement('div');
  modal.id = 'featureStoreModal';
  modal.hidden = true;
  modal.innerHTML = `
    <div class="png-export-modal feature-store-modal" role="dialog" aria-modal="true" aria-labelledby="featureStoreTitle">
      <div class="feature-store-head">
        <h3 id="featureStoreTitle">Panels</h3>
        <button type="button" class="feature-store-close" id="featureStoreClose" aria-label="Close" title="Close">×</button>
      </div>
      <p class="png-note">Choose the panels you want in the sidebar. Removed panels stay one search away
        (<kbd class="feature-store-kbd" id="featureStoreSearchKey"></kbd>) and come back by themselves when you load data they need.</p>
      <div class="feature-store-presets" role="group" aria-label="Presets">
        <button type="button" class="feature-store-preset" data-preset="essentials">Reset to Essentials</button>
        <button type="button" class="feature-store-preset" data-preset="all">Add all</button>
      </div>
      <div class="feature-store-notice" id="featureStoreNotice" role="status" hidden>
        <span id="featureStoreNoticeText"></span>
        <button type="button" class="feature-store-undo" id="featureStoreUndo">Undo</button>
      </div>
      <div class="feature-store-list" id="featureStoreList"></div>
      <div class="paste-modal-actions">
        <button type="button" class="png-primary" id="featureStoreDone">Done</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  listEl = /** @type {HTMLElement} */ (modal.querySelector('#featureStoreList'));
  const keyEl = modal.querySelector('#featureStoreSearchKey');
  if (keyEl) keyEl.textContent = searchShortcutLabel();

  modal.addEventListener('click', (e) => { if (e.target === modal) closeFeatureStore(); });
  // On the document, not the card: Add/Remove re-render the list, which drops
  // focus to <body> and would leave a card-level listener deaf.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal && !modal.hidden) {
      e.stopPropagation();
      closeFeatureStore();
    }
  }, true);
  modal.querySelector('#featureStoreClose')?.addEventListener('click', closeFeatureStore);
  modal.querySelector('#featureStoreDone')?.addEventListener('click', closeFeatureStore);
  for (const btn of modal.querySelectorAll('.feature-store-preset')) {
    btn.addEventListener('click', () => applyPreset(/** @type {HTMLElement} */ (btn).dataset.preset));
  }
  modal.querySelector('#featureStoreUndo')?.addEventListener('click', undoPreset);
  listEl.addEventListener('click', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    const card = /** @type {HTMLElement|null} */ (target.closest('.feature-store-card'));
    if (!card) return;
    const id = card.dataset.featureId;
    if (target.closest('.feature-store-info')) {
      const item = listStoreFeatures().find((f) => f.id === id);
      if (item?.infoMd) showInfoPanel(item.infoMd);
    } else if (target.closest('.feature-store-toggle')) {
      if (card.classList.contains('in-sidebar')) removeStoreFeature(id);
      else addStoreFeature(id, { expand: false });
      hideNotice(); // a card change after a preset makes its undo stale
      renderList();
    }
  });
}

/** "Ctrl+F" / "⌘F", matching the platform convention KeyboardShortcuts.js uses. */
export function searchShortcutLabel() {
  const mac = /Mac|iPod|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
  return mac ? '⌘F' : 'Ctrl+F';
}

// The sidebar as it was before the last preset, for its Undo.
/** @type {Map<string, boolean>|null} */
let undoSnapshot = null;

function setInSidebar(id, on) {
  if (on) addStoreFeature(id, { expand: false });
  else removeStoreFeature(id);
}

function hideNotice() {
  undoSnapshot = null;
  const notice = document.getElementById('featureStoreNotice');
  if (notice) notice.hidden = true;
}

/** Put the sidebar to a preset ('essentials' | 'all'): what changed, and the
 *  sidebar before, for an Undo. */
function setPreset(preset) {
  const before = new Map(listStoreFeatures().map((f) => [f.id, f.inSidebar]));
  let added = 0;
  let removed = 0;
  for (const item of listStoreFeatures()) {
    const want = preset === 'all' || item.essential;
    if (want === item.inSidebar) continue;
    setInSidebar(item.id, want);
    if (want) added++; else removed++;
  }
  return { before, added, removed };
}

/** The popup's "Reset to Essentials" / "Add all". Reports what changed, with
 *  an Undo that puts every window back the way it was. */
function applyPreset(preset) {
  const { before, added, removed } = setPreset(preset);
  renderList();
  const notice = document.getElementById('featureStoreNotice');
  const text = document.getElementById('featureStoreNoticeText');
  if (!notice || !text) return;
  const panels = (n) => `${n} panel${n === 1 ? '' : 's'}`;
  if (!added && !removed) {
    hideNotice();
    text.textContent = preset === 'all' ? 'Every panel is already in the sidebar.' : 'The sidebar already shows only the essentials.';
    notice.hidden = false;
    /** @type {HTMLElement} */ (notice.querySelector('#featureStoreUndo')).hidden = true;
    return;
  }
  undoSnapshot = before;
  text.textContent = removed
    ? `Removed ${panels(removed)} from the sidebar.`
    : `Added ${panels(added)} to the sidebar.`;
  /** @type {HTMLElement} */ (notice.querySelector('#featureStoreUndo')).hidden = false;
  notice.hidden = false;
}

function undoPreset() {
  const snapshot = undoSnapshot;
  hideNotice();
  if (!snapshot) return;
  for (const item of listStoreFeatures()) {
    const was = snapshot.get(item.id);
    if (was !== undefined && was !== item.inSidebar) setInSidebar(item.id, was);
  }
  renderList();
}

/** Back to the first-run sidebar — the sidebar's "Reset to Essentials"
 *  button and the search action of that name. Asks first, naming the panels
 *  it would remove (and any essential it would bring back); with nothing to
 *  change it says so. Resolves whether the sidebar changed. */
export async function resetSidebarToEssentials() {
  const items = listStoreFeatures();
  const going = items.filter((f) => f.inSidebar && !f.essential);
  const coming = items.filter((f) => !f.inSidebar && f.essential);
  if (!going.length && !coming.length) {
    await noticeDialog('The sidebar already shows only the essential panels.', { title: 'Reset to Essentials' });
    return false;
  }
  const names = (list) => list.map((f) => f.title).join(', ');
  const panels = (n) => `${n} panel${n === 1 ? '' : 's'}`;
  const parts = [];
  if (going.length) parts.push(`Removing ${panels(going.length)} from the sidebar: ${names(going)}.`);
  if (coming.length) parts.push(`Adding back ${names(coming)}.`);
  if (going.length) parts.push('They stay reachable through the search, and ＋ Add panels brings them back.');
  const choice = await choiceDialog(parts.join(' '), {
    title: 'Reset to Essentials?',
    choices: [
      {
        value: 'reset',
        label: going.length ? `Remove ${panels(going.length)}` : 'Reset',
        description: 'Keep Files, Features, Visual, Cell & Supercell and Settings',
        id: 'resetEssentialsConfirm',
      },
      { value: 'cancel', label: 'Cancel', description: 'Leave the sidebar as it is', id: 'resetEssentialsCancel' },
    ],
    cancelValue: 'cancel',
  });
  if (choice !== 'reset') return false;
  setPreset('essentials');
  renderList();
  return true;
}

function renderList() {
  if (!listEl) return;
  const items = listStoreFeatures();
  const byCategory = new Map();
  for (const item of items) {
    if (!byCategory.has(item.category)) byCategory.set(item.category, []);
    byCategory.get(item.category).push(item);
  }
  const categories = [...byCategory.keys()].sort(
    (a, b) => categoryRank(a) - categoryRank(b) || a.localeCompare(b));
  listEl.replaceChildren();
  for (const category of categories) {
    const section = document.createElement('section');
    section.className = 'feature-store-category';
    const h = document.createElement('h4');
    h.textContent = category;
    section.appendChild(h);
    for (const item of byCategory.get(category)) section.appendChild(buildCard(item));
    listEl.appendChild(section);
  }
}

function buildCard(item) {
  const card = document.createElement('div');
  card.className = 'feature-store-card' + (item.inSidebar ? ' in-sidebar' : '');
  card.dataset.featureId = item.id;

  const text = document.createElement('div');
  text.className = 'feature-store-card-text';
  const title = document.createElement('div');
  title.className = 'feature-store-card-title';
  title.textContent = item.title;
  if (item.suggested && !item.inSidebar) {
    const tag = document.createElement('span');
    tag.className = 'feature-store-tag';
    tag.textContent = 'Has data';
    tag.title = 'The selected structure has data for this feature';
    title.appendChild(tag);
  }
  const blurb = document.createElement('div');
  blurb.className = 'feature-store-card-blurb';
  blurb.textContent = item.blurb;
  text.append(title, blurb);
  card.appendChild(text);

  if (item.infoMd) {
    const info = document.createElement('button');
    info.type = 'button';
    info.className = 'info-button feature-store-info';
    info.title = `About ${item.title}`;
    info.textContent = 'i';
    card.appendChild(info);
  }

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'feature-store-toggle';
  toggle.textContent = item.inSidebar ? 'Remove' : 'Add';
  toggle.setAttribute('aria-label', `${item.inSidebar ? 'Remove' : 'Add'} ${item.title}`);
  card.appendChild(toggle);
  return card;
}

/** Open the popup. */
export function openFeatureStore() {
  build();
  renderList();
  previousFocus = document.activeElement;
  modal.hidden = false;
  /** @type {HTMLElement|null} */ (modal.querySelector('#featureStoreDone'))?.focus({ preventScroll: true });
}

export function closeFeatureStore() {
  if (!modal || modal.hidden) return;
  modal.hidden = true;
  hideNotice();
  const target = /** @type {HTMLElement|null} */ (previousFocus);
  previousFocus = null;
  if (target && typeof target.focus === 'function') target.focus({ preventScroll: true });
}

export function isFeatureStoreOpen() {
  return !!modal && !modal.hidden;
}

// ---- the sidebar button -----------------------------------------------------

function updateButton() {
  const badge = document.getElementById('featureStoreBadge');
  if (!badge) return;
  const suggested = listStoreFeatures().filter((f) => f.suggested && !f.inSidebar);
  badge.hidden = suggested.length === 0;
  badge.textContent = suggested.length ? `${suggested.length} with data` : '';
  badge.title = suggested.map((f) => f.title).join(', ');
  if (modal && !modal.hidden) renderList();
}

/** Wire the sidebar button. Runs once, after the default panels registered. */
export function initFeatureStore() {
  const btn = document.getElementById('featureStoreButton');
  if (btn) btn.addEventListener('click', openFeatureStore);
  document.getElementById('resetEssentialsButton')?.addEventListener('click', resetSidebarToEssentials);
  onFeatureStoreChange(updateButton);
  onPanelAvailabilityRefreshed(updateButton);
  updateButton();
}
