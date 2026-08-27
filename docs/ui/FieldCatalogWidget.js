import { NodeKind } from '../model/FieldCatalog.js';
import { combineFields } from '../model/CompositeField.js';
import { WAVE_QUANTITY_LABELS } from '../math/wave-backend-wasm.js';
import { createInfoButton } from './InfoPanel.js';

/**
 * The field selector.
 *
 * Replaces the flat radio table that used to be inlined in `ui/FieldPanel.js`.
 * That table assumed every field was already in memory and that there would be a
 * handful of them — true for a .cube or a CHGCAR, and hopelessly wrong for a
 * WAVECAR, which offers nspin × nkpts × nbands entries, none of them loaded.
 *
 * One widget covers both because `model/FieldCatalog.js` describes both:
 *
 *  - a FLAT catalog renders exactly the old table, one radio per field, and no
 *    toolbar. Nothing about the cube/CHGCAR experience changes.
 *  - a HIERARCHICAL catalog renders collapsible groups (spin → k-point → band,
 *    and on a non-collinear file one more level for the spinor components)
 *    whose leaves carry a Load button, the band's eigenvalue and occupation, and
 *    a spinner while the transform runs.
 *
 * Group children are built only when a group is first expanded. A file with 100
 * k-points × 200 bands would otherwise put 20 000 rows in the DOM before the
 * user has clicked anything.
 */

/**
 * What the list's "i" button explains depends on the file behind it: a WAVECAR's
 * entries are unloaded bands under spin/k-point groups, a CHGCAR's are charge and
 * spin blocks that are all in memory already, and an ELF grid is neither. One
 * generic document would have to hedge on all three, so each format gets its own
 * and unknown sources fall back to the generic one.
 */
const FIELD_SELECTION_DOCS = {
  CHGCAR: './data/fieldSelectionChgcarInfo.md',
  ELFCAR: './data/fieldSelectionElfcarInfo.md',
  WAVECAR: './data/fieldSelectionWavecarInfo.md',
};

/**
 * Pick the field-list document for a catalog.
 *
 * Keyed off `wavefunction` first rather than `source` alone: a WAVECAR-backed
 * catalog is the one shape whose UI (groups, Load buttons, the quantity
 * dropdown) is genuinely different, whatever the file was called.
 *
 * @param {import('../model/FieldCatalog.js').FieldCatalog | null} catalog
 * @returns {string}
 */
export function fieldSelectionInfoDoc(catalog) {
  if (catalog?.wavefunction) return FIELD_SELECTION_DOCS.WAVECAR;
  return FIELD_SELECTION_DOCS[catalog?.source] || './data/fieldSelectionInfo.md';
}

/** The "−4.82 eV · occ 1.00" suffix on a band row. */
function formatLeafMeta(meta) {
  if (!meta) return '';
  const parts = [];
  if (Number.isFinite(meta.eigenvalue)) parts.push(`${meta.eigenvalue.toFixed(2)} eV`);
  if (Number.isFinite(meta.occupation)) parts.push(`occ ${meta.occupation.toFixed(2)}`);
  return parts.join(' · ');
}

/**
 * Build the field selector into `container`.
 *
 * @param {object} options
 * @param {HTMLElement} options.container
 * @param {import('../model/FieldCatalog.js').FieldCatalog} options.catalog
 * @param {import('../model/Field.js').Field | null} options.selectedField
 * @param {(field: import('../model/Field.js').Field) => void} options.onSelect
 * @param {(error: Error) => void} [options.onError]
 * @returns {{destroy: () => void, refresh: () => void}}
 */
export function createFieldCatalogWidget({ container, catalog, selectedField, onSelect, onError }) {
  const radioGroupName = `fieldCatalog-${Math.random().toString(36).slice(2)}`;
  let loadedOnly = false;
  let filterText = '';
  let current = selectedField || null;

  const reportError = (error) => {
    console.error('Field catalog', error);
    if (onError) onError(error);
  };

  container.innerHTML = '';
  container.classList.add('field-catalog');

  // ---- toolbar (hierarchical catalogs only) --------------------------------
  if (catalog.hierarchical) {
    container.appendChild(buildToolbar());
  }

  const treeEl = document.createElement('div');
  treeEl.className = 'field-catalog-tree';
  treeEl.setAttribute('role', 'tree');
  container.appendChild(treeEl);

  const derivedEl = document.createElement('div');
  derivedEl.className = 'field-catalog-derived';
  container.appendChild(derivedEl);

  const unsubscribe = catalog.subscribe(() => {
    renderTree();
    renderDerived();
  });

  renderTree();
  renderDerived();

  return {
    destroy() {
      unsubscribe();
      container.innerHTML = '';
      container.classList.remove('field-catalog');
    },
    refresh() {
      renderTree();
      renderDerived();
    },
  };

  // ------------------------------------------------------------------ //

  function buildToolbar() {
    const bar = document.createElement('div');
    bar.className = 'field-catalog-toolbar';

    if (catalog.wavefunction) {
      const quantityLabel = document.createElement('label');
      quantityLabel.className = 'field-catalog-field';
      quantityLabel.textContent = 'Quantity:';
      const select = document.createElement('select');
      select.className = 'field-catalog-select';
      for (const option of WAVE_QUANTITY_LABELS) {
        const el = document.createElement('option');
        el.value = String(option.value);
        el.textContent = option.label;
        if (option.value === catalog.quantity) el.selected = true;
        select.appendChild(el);
      }
      // Switching the quantity re-points every leaf at a different cache entry,
      // so previously-loaded bands appear unloaded until expanded again in the
      // new quantity. That is the honest thing to show: |psi|^2 and Re(psi) are
      // different grids, not different views of one.
      select.addEventListener('change', () => {
        catalog.quantity = Number(select.value);
      });
      quantityLabel.appendChild(select);
      bar.appendChild(quantityLabel);
    }

    const filter = document.createElement('input');
    filter.type = 'search';
    filter.className = 'field-catalog-filter';
    // A flat catalog turns hierarchical once a derived field is added, so this
    // toolbar is not WAVECAR-only and the wording must not assume bands.
    filter.placeholder = catalog.wavefunction ? 'Filter bands…' : 'Filter fields…';
    filter.addEventListener('input', () => {
      filterText = filter.value.trim().toLowerCase();
      renderTree();
    });
    bar.appendChild(filter);

    const loadedToggle = document.createElement('label');
    loadedToggle.className = 'field-catalog-field';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.addEventListener('change', () => {
      loadedOnly = checkbox.checked;
      renderTree();
    });
    loadedToggle.appendChild(checkbox);
    loadedToggle.appendChild(document.createTextNode(' Loaded only'));
    bar.appendChild(loadedToggle);

    return bar;
  }

  /** Whether the node's own label satisfies the text filter. */
  function labelMatches(node) {
    return !filterText || node.label.toLowerCase().includes(filterText);
  }

  /**
   * Whether a node (or any descendant) survives the current filters.
   *
   * A match on a group's own label carries down to its children:
   * `inheritedMatch` is what makes filtering for "Band 12" work on a
   * non-collinear file, where band 12 is a group and its rows are named after
   * spinor components rather than after the band.
   */
  function nodeVisible(node, inheritedMatch = false) {
    if (!node.available) return false;
    const matched = inheritedMatch || labelMatches(node);
    if (node.isGroup) return node.children.some((child) => nodeVisible(child, matched));
    if (loadedOnly && !node.loaded) return false;
    return matched;
  }

  function renderTree() {
    // The tree is rebuilt wholesale whenever the catalog changes — most often
    // because a band finished loading. Without restoring the scroll offset the
    // list would jump back to the top every time, which on a file with hundreds
    // of k-points throws away the user's place just as their click lands.
    const previousScroll = treeEl.scrollTop;
    treeEl.innerHTML = '';
    // Wrapped rather than passed by reference: Array.filter would hand the
    // element's index in as `inheritedMatch`, which is truthy from the second
    // node on and would silently disable the text filter for everything but the
    // first entry.
    const visible = catalog.nodes.filter((node) => nodeVisible(node));
    if (visible.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'field-catalog-empty';
      empty.textContent = loadedOnly
        ? 'No fields loaded yet. Clear "Loaded only" to pick one.'
        : 'Nothing matches the filter.';
      treeEl.appendChild(empty);
      return;
    }
    for (const node of visible) treeEl.appendChild(renderNode(node, 0, false));
    treeEl.scrollTop = previousScroll;
  }

  function renderNode(node, depth, inheritedMatch) {
    return node.isGroup
      ? renderGroup(node, depth, inheritedMatch)
      : renderLeaf(node, depth);
  }

  function renderGroup(node, depth, inheritedMatch) {
    const matched = inheritedMatch || labelMatches(node);
    const wrapper = document.createElement('div');
    wrapper.className = 'fc-group';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'fc-group-toggle';
    // Indentation is expressed as a bounded data attribute rather than an inline
    // style, so the ladder lives in the stylesheet with everything else. The tree
    // is at most three group levels deep: spin > k-point > band on a collinear
    // file, k-point > band > component on a non-collinear one.
    toggle.dataset.depth = String(Math.min(depth, 2));
    toggle.setAttribute('aria-expanded', String(!node.collapsed));

    const caret = document.createElement('span');
    caret.className = 'fc-caret';
    caret.textContent = node.collapsed ? '+' : '−';
    toggle.appendChild(caret);

    const label = document.createElement('span');
    label.className = 'fc-group-label';
    label.textContent = node.label;
    toggle.appendChild(label);

    // A band that holds several entries (a non-collinear spinor) is a group,
    // and its eigenvalue and occupation belong on the header rather than being
    // repeated on every component row underneath it.
    const metaText = formatLeafMeta(node.meta);
    if (metaText) {
      const meta = document.createElement('span');
      meta.className = 'fc-group-meta';
      meta.textContent = metaText;
      toggle.appendChild(meta);
    }

    const count = document.createElement('span');
    count.className = 'fc-group-count';
    const loadedCount = countLoaded(node);
    count.textContent = loadedCount > 0 ? `${loadedCount} loaded` : '';
    toggle.appendChild(count);

    const children = document.createElement('div');
    children.className = 'fc-children';

    // Children are built on expand, not up front: a WAVECAR group can hold
    // hundreds of bands and there can be hundreds of groups.
    const buildChildren = () => {
      children.innerHTML = '';
      for (const child of node.children) {
        if (!nodeVisible(child, matched)) continue;
        children.appendChild(renderNode(child, depth + 1, matched));
      }
    };

    // A filter is only useful if it opens the groups holding the matches.
    const forceOpen = Boolean(filterText) || loadedOnly;
    if (!node.collapsed || forceOpen) buildChildren();
    children.hidden = node.collapsed && !forceOpen;

    toggle.addEventListener('click', () => {
      node.collapsed = !node.collapsed;
      caret.textContent = node.collapsed ? '+' : '−';
      toggle.setAttribute('aria-expanded', String(!node.collapsed));
      if (!node.collapsed) buildChildren();
      children.hidden = node.collapsed;

      // Collapsing from a pinned header removes everything below it, which can
      // leave the view scrolled past the end of the now-shorter list. Pull the
      // header itself back into view so the click lands somewhere sensible.
      if (node.collapsed) toggle.scrollIntoView({ block: 'nearest' });
    });

    wrapper.appendChild(toggle);
    wrapper.appendChild(children);
    return wrapper;
  }

  function countLoaded(node) {
    let n = 0;
    for (const descendant of node.walk()) {
      if (!descendant.isGroup && descendant.loaded) n++;
    }
    return n;
  }

  function renderLeaf(node, depth) {
    const row = document.createElement('div');
    row.className = 'fc-leaf';
    row.dataset.depth = String(Math.min(depth, 3));
    const field = node.peek();
    if (field) row.classList.add('fc-leaf-loaded');

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = radioGroupName;
    radio.className = 'fc-leaf-radio';
    radio.disabled = !field;
    radio.checked = Boolean(field) && field === current;
    radio.addEventListener('change', () => {
      const loaded = node.peek();
      if (loaded) select(loaded);
    });
    row.appendChild(radio);

    const label = document.createElement('span');
    label.className = 'fc-leaf-label';
    label.textContent = node.label;
    row.appendChild(label);

    const metaText = formatLeafMeta(node.meta);
    if (metaText) {
      const meta = document.createElement('span');
      meta.className = 'fc-leaf-meta';
      meta.textContent = metaText;
      row.appendChild(meta);
    }

    if (!field && node.loadable) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'fc-load';
      button.textContent = node.loading ? 'Loading…' : 'Load';
      button.disabled = node.loading;
      button.addEventListener('click', async () => {
        button.disabled = true;
        button.textContent = 'Loading…';
        row.classList.add('fc-leaf-loading');
        try {
          const loaded = await node.ensureLoaded();
          select(loaded);
          catalog.notify();
        } catch (error) {
          row.classList.remove('fc-leaf-loading');
          button.disabled = false;
          button.textContent = 'Load';
          reportError(error);
        }
      });
      row.appendChild(button);
    }

    return row;
  }

  function select(field) {
    current = field;
    onSelect(field);
    // Re-render so the radios and the "N loaded" counts agree with the new
    // state; cheap because only expanded groups have rows.
    renderTree();
    renderDerived();
  }

  // ---- derived (weighted-combination) fields --------------------------------

  function renderDerived() {
    derivedEl.innerHTML = '';
    const loaded = catalog.loadedFields();
    // Combining needs at least two grids to add together.
    if (loaded.length < 2) return;

    const heading = document.createElement('h4');
    heading.className = 'field-catalog-derived-title';
    heading.textContent = 'Combine fields';
    heading.appendChild(createInfoButton('./data/fieldCombineInfo.md', 'About combining fields'));
    derivedEl.appendChild(heading);

    const hint = document.createElement('p');
    hint.className = 'field-catalog-derived-hint';
    hint.textContent = 'Weights are summed. Use −1 to subtract; 0 leaves a field out.';
    derivedEl.appendChild(hint);

    const rows = document.createElement('div');
    rows.className = 'field-catalog-derived-rows';
    /** @type {Array<{field: any, input: HTMLInputElement}>} */
    const terms = [];

    for (const field of loaded) {
      const row = document.createElement('label');
      row.className = 'field-catalog-derived-row';

      const weight = document.createElement('input');
      weight.type = 'number';
      weight.step = '0.1';
      weight.value = '0';
      weight.className = 'field-catalog-weight';
      row.appendChild(weight);

      const name = document.createElement('span');
      name.className = 'field-catalog-derived-name';
      name.textContent = field.label;
      row.appendChild(name);

      rows.appendChild(row);
      terms.push({ field, input: weight });
    }
    derivedEl.appendChild(rows);

    const actions = document.createElement('div');
    actions.className = 'field-catalog-derived-actions';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = 'Name (optional)';
    nameInput.className = 'field-catalog-derived-nameinput';
    actions.appendChild(nameInput);

    const build = document.createElement('button');
    build.type = 'button';
    build.className = 'field-catalog-derived-build';
    build.textContent = 'Create field';
    build.addEventListener('click', () => {
      const chosen = terms
        .map(({ field, input }) => ({ field, weight: Number(input.value) }))
        .filter((t) => Number.isFinite(t.weight) && t.weight !== 0);

      if (chosen.length === 0) {
        reportError(new Error('Set a non-zero weight on at least one field.'));
        return;
      }
      try {
        // Throws on a grid mismatch — combining a WAVECAR band with a CHGCAR
        // grid, say — which is a real error rather than something to paper over.
        const combined = combineFields(chosen, { label: nameInput.value.trim() || undefined });
        catalog.addDerivedField(combined);
        select(combined);
      } catch (error) {
        reportError(error);
      }
    });
    actions.appendChild(build);
    derivedEl.appendChild(actions);
  }
}

export { NodeKind };
