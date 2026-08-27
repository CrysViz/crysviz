/**
 * A least-recently-used cache with a byte budget rather than an entry count.
 *
 * Built for the WAVECAR proxy (`model/WavefunctionSource.js`), where the two
 * things worth keeping are wildly different sizes: a band's plane-wave
 * coefficients are a few hundred kB, while the real-space grid it expands into
 * is tens of MB. Counting entries would either evict the cheap things
 * pointlessly or let a handful of grids blow past what the tab can hold, so the
 * budget is in bytes and both kinds share it. Eviction is strictly by
 * least-recent use, which naturally drops one big stale grid before a dozen
 * small coefficient arrays.
 *
 * Pinning exists because a field that is *currently on screen* must not be
 * evicted out from under the isosurface: `render/Render3DFieldModule.js` hands
 * `Field.values` straight to marching cubes and both tracers read it again on
 * every re-encode.
 *
 * This is a plain Map with an access-order discipline: Map preserves insertion
 * order, so re-inserting on `get` puts the entry at the back and the first key
 * from `keys()` is always the least recently used.
 */

/** 1 GiB. Chosen to stay clear of the ~2-4 GB per-tab ceiling browsers enforce. */
export const DEFAULT_CACHE_BUDGET_BYTES = 1024 * 1024 * 1024;

/**
 * Byte size of a value we know how to measure. Typed arrays and ArrayBuffers
 * report their real footprint; anything else is treated as free, since the only
 * non-buffer things stored here are small metadata objects.
 * @param {any} value
 * @returns {number}
 */
export function byteSizeOf(value) {
  if (!value) return 0;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  // A Field-like holder: measure the buffer it carries.
  if (value.values && ArrayBuffer.isView(value.values)) return value.values.byteLength;
  return 0;
}

export class LruByteCache {
  /**
   * @param {{budgetBytes?: number, onEvict?: (key: string, value: any) => void}} [options]
   */
  constructor({ budgetBytes = DEFAULT_CACHE_BUDGET_BYTES, onEvict = null } = {}) {
    /** @type {Map<string, {value: any, bytes: number}>} insertion order == access order */
    this._entries = new Map();
    /** @type {Set<string>} keys that must survive eviction */
    this._pinned = new Set();
    this._bytes = 0;
    this._budget = Math.max(0, budgetBytes);
    this._onEvict = onEvict;
  }

  /** Total bytes currently held. */
  get bytes() { return this._bytes; }

  /** Current budget in bytes. */
  get budgetBytes() { return this._budget; }

  /** Number of live entries. */
  get size() { return this._entries.size; }

  /**
   * Change the budget, evicting immediately if the new one is smaller.
   * @param {number} bytes
   */
  setBudget(bytes) {
    this._budget = Math.max(0, bytes);
    this._evictToFit(0);
  }

  /** @param {string} key */
  has(key) { return this._entries.has(key); }

  /**
   * Fetch and mark as most-recently-used.
   * @param {string} key
   * @returns {any} the value, or undefined
   */
  get(key) {
    const entry = this._entries.get(key);
    if (!entry) return undefined;
    // Re-insert to move to the back of the iteration order.
    this._entries.delete(key);
    this._entries.set(key, entry);
    return entry.value;
  }

  /**
   * Insert, evicting least-recently-used entries until the budget fits.
   *
   * An entry larger than the whole budget is still stored (evicting everything
   * else first) rather than silently dropped: the caller asked for this exact
   * field and refusing would leave the UI with nothing to draw. The overshoot
   * is visible via `bytes` exceeding `budgetBytes`.
   *
   * @param {string} key
   * @param {any} value
   * @param {number} [bytes] explicit size; defaults to byteSizeOf(value)
   */
  set(key, value, bytes) {
    const size = Number.isFinite(bytes) ? bytes : byteSizeOf(value);

    if (this._entries.has(key)) this.delete(key);
    this._evictToFit(size);

    this._entries.set(key, { value, bytes: size });
    this._bytes += size;
  }

  /**
   * Remove one entry. Unpins it too, so a pinned key can always be dropped
   * explicitly by its owner.
   * @param {string} key
   * @returns {boolean} whether anything was removed
   */
  delete(key) {
    const entry = this._entries.get(key);
    if (!entry) return false;
    this._entries.delete(key);
    this._pinned.delete(key);
    this._bytes -= entry.bytes;
    return true;
  }

  /**
   * Protect a key from eviction (the field is on screen), or release it.
   * Pinning a key that is not present is a no-op, so callers can pin
   * optimistically after a `set`.
   * @param {string} key
   * @param {boolean} [pinned]
   */
  pin(key, pinned = true) {
    if (pinned) {
      if (this._entries.has(key)) this._pinned.add(key);
    } else {
      this._pinned.delete(key);
    }
  }

  /** @param {string} key */
  isPinned(key) { return this._pinned.has(key); }

  /**
   * Drop everything, pinned included.
   *
   * Deliberately does NOT fire `onEvict`: that callback means "the budget was
   * hit and data was discarded to stay inside it", which the UI surfaces to the
   * user. An explicit clear is the caller's own decision and needs no notice.
   */
  clear() {
    this._entries.clear();
    this._pinned.clear();
    this._bytes = 0;
  }

  /**
   * Evict least-recently-used unpinned entries until `incoming` more bytes fit.
   *
   * Incremental by construction: entries go one at a time, oldest first, and the
   * loop stops the moment the incoming bytes fit. Nothing is dropped while there
   * is still room, and a single large insert never clears more than it has to.
   *
   * Stops early when only pinned entries remain, which is what lets the total
   * exceed the budget when the caller has pinned more than it can afford.
   *
   * @param {number} incoming
   */
  _evictToFit(incoming) {
    if (this._bytes + incoming <= this._budget) return;

    // Map preserves insertion order and `get` re-inserts, so the first key is
    // always the least recently used.
    for (const key of Array.from(this._entries.keys())) {
      if (this._bytes + incoming <= this._budget) return;
      if (this._pinned.has(key)) continue;
      const entry = this._entries.get(key);
      this._entries.delete(key);
      this._bytes -= entry.bytes;
      if (this._onEvict) this._onEvict(key, entry.value);
    }
  }

  /** Diagnostics for the field panel's memory readout. */
  stats() {
    return {
      bytes: this._bytes,
      budgetBytes: this._budget,
      entries: this._entries.size,
      pinned: this._pinned.size,
    };
  }
}
