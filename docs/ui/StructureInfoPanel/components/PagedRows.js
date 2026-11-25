// Paged row lists for the Structure window's per-atom, per-bond and
// per-polyhedron lists. Each row is a DOM subtree with its own editors, so a
// list of one element's 50,000 atoms (or one pair's 200,000 bonds) built in
// one go took minutes and gigabytes — and a 3D pick builds the list to reveal
// the picked row. A short list is built whole, exactly as before; a long one
// shows one page of rows under a pager, and the pick brings up the page that
// holds its row.

/** Rows per page of a long list. */
export const ROW_PAGE_SIZE = 100;
/** Lists up to this many rows are built whole (no pager). */
export const ROW_PAGING_MIN = 1000;

const pageMemory = new WeakMap();

let batchMemo = null;
/**
 * A memo shared by the rows of one list build (null outside one), for what
 * every row looks up and nothing changes while the rows are built (e.g. the
 * element numbering, utils.js elementAtomNumber).
 * @returns {Map<string, any> | null}
 */
export function rowBatchMemo() {
  return batchMemo;
}

function buildRows(buildRow, start, end) {
  const outer = batchMemo;
  batchMemo = outer ?? new Map();
  try {
    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i++) frag.appendChild(buildRow(i));
    return frag;
  } finally {
    batchMemo = outer;
  }
}

/**
 * The page a list showed last, kept across panel rebuilds and dropped with
 * its owner (the structure).
 * @param {any} owner
 * @param {string} key the list within the owner
 * @returns {{page: number, onPage: ((page: number) => void) | null}}
 */
export function rememberedPage(owner, key) {
  if (!owner || typeof owner !== 'object') return { page: 0, onPage: null };
  let pages = pageMemory.get(owner);
  if (!pages) pageMemory.set(owner, pages = new Map());
  return { page: pages.get(key) ?? 0, onPage: (page) => pages.set(key, page) };
}

/**
 * Append the rows of a list of `count` items to `container`: all of them for
 * a short list, one page with a pager above it for a long one.
 * @param {HTMLElement} container
 * @param {number} count
 * @param {(i: number) => HTMLElement} buildRow the row of item i
 * @param {{noun?: string, page?: number, focus?: number, onPage?: ((page: number) => void) | null}} [options]
 *   page: the page to show first; focus: an item whose page to show instead
 *   (-1: none)
 * @returns {{paged: boolean, showItem: (i: number) => void}} showItem brings
 *   up the page holding item i (a no-op for a short list)
 */
export function fillRows(container, count, buildRow, { noun = 'rows', page = 0, focus = -1, onPage = null } = {}) {
  if (count <= ROW_PAGING_MIN) {
    container.appendChild(buildRows(buildRow, 0, count));
    return { paged: false, showItem: () => {} };
  }

  const pages = Math.ceil(count / ROW_PAGE_SIZE);
  const pager = document.createElement('div');
  pager.className = 'row-pager';
  const prev = document.createElement('button');
  prev.type = 'button';
  prev.className = 'btn-mini row-pager-prev';
  prev.textContent = '◀';
  prev.title = `Previous ${ROW_PAGE_SIZE}`;
  const range = document.createElement('span');
  range.className = 'row-pager-range';
  const next = document.createElement('button');
  next.type = 'button';
  next.className = 'btn-mini row-pager-next';
  next.textContent = '▶';
  next.title = `Next ${ROW_PAGE_SIZE}`;
  const go = document.createElement('input');
  go.type = 'number';
  go.className = 'row-pager-goto';
  go.min = '1';
  go.max = String(count);
  go.placeholder = '#';
  go.title = `Show the page with this number (1–${count.toLocaleString()})`;
  pager.append(prev, range, next, go);
  const host = document.createElement('div');
  host.className = 'row-pager-rows';
  container.append(pager, host);

  let current = -1;
  function show(p) {
    p = Math.min(pages - 1, Math.max(0, Math.floor(p) || 0));
    if (p === current) return;
    current = p;
    onPage?.(p);
    const start = p * ROW_PAGE_SIZE;
    const end = Math.min(count, start + ROW_PAGE_SIZE);
    host.replaceChildren(buildRows(buildRow, start, end));
    range.textContent = `${(start + 1).toLocaleString()}–${end.toLocaleString()} of ${count.toLocaleString()} ${noun}`;
    prev.disabled = p === 0;
    next.disabled = p === pages - 1;
  }
  // The pager sits inside panels whose own clicks expand/collapse rows.
  pager.addEventListener('click', (e) => e.stopPropagation());
  prev.addEventListener('click', () => show(current - 1));
  next.addEventListener('click', () => show(current + 1));
  go.addEventListener('change', () => {
    const n = Math.min(count, Math.floor(Number(go.value)));
    if (!(n >= 1)) return;
    show((n - 1) / ROW_PAGE_SIZE);
    host.children[n - 1 - current * ROW_PAGE_SIZE]?.scrollIntoView({ block: 'nearest' });
  });
  show(focus >= 0 && focus < count ? focus / ROW_PAGE_SIZE : page);
  return { paged: true, showItem: (i) => { if (i >= 0 && i < count) show(i / ROW_PAGE_SIZE); } };
}

/**
 * Smooth-scroll a row of one of these lists to the middle of the panel.
 * The rows skip rendering while off screen (content-visibility: auto,
 * structureInfoPanel.css — laying out a whole list of 1000 rows took most of
 * a 3D pick's time), so the rows above one never shown count with their
 * contain-intrinsic-size, and with a fixed guess the scroll stopped short or
 * overshot by a few px per row: hundreds of rows down, out of view. The
 * picked row's real height is that of its neighbours (the rows of a list are
 * alike), so it becomes the list's guess first.
 * @param {HTMLElement} row
 */
export function scrollRowIntoView(row) {
  const list = row.closest('.individual-atoms, .individual-bonds, .individual-polyhedra');
  if (list instanceof HTMLElement) {
    row.style.contentVisibility = 'visible';
    // contain-intrinsic-size is the content box: the padding comes on top.
    const cs = getComputedStyle(row);
    const height = row.getBoundingClientRect().height
      - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)
      - parseFloat(cs.borderTopWidth) - parseFloat(cs.borderBottomWidth);
    row.style.contentVisibility = '';
    if (height > 0) list.style.setProperty('--row-intrinsic-height', `${height}px`);
  }
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
