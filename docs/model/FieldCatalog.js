import {
  SPINOR_COMPONENT_LABELS,
  SpinorComponent,
  WaveQuantity,
} from '../math/wave-backend-wasm.js';

/**
 * The tree of fields a file offers, and which of them are actually loaded.
 *
 * A .cube or CHGCAR offers a handful of fields that are all in memory the moment
 * the file is parsed, and the old flat radio table in `ui/FieldPanel.js` was a
 * fine way to show them. A WAVECAR offers nspin × nkpts × nbands wavefunctions —
 * easily tens of thousands — none of which exist until asked for. Those need
 * grouping and they need a load step.
 *
 * `FieldCatalog` covers both. A flat catalog has one level of leaves that are
 * already loaded, so it renders as exactly the table it always was. A
 * wavefunction catalog nests spin → k-point → band, and its leaves carry a
 * `load()` that expands the band on demand. A non-collinear WAVECAR goes one
 * level further — band → spinor component — because there a band is a spinor
 * and offers several fields rather than one.
 *
 * The distinction the rest of the app cares about is `loadedFields()`: only
 * fields that have actually been realised. `ui/FieldPanel.js` exposes that as
 * `fieldBrowser.availableFields`, which is what `ui/PlanesPanel.js` and every
 * other consumer already reads — so an unloaded band never appears in a menu
 * that would try to sample it.
 */

export const NodeKind = Object.freeze({
  GROUP: 'group',
  FIELD: 'field',
});

export class FieldCatalogNode {
  /**
   * @param {object} init
   * @param {string} init.id stable within the catalog
   * @param {string} init.label
   * @param {string} [init.kind] NodeKind
   * @param {FieldCatalogNode[]} [init.children]
   * @param {object} [init.meta] extra columns for the widget (eigenvalue, occupation, …)
   * @param {import('./Field.js').Field} [init.field] for an already-loaded leaf
   * @param {(() => Promise<import('./Field.js').Field>)} [init.load] for a lazy leaf
   * @param {(() => import('./Field.js').Field | null)} [init.peek] cheap "is it loaded?"
   * @param {boolean} [init.collapsed]
   * @param {(() => boolean)} [init.available] whether the entry is offered at all
   *   right now — see the `available` accessor
   */
  constructor(init) {
    this.id = init.id;
    this.label = init.label;
    this.kind = init.kind || NodeKind.FIELD;
    this.children = init.children || [];
    this.meta = init.meta || null;
    this.collapsed = init.collapsed ?? true;

    this._field = init.field || null;
    this._load = init.load || null;
    this._peek = init.peek || null;
    this._available = init.available || null;
    /** @type {Promise<import('./Field.js').Field> | null} in-flight load, so a
     * double click does not start the transform twice */
    this._pending = null;
  }

  get isGroup() { return this.kind === NodeKind.GROUP; }

  /**
   * Whether this entry is worth offering under the catalog's current settings.
   *
   * Almost every node is unconditionally available. The exception is a leaf
   * that would duplicate another one in some modes and not others: the down ×
   * up element of a non-collinear band's density matrix is the conjugate of up
   * × down, so it reduces to the very same grid unless the quantity is Im.
   * Listing it anyway would put an identical field in the list twice.
   */
  get available() { return this._available ? this._available() : true; }

  /**
   * The realised field, or null. Cheap — never triggers a load.
   * @returns {import('./Field.js').Field | null}
   */
  peek() {
    if (this._field) return this._field;
    if (this._peek) return this._peek();
    return null;
  }

  /** Whether this leaf currently has data. */
  get loaded() { return this.peek() !== null; }

  /** Whether this leaf can be loaded (as opposed to being permanently static). */
  get loadable() { return Boolean(this._load); }

  /** True while a load is in flight, so the widget can show a spinner. */
  get loading() { return this._pending !== null; }

  /**
   * Realise this leaf. Concurrent calls share one in-flight promise.
   * @returns {Promise<import('./Field.js').Field>}
   */
  async ensureLoaded() {
    const existing = this.peek();
    if (existing) return existing;
    if (!this._load) throw new Error(`Field "${this.label}" cannot be loaded on demand`);
    if (this._pending) return this._pending;

    this._pending = (async () => {
      try {
        return await this._load();
      } finally {
        this._pending = null;
      }
    })();
    return this._pending;
  }

  /** Depth-first walk including this node. */
  *walk() {
    yield this;
    for (const child of this.children) yield* child.walk();
  }
}

export class FieldCatalog {
  /**
   * @param {object} init
   * @param {string} [init.source] display name of the origin ('CHGCAR', 'WAVECAR', …)
   * @param {FieldCatalogNode[]} [init.nodes]
   * @param {boolean} [init.hierarchical] whether the widget should render groups
   * @param {string} [init.summary] one-line description for the panel header
   */
  constructor({ source = 'Unknown', nodes = [], hierarchical = false, summary = '' } = {}) {
    this.source = source;
    this.nodes = nodes;
    this.hierarchical = hierarchical;
    this.summary = summary;
    // Set by fromWavefunction() for a WAVECAR catalog: the proxy behind the
    // lazily-loaded leaves, and the scalar its bands are currently expanded to.
    // Null / undefined for every eagerly-parsed format, which is how the widget
    // decides whether to show the quantity dropdown and the cache controls.
    /** @type {import('./WavefunctionSource.js').WavefunctionSource | null} */
    this.wavefunction = null;
    /** @type {{value: number} | null} */
    this.quantityRef = null;
    /** @type {number | undefined} defined as an accessor by fromWavefunction() */
    this.quantity = undefined;
    /** @type {FieldCatalogNode | null} lazily created "Derived" group */
    this._derivedGroup = null;
    /** @type {Set<() => void>} redraw callbacks (the widget subscribes) */
    this._listeners = new Set();
  }

  /** @param {() => void} listener @returns {() => void} unsubscribe */
  subscribe(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  /** Tell the widget something changed (a load finished, a field was added). */
  notify() {
    for (const listener of this._listeners) {
      try { listener(); } catch (error) { console.error('FieldCatalog listener failed', error); }
    }
  }

  /** Depth-first walk of every node. */
  *walk() {
    for (const node of this.nodes) yield* node.walk();
  }

  /** @param {string} id @returns {FieldCatalogNode | null} */
  findNode(id) {
    for (const node of this.walk()) if (node.id === id) return node;
    return null;
  }

  /**
   * Every field that currently has data, in tree order.
   *
   * This is the list the rest of the app sees. For a flat catalog it is simply
   * all the fields; for a WAVECAR it is only the bands the user has loaded.
   * @returns {import('./Field.js').Field[]}
   */
  loadedFields() {
    const out = [];
    for (const node of this.walk()) {
      if (node.isGroup) continue;
      const field = node.peek();
      if (field) out.push(field);
    }
    return out;
  }

  /** The node holding a given field, or null. */
  nodeForField(field) {
    if (!field) return null;
    for (const node of this.walk()) {
      if (!node.isGroup && node.peek() === field) return node;
    }
    return null;
  }

  /** Whether anything at all is loaded (drives the panel's empty state). */
  hasLoadedFields() {
    for (const node of this.walk()) {
      if (!node.isGroup && node.peek()) return true;
    }
    return false;
  }

  /**
   * Add a derived (weighted-combination) field under a "Derived" group, which is
   * created on first use so files without any derived fields show no extra
   * grouping.
   * @param {import('./Field.js').Field} field
   * @returns {FieldCatalogNode}
   */
  addDerivedField(field) {
    if (!this._derivedGroup) {
      this._derivedGroup = new FieldCatalogNode({
        id: 'derived',
        label: 'Derived',
        kind: NodeKind.GROUP,
        collapsed: false,
      });
      this.nodes.push(this._derivedGroup);
      this.hierarchical = true;
    }
    const node = new FieldCatalogNode({
      id: `derived:${this._derivedGroup.children.length}:${field.label}`,
      label: field.label,
      field,
    });
    this._derivedGroup.children.push(node);
    this.notify();
    return node;
  }

  /** Remove a derived field node by id. */
  removeNode(id) {
    const prune = (nodes) => {
      const index = nodes.findIndex((n) => n.id === id);
      if (index >= 0) {
        nodes.splice(index, 1);
        return true;
      }
      return nodes.some((n) => prune(n.children));
    };
    const removed = prune(this.nodes);
    if (removed) this.notify();
    return removed;
  }

  /**
   * A flat catalog over already-loaded fields — .cube, CHGCAR, ELFCAR.
   * @param {import('./Field.js').Field[]} fields
   * @param {string} source
   * @returns {FieldCatalog}
   */
  static flat(fields, source) {
    const nodes = (fields || []).map((field, index) => new FieldCatalogNode({
      id: `field:${index}`,
      label: field.label || `Field ${index + 1}`,
      field,
    }));
    return new FieldCatalog({ source, nodes, hierarchical: false });
  }

  /**
   * A spin → k-point → band catalog over a WAVECAR.
   *
   * Nothing is loaded; each band leaf carries a `load()` that expands it through
   * the WASM transform. Single-spin files skip the spin level rather than
   * showing a group of one.
   *
   * A non-collinear file gets one level more. Its band is not a single
   * wavefunction but a two-component spinor, so the band becomes a group and
   * its entries are the two components the file stores plus the elements of the
   * band's density matrix built from them — see `spinorLeaves` below.
   *
   * @param {import('./WavefunctionSource.js').WavefunctionSource} wf
   * @param {{quantity?: number, source?: string}} [options]
   * @returns {FieldCatalog}
   */
  static fromWavefunction(wf, options = {}) {
    // Annotated so the checker keeps it a number: WaveQuantity.DENSITY is 0, and
    // an unannotated literal would be inferred as the literal type 0, making
    // every other quantity unassignable.
    /** @type {{value: number}} */
    const quantityRef = { value: options.quantity ?? WaveQuantity.DENSITY };

    const bandMeta = (spin, kpt, band) => ({
      eigenvalue: wf.eigenvalues?.[spin - 1]?.[kpt - 1]?.[band - 1],
      occupation: wf.occupations?.[spin - 1]?.[kpt - 1]?.[band - 1],
      spin,
      kpt,
      band,
    });

    /**
     * The entries one non-collinear band offers.
     *
     * The file stores psi_up and psi_down over the same G-vectors, so both are
     * listed directly. On top of them come the elements of that band's density
     * matrix rho_ab = conj(psi_a) psi_b: the diagonal is the density each
     * component carries, and the off-diagonal is the transverse part.
     *
     * Only one off-diagonal is listed while the two are indistinguishable. rho
     * is Hermitian for a single band, so rho_du = conj(rho_ud), and every
     * reduction except Im collapses them onto the same grid; `available` puts
     * down × up back in the list exactly when Im is what is being drawn.
     */
    const spinorLeaves = (spin, kpt, band) => SPINOR_COMPONENT_LABELS.map(
      ({ value: spinor, label }) => new FieldCatalogNode({
        id: `wf:${spin}:${kpt}:${band}:${spinor}`,
        label,
        // No eigenvalue or occupation here: those belong to the band, which is
        // now the group above, and repeating them on all five component rows
        // would say the same number five times.
        meta: { spin, kpt, band, spinor },
        available: spinor === SpinorComponent.DOWN_UP
          ? () => wf.offDiagonalsDiffer(quantityRef.value)
          : undefined,
        load: () => wf.getField(spin, kpt, band, quantityRef.value, spinor),
        peek: () => wf.peekField(spin, kpt, band, quantityRef.value, spinor),
      }));

    const bandNode = (spin, kpt, band) => (wf.noncollinear
      ? new FieldCatalogNode({
        id: `wf:${spin}:${kpt}:${band}`,
        label: `Band ${band}`,
        kind: NodeKind.GROUP,
        meta: bandMeta(spin, kpt, band),
        children: spinorLeaves(spin, kpt, band),
      })
      : new FieldCatalogNode({
        id: `wf:${spin}:${kpt}:${band}`,
        label: `Band ${band}`,
        meta: bandMeta(spin, kpt, band),
        // `quantityRef` is read at call time so switching the quantity dropdown
        // re-points every leaf at the right cache entry without rebuilding the
        // tree (and without losing which groups the user had expanded).
        load: () => wf.getField(spin, kpt, band, quantityRef.value),
        peek: () => wf.peekField(spin, kpt, band, quantityRef.value),
      }));

    const kpointNode = (spin, kpt) => {
      const k = wf.kpoints[kpt - 1];
      const coords = k ? `(${k.map((v) => v.toFixed(3)).join(', ')})` : '';
      return new FieldCatalogNode({
        id: `wf:${spin}:${kpt}`,
        label: `k-point ${kpt} ${coords}`,
        kind: NodeKind.GROUP,
        meta: { spin, kpt, kvector: k },
        children: Array.from({ length: wf.nbands }, (_, i) => bandNode(spin, kpt, i + 1)),
      });
    };

    let nodes;
    if (wf.nspin > 1) {
      nodes = Array.from({ length: wf.nspin }, (_, s) => new FieldCatalogNode({
        id: `wf:spin:${s + 1}`,
        label: s === 0 ? 'Spin up' : 'Spin down',
        kind: NodeKind.GROUP,
        meta: { spin: s + 1 },
        children: Array.from({ length: wf.nkpts }, (_, k) => kpointNode(s + 1, k + 1)),
      }));
    } else {
      nodes = Array.from({ length: wf.nkpts }, (_, k) => kpointNode(1, k + 1));
    }

    const catalog = new FieldCatalog({
      source: options.source || 'WAVECAR',
      nodes,
      hierarchical: true,
      summary: wf.describe(),
    });

    // The quantity lives on the catalog so the widget can offer one dropdown for
    // the whole file rather than one per band.
    catalog.wavefunction = wf;
    catalog.quantityRef = quantityRef;
    Object.defineProperty(catalog, 'quantity', {
      get: () => quantityRef.value,
      set: (value) => { quantityRef.value = value; catalog.notify(); },
      enumerable: true,
    });

    return catalog;
  }
}
