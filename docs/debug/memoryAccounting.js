/**
 * Accounted memory per loaded structure/trajectory container.
 *
 * A browser exposes no per-object heap attribution (performance.memory, where
 * it exists at all, is one quantised number for the whole page), so the
 * Debug panel's "memory per trajectory" is ACCOUNTED from the data model: a
 * conservative walk over everything a StructureContainer references, summing
 * the real byteLength of every typed array (the frame store's positions /
 * forces / moments are exact) and a fixed per-node estimate for plain JS
 * objects, arrays, Maps and strings (V8-ish sizes; close enough to compare
 * one sample with the next, which is what a leak hunt needs).
 *
 * What the walk deliberately does NOT enter:
 *   - three.js scene objects, geometries, materials, textures (the render
 *     layer owns those; they are counted as references, not bytes),
 *   - DOM nodes, Promises, functions, Weak collections,
 *   - accessor properties. The live trajectory Structure carries lazy
 *     `original` / `originalSpins` getters that MATERIALISE a pristine frame
 *     on first read — reading them from here would allocate the very memory
 *     being measured.
 *
 * One `seen` set is shared across all containers of a sample, so an object
 * reachable from two containers (an interned elements array, a shared
 * Structure) is attributed once, to the first container that reached it.
 */

// Estimated fixed costs (bytes). Object/array headers, per-property slots,
// Map/Set entry overhead — coarse, but consistent between samples.
const OBJECT_BASE = 32;
const PROP_SLOT = 16;
const ARRAY_BASE = 32;
const ARRAY_SLOT = 8;
const MAP_BASE = 48;
const MAP_ENTRY = 24;
const STRING_BASE = 16;
const TYPED_BASE = 48;

/** Hard cap on nodes visited per walk: a runaway structure must not hang the UI. */
export const DEFAULT_NODE_BUDGET = 3_000_000;

/**
 * Objects that belong to the render layer, not the data model. Counted as a
 * reference and not entered.
 * @param {any} v
 */
function isRenderObject(v) {
  return !!(v.isObject3D || v.isBufferGeometry || v.isMaterial || v.isTexture
    || v.isWebGLRenderer || v.isWebGLRenderTarget || v.isScene || v.isCamera);
}

/**
 * Rough byte size of `value` and everything reachable from it.
 *
 * @param {any} value
 * @param {{
 *   seen?: WeakSet<object>,
 *   budget?: number,
 *   visit?: (obj: object) => void,
 * }} [opts] `seen` shares de-duplication across calls; `visit` is called for
 *   every object entered (used to find caches to drop); `budget` caps the
 *   number of nodes visited.
 * @returns {{bytes: number, nodes: number, renderRefs: number, truncated: boolean}}
 */
export function roughSizeOf(value, opts = {}) {
  const seen = opts.seen ?? new WeakSet();
  const budget = Number.isFinite(opts.budget) ? opts.budget : DEFAULT_NODE_BUDGET;
  const visit = opts.visit ?? null;
  let bytes = 0;
  let nodes = 0;
  let renderRefs = 0;
  let truncated = false;

  // Explicit stack instead of recursion: a 1790-frame eager container is deep
  // enough in places to make a recursive walk fragile.
  /** @type {any[]} */
  const stack = [value];

  while (stack.length) {
    const v = stack.pop();
    if (v === null || v === undefined) continue;
    const t = typeof v;
    if (t === 'number') { bytes += 8; continue; }
    if (t === 'boolean') { bytes += 4; continue; }
    if (t === 'string') { bytes += STRING_BASE + 2 * v.length; continue; }
    if (t === 'bigint') { bytes += 16; continue; }
    if (t !== 'object') continue; // functions, symbols
    if (seen.has(v)) continue;
    seen.add(v);
    if (nodes++ >= budget) { truncated = true; break; }

    if (ArrayBuffer.isView(v)) {
      bytes += TYPED_BASE + v.byteLength;
      continue;
    }
    if (v instanceof ArrayBuffer) { bytes += TYPED_BASE + v.byteLength; continue; }
    if (typeof Node !== 'undefined' && v instanceof Node) continue;
    if (typeof v.then === 'function') continue;
    if (v instanceof WeakMap || v instanceof WeakSet) { bytes += OBJECT_BASE; continue; }
    if (isRenderObject(v)) { renderRefs++; bytes += OBJECT_BASE; continue; }

    if (visit) visit(v);

    if (Array.isArray(v)) {
      bytes += ARRAY_BASE + ARRAY_SLOT * v.length;
      // A sparse array (the trajectory container's `structures`) has holes;
      // iterating indices would touch nothing for them, and `for..in` on a
      // 2000-slot array is fine.
      for (let i = 0; i < v.length; i++) {
        const item = v[i];
        if (item !== null && typeof item === 'object') stack.push(item);
        else if (typeof item === 'string') bytes += STRING_BASE + 2 * item.length;
      }
      continue;
    }
    if (v instanceof Map) {
      bytes += MAP_BASE + MAP_ENTRY * v.size;
      for (const [k, item] of v) { stack.push(k); stack.push(item); }
      continue;
    }
    if (v instanceof Set) {
      bytes += MAP_BASE + MAP_ENTRY * v.size;
      for (const item of v) stack.push(item);
      continue;
    }

    bytes += OBJECT_BASE;
    for (const key of Object.keys(v)) {
      const desc = Object.getOwnPropertyDescriptor(v, key);
      // Accessors are skipped on purpose (see the header): never call a getter.
      if (!desc || !('value' in desc)) continue;
      bytes += PROP_SLOT + STRING_BASE + 2 * key.length;
      stack.push(desc.value);
    }
  }

  return { bytes, nodes, renderRefs, truncated };
}

/**
 * @typedef {{
 *   label: string,
 *   frames: number,
 *   materialized: number,
 *   isTrajectory: boolean,
 *   storeBytes: number,
 *   recordBytes: number,
 *   liveBytes: number,
 *   structureBytes: number,
 *   otherBytes: number,
 *   totalBytes: number,
 *   renderRefs: number,
 *   truncated: boolean,
 *   stats: Record<string, number> | null,
 *   kind: string,
 * }} ContainerAccount
 */

/**
 * Account one container. `seen` should be shared by every container of one
 * sample (see the header).
 *
 * @param {any} container a StructureContainer or TrajectoryContainer
 * @param {WeakSet<object>} [seen]
 * @param {{visit?: (obj: object) => void}} [opts]
 * @returns {ContainerAccount}
 */
export function accountContainer(container, seen = new WeakSet(), opts = {}) {
  const visit = opts.visit;
  const isTrajectory = !!container && !!container.store && typeof container.frameCount === 'number'
    && '_frameStyles' in container;
  const walk = (/** @type {any} */ v) => roughSizeOf(v, { seen, visit });

  let storeBytes = 0, recordBytes = 0, liveBytes = 0, structureBytes = 0;
  let renderRefs = 0, truncated = false;
  const add = (/** @type {ReturnType<typeof roughSizeOf>} */ r) => {
    renderRefs += r.renderRefs;
    truncated = truncated || r.truncated;
    return r.bytes;
  };

  // The parts a leak hunt wants to see separately are walked FIRST, so the
  // shared `seen` set attributes anything they reach to them rather than to
  // the catch-all "other" pass over the container object itself.
  if (isTrajectory) {
    storeBytes = add(walk(container.store));
    recordBytes = add(walk(container._frameStyles));
    liveBytes = add(walk(container._live));
  } else if (container && Array.isArray(container.structures)) {
    structureBytes = add(walk(container.structures));
  }
  const otherBytes = add(walk(container));

  const frames = container ? (isTrajectory ? container.frameCount : (container.structures?.length ?? 0)) : 0;
  // For a store-backed trajectory this is the number of occupied slots in the
  // sparse `structures` array — the invariant says exactly one; a growing
  // count here IS a leak. Eager containers hold every frame by design.
  const materialized = container && Array.isArray(container.structures)
    ? (isTrajectory ? Object.keys(container.structures).length : container.structures.length)
    : 0;

  return {
    label: container?.fileName ?? '?',
    frames,
    materialized,
    isTrajectory,
    storeBytes,
    recordBytes,
    liveBytes,
    structureBytes,
    otherBytes,
    totalBytes: storeBytes + recordBytes + liveBytes + structureBytes + otherBytes,
    renderRefs,
    truncated,
    stats: isTrajectory && container.debugStats ? { ...container.debugStats } : null,
    // 'trajectory' (one system in motion: fast playback allowed) or 'dataset'
    // (full rebuild every frame); eager containers are not classified.
    kind: isTrajectory && typeof container.motionProfile === 'function'
      ? container.motionProfile().kind : (frames > 1 ? 'eager' : 'single'),
  };
}

/** Bytes as a human-readable string: "12.3 MB", "820 kB", "512 B". */
export function formatBytes(bytes, digits = 1) {
  if (!Number.isFinite(bytes)) return 'n/a';
  const abs = Math.abs(bytes);
  if (abs >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(digits + 1)} GB`;
  if (abs >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(digits)} MB`;
  if (abs >= 1024) return `${(bytes / 1024).toFixed(0)} kB`;
  return `${Math.round(bytes)} B`;
}

/** Bytes -> MiB as a number, for plotting. */
export function toMB(bytes) {
  return Number.isFinite(bytes) ? bytes / (1024 * 1024) : NaN;
}
