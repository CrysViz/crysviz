/**
 * The PET-MAD model list: built-in PET-MAD xs / s, then one group per
 * catalogue (the app's DEFAULT_CATALOGUES, then those the user added), then
 * single models added by link, and "from a link…", which opens a box that
 * takes a link to either a .gguf or a catalogue .json.
 *
 * What the user added is remembered (panel prefs petCatalogues / petLinks,
 * with a snapshot of each catalogue so the list works offline, where the
 * models are cached too), and so is the selected model (mlipModel).
 * Catalogues are fetched again in the background each session, so a hosted
 * catalogue can grow without anyone re-adding it.
 */
import { getPanelPref, setPanelPref } from '../panels/PanelManager.js';
import { notifyPotentialChange } from '../../atomistic/potentialNotice.js';
import {
  DEFAULT_CATALOGUES, PET_MAD_BASE_URL, fetchPetCatalogue, openPetLink, describePetModel, formatBytes,
} from '../../atomistic/petModels.js';

/** Value of the "from a link…" option. */
export const PET_LINK_OPTION = '__link__';

/** @typedef {import('../../atomistic/petModels.js').PetModelEntry} PetModelEntry */
/** @typedef {import('../../atomistic/petModels.js').PetCatalogue} PetCatalogue */
/**
 * @typedef {{ entry: PetModelEntry, source: { kind: 'builtin' } | { kind: 'default-catalogue', url: string, name: string }
 *   | { kind: 'catalogue', url: string, name: string } | { kind: 'link', url: string } }} PetListItem
 */

/** Built-in models: select value (a file under PET_MAD_BASE_URL) -> entry. */
const BUILTIN = new Map([
  ['pet-mad-xs.gguf', { url: `${PET_MAD_BASE_URL}pet-mad-xs.gguf`, name: 'pet-mad-xs.gguf', license: 'BSD-3-Clause', size: 17_074_144 }],
  ['pet-mad-s.gguf', { url: `${PET_MAD_BASE_URL}pet-mad-s.gguf`, name: 'pet-mad-s.gguf', license: 'BSD-3-Clause' }],
]);

/** Catalogues fetched this session from DEFAULT_CATALOGUES (not remembered). @type {Map<string, PetCatalogue>} */
const defaultCatalogues = new Map();

/** @returns {PetCatalogue[]} */
function userCatalogues() {
  const list = getPanelPref('petCatalogues');
  return Array.isArray(list) ? list.filter((c) => c && typeof c.url === 'string' && Array.isArray(c.models)) : [];
}

/** @returns {{ url: string, name: string, info?: object }[]} */
function userLinks() {
  const list = getPanelPref('petLinks');
  return Array.isArray(list) ? list.filter((l) => l && typeof l.url === 'string') : [];
}

/**
 * Every model the list offers, by select value.
 * @returns {Map<string, PetListItem>}
 */
function modelIndex() {
  /** @type {Map<string, PetListItem>} */
  const index = new Map();
  for (const [value, entry] of BUILTIN) index.set(value, { entry, source: { kind: 'builtin' } });
  for (const cat of defaultCatalogues.values()) {
    for (const m of cat.models) {
      if (!index.has(m.url)) index.set(m.url, { entry: m, source: { kind: 'default-catalogue', url: cat.url, name: cat.name } });
    }
  }
  for (const cat of userCatalogues()) {
    for (const m of cat.models) {
      if (!index.has(m.url)) index.set(m.url, { entry: m, source: { kind: 'catalogue', url: cat.url, name: cat.name } });
    }
  }
  for (const link of userLinks()) {
    if (!index.has(link.url)) {
      index.set(link.url, { entry: { url: link.url, name: link.name, ...(link.info || {}) }, source: { kind: 'link', url: link.url } });
    }
  }
  return index;
}

/**
 * What the list knows about a select value (catalogue metadata, checksum),
 * or null for a value it does not list (a benchmark's own option).
 * @param {string} value
 * @returns {PetListItem|null}
 */
export function petModelFor(value) {
  return modelIndex().get(value) ?? null;
}

/**
 * The model to load: the select's value, or the remembered one when the
 * panel is not built (headless EOS / addons).
 * @param {HTMLSelectElement|null|undefined} select
 */
export function selectedPetModel(select) {
  const value = select?.value || getPanelPref('mlipModel') || 'pet-mad-xs.gguf';
  return value === PET_LINK_OPTION ? null : value;
}

const sizeLabel = (bytes) => (bytes ? ` (${formatBytes(bytes)})` : '');

function option(value, text, title = '') {
  const el = document.createElement('option');
  el.value = value;
  el.textContent = text;
  if (title) el.title = title;
  return el;
}

/**
 * Rebuild the catalogue and link groups of the select, keeping the built-in
 * group and options other code appended (benchmarks), then select
 * `preferred` if listed, else the remembered model, else leave it.
 * @param {HTMLSelectElement} select
 * @param {string} [preferred]
 */
export function renderPetModelOptions(select, preferred = rememberedOr(select.value)) {
  select.querySelectorAll('[data-role="mlip-catalogue-group"], [data-role="mlip-link-group"]').forEach((g) => g.remove());
  const linkOption = select.querySelector(`option[value="${PET_LINK_OPTION}"]`);
  const shown = new Set(BUILTIN.keys());
  const addGroup = (label, role, models) => {
    const group = document.createElement('optgroup');
    group.label = label;
    group.dataset.role = role;
    for (const m of models) {
      if (shown.has(m.url)) continue;
      shown.add(m.url);
      group.appendChild(option(m.url, `${m.name}${sizeLabel(m.size)}`, m.description || ''));
    }
    if (group.children.length) select.insertBefore(group, linkOption);
  };
  for (const cat of defaultCatalogues.values()) addGroup(cat.name, 'mlip-catalogue-group', cat.models);
  for (const cat of userCatalogues()) addGroup(cat.name, 'mlip-catalogue-group', cat.models);
  addGroup('Links', 'mlip-link-group', userLinks());
  const listed = (v) => v && [...select.options].some((o) => o.value === v);
  const want = [preferred, getPanelPref('mlipModel')].find(listed);
  if (want) select.value = want;
}

/** The remembered model, unless the "from a link…" box is open. */
function rememberedOr(current) {
  if (current === PET_LINK_OPTION) return current;
  return getPanelPref('mlipModel') || current;
}

/** Show the selected model's line and the link box. */
function refreshSelection(shell) {
  const select = shell.mlipModelSelect;
  if (!select) return;
  const value = select.value;
  shell.mlipLinkRow?.classList.toggle('hidden', value !== PET_LINK_OPTION);
  const item = petModelFor(value);
  let text = '';
  if (item) {
    const where = item.source.kind === 'builtin' ? 'built in, Hugging Face'
      : item.source.kind === 'link' ? `link: ${hostLabel(item.entry.url)}`
        : `catalogue: ${item.source.name}`;
    text = [item.entry.description, describePetModel(item.entry), where].filter(Boolean).join(' · ');
  } else if (value === PET_LINK_OPTION) {
    text = 'A direct link, or the page of a file on Hugging Face, GitHub, GitLab or Dropbox. '
      + 'The server must allow downloads from other websites (CORS).';
  }
  if (shell.mlipModelInfoText) shell.mlipModelInfoText.textContent = text;
  const forgettable = item && (item.source.kind === 'catalogue' || item.source.kind === 'link');
  shell.mlipForgetBtn?.classList.toggle('hidden', !forgettable);
}

function hostLabel(url) {
  try { return new URL(url).host; } catch { return url; }
}

/** Store a catalogue the user added (replacing an older copy of it). */
function rememberCatalogue(catalogue) {
  const { url, name, description, models } = catalogue;
  const rest = userCatalogues().filter((c) => c.url !== url);
  setPanelPref('petCatalogues', [...rest, { url, name, description, models }]);
}

function rememberLink(url, name, info) {
  const keep = info ? { description: info.description, license: info.license, authors: info.authors,
    base: info.base, elements: info.elements?.length ? info.elements : undefined } : undefined;
  setPanelPref('petLinks', [...userLinks().filter((l) => l.url !== url), { url, name, info: keep }]);
}

function select(shell, value) {
  shell.mlipModelSelect.value = value;
  setPanelPref('mlipModel', value);
  refreshSelection(shell);
  notifyPotentialChange();
}

/**
 * Fetch the app's and the user's catalogues again; a catalogue that cannot be
 * reached keeps its stored snapshot.
 * @param {() => void} onChange
 */
async function refreshCatalogues(onChange) {
  const jobs = [
    ...DEFAULT_CATALOGUES.map(async (url) => {
      const cat = await fetchPetCatalogue(url);
      defaultCatalogues.set(url, cat);
    }),
    ...userCatalogues().map(async (stored) => {
      const cat = await fetchPetCatalogue(stored.url);
      if (userCatalogues().some((c) => c.url === stored.url)) rememberCatalogue(cat);
    }),
  ];
  const results = await Promise.allSettled(jobs);
  results.forEach((r) => { if (r.status === 'rejected') console.warn('PET model catalogue not refreshed:', r.reason?.message || r.reason); });
  onChange();
}

/**
 * Wire the model list of the PET-MAD controls.
 * @param {object} shell  getShellBindings() of AtomisticPanels.js
 * @param {{ setStatus: (text: string) => void, loadSelected: () => Promise<unknown> }} hooks
 */
export function bindPetModelList(shell, { setStatus, loadSelected }) {
  const selectEl = shell.mlipModelSelect;
  if (!selectEl) return;
  renderPetModelOptions(selectEl);
  refreshSelection(shell);

  selectEl.addEventListener('change', () => {
    if (selectEl.value !== PET_LINK_OPTION) setPanelPref('mlipModel', selectEl.value);
    refreshSelection(shell);
    if (selectEl.value === PET_LINK_OPTION) shell.mlipLinkInput?.focus();
  });

  const add = async () => {
    const link = shell.mlipLinkInput?.value?.trim();
    if (!link) { setStatus('Paste a link to a .gguf model or a catalogue .json first.'); return; }
    const btn = shell.mlipLinkAddBtn;
    if (btn) btn.disabled = true;
    try {
      setStatus(`opening ${hostLabel(link)} …`);
      const got = await openPetLink(link, {
        onProgress: ({ loadedBytes, totalBytes }) => setStatus(totalBytes
          ? `downloading … ${Math.round((loadedBytes / totalBytes) * 100)}%`
          : `downloading … ${Math.round(loadedBytes / 1e6)} MB`),
      });
      if (got.kind === 'catalogue') {
        const cat = got.catalogue;
        if (!cat.models.length) throw new Error(`catalogue "${cat.name}" lists no usable model${cat.warnings.length ? ` (${cat.warnings.join('; ')})` : ''}`);
        if (!DEFAULT_CATALOGUES.includes(cat.url)) rememberCatalogue(cat);
        else defaultCatalogues.set(cat.url, cat);
        renderPetModelOptions(selectEl, cat.models[0].url);
        select(shell, cat.models[0].url);
        const skipped = cat.warnings.length ? `; left out: ${cat.warnings.join('; ')}` : '';
        setStatus(`Catalogue "${cat.name}": ${cat.models.length} model${cat.models.length === 1 ? '' : 's'} added to the list${skipped}`);
      } else {
        rememberLink(got.url, got.name, got.info);
        renderPetModelOptions(selectEl, got.url);
        select(shell, got.url);
        if (shell.mlipLinkInput) shell.mlipLinkInput.value = '';
        await loadSelected();
      }
    } catch (error) {
      setStatus(`Link: ${error.message || String(error)}`);
    } finally {
      if (btn) btn.disabled = false;
    }
  };
  shell.mlipLinkAddBtn?.addEventListener('click', add);
  shell.mlipLinkInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); add(); }
  });

  shell.mlipForgetBtn?.addEventListener('click', () => {
    const item = petModelFor(selectEl.value);
    if (!item) return;
    if (item.source.kind === 'catalogue') {
      const url = item.source.url;
      setPanelPref('petCatalogues', userCatalogues().filter((c) => c.url !== url));
      setStatus(`Catalogue "${item.source.name}" removed from the list.`);
    } else if (item.source.kind === 'link') {
      setPanelPref('petLinks', userLinks().filter((l) => l.url !== item.entry.url));
      setStatus(`${item.entry.name} removed from the list.`);
    } else return;
    renderPetModelOptions(selectEl, 'pet-mad-xs.gguf');
    select(shell, 'pet-mad-xs.gguf');
  });

  refreshCatalogues(() => {
    renderPetModelOptions(selectEl);
    refreshSelection(shell);
  });
}
