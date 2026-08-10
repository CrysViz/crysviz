// SpaceGroupSelect.js
//
// The space-group picker used by the "Symmetry (Wyckoff)" tab: a single text
// box that doubles as a filter over a scrollable list of all 230 groups.
//
// A plain number input was the obvious first thing, but it only works if you
// already know the number. Crystallographers usually think in symbols instead
// ("Fm-3m", "P6_3/mmc"), so the box accepts either: type digits and it matches
// on IT number, type letters and it fuzzy-matches the Hermann-Mauguin symbol
// (spaced or compact), the Schoenflies symbol or the point group. Nothing is
// committed until an entry in the list is chosen, so a half-typed query can
// never leave the tab on a group the user did not mean.
//
// DOM-free crystallography stays in WyckoffProjector.js; this module only
// renders listSpaceGroups() and reports the picked number back.

import { listSpaceGroups } from './WyckoffProjector.js';

// Everything a query may be tested against, lowercased and stripped of the
// separators people leave out ("P 63/m m c", "P6_3/mmc" and "p63/mmc" are all
// the same thing to a search box).
function normalize(text) {
  return String(text).toLowerCase().replace(/[\s_()-]/g, '');
}

function haystack(group) {
  return normalize(`${group.hmShort} ${group.hmCompact} ${group.schoenflies} ${group.pointGroup} ${group.crystalSystem}`);
}

// Characters of `query` appearing in order (not necessarily adjacent) in
// `text` - the usual forgiving fallback for when a substring match misses,
// so "fmm" still finds "Fm-3m".
function isSubsequence(query, text) {
  let index = 0;
  for (const character of text) {
    if (character === query[index]) index += 1;
    if (index === query.length) return true;
  }
  return !query.length;
}

// Lower score sorts first. Exact number beats number prefix beats symbol
// prefix beats symbol substring beats subsequence; ties break on IT number so
// the list always reads in the conventional order.
function score(group, query) {
  const number = String(group.number);
  if (number === query) return 0;
  if (number.startsWith(query)) return 1;

  const text = haystack(group);
  if (normalize(group.hmCompact).startsWith(query)) return 2;
  if (text.startsWith(query)) return 3;
  if (text.includes(query)) return 4;
  if (isSubsequence(query, text)) return 5;
  return null;
}

function filterGroups(groups, rawQuery) {
  const query = normalize(rawQuery);
  if (!query) return groups;

  return groups
    .map((group) => ({ group, rank: score(group, query) }))
    .filter((scored) => scored.rank !== null)
    .sort((a, b) => a.rank - b.rank || a.group.number - b.group.number)
    .map((scored) => scored.group);
}

function describe(group) {
  return `${group.number} · ${group.hmShort}`;
}

// createSpaceGroupSelect(host, { value, onChange })
//   host:     element the combobox is appended to (it is given position:relative
//             so the dropdown can hang off it).
//   value:    initially selected IT number.
//   onChange: optional, called with the new IT number whenever the user picks
//             an entry.
// Returns { getValue, setValue }.
/**
 * @param {HTMLElement} host
 * @param {{ value?: number, onChange?: (spaceGroupNumber: number) => void }} [options]
 */
export function createSpaceGroupSelect(host, { value = 225, onChange } = {}) {
  const groups = listSpaceGroups();
  let selected = groups.find((group) => group.number === Number(value)) ?? groups[0];
  let shown = groups;
  let activeIndex = 0;

  host.classList.add('sg-select-host');

  const input = document.createElement('input');
  input.type = 'text';
  input.setAttribute('role', 'combobox');
  input.setAttribute('autocomplete', 'off');
  input.spellcheck = false;
  input.placeholder = 'Number or symbol, e.g. 225 or Fm-3m';
  input.title = 'Type a space-group number or symbol, or pick from the list';
  input.className = 'sg-select-input';
  input.value = describe(selected);
  host.appendChild(input);

  const list = document.createElement('div');
  list.setAttribute('role', 'listbox');
  list.className = 'sg-select-list';
  host.appendChild(list);

  function isOpen() {
    return list.classList.contains('open');
  }

  function highlight() {
    const items = /** @type {HTMLElement[]} */ ([...list.querySelectorAll('div[role="option"]')]);
    items.forEach((item, index) => {
      item.classList.toggle('is-active', index === activeIndex);
    });
    items[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }

  function renderList(query) {
    shown = filterGroups(groups, query);
    list.innerHTML = '';

    if (!shown.length) {
      const empty = document.createElement('div');
      empty.textContent = 'No matching space group';
      empty.className = 'sg-select-empty';
      list.appendChild(empty);
      return;
    }

    shown.forEach((group, index) => {
      const item = document.createElement('div');
      item.setAttribute('role', 'option');
      item.className = 'sg-select-item';
      item.innerHTML = `
        <span class="sg-select-number">${group.number}</span>
        <span class="sg-select-symbol">${group.hmShort}</span>
        <span class="sg-select-system">${group.crystalSystem}</span>
      `;
      item.addEventListener('mouseenter', () => {
        activeIndex = index;
        highlight();
      });
      // mousedown, not click: the input's blur would close the list first.
      item.addEventListener('mousedown', (event) => {
        event.preventDefault();
        choose(group);
      });
      list.appendChild(item);
    });

    activeIndex = Math.max(0, shown.indexOf(selected));
    highlight();
  }

  function open(query = '') {
    renderList(query);
    list.classList.add('open');
  }

  function close() {
    list.classList.remove('open');
  }

  function choose(group) {
    selected = group;
    input.value = describe(group);
    close();
    onChange?.(group.number);
  }

  input.addEventListener('focus', () => {
    input.select();
    open('');
  });

  input.addEventListener('input', () => open(input.value));

  input.addEventListener('blur', () => {
    close();
    // Abandon whatever was half-typed - only picking an entry changes anything.
    input.value = describe(selected);
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!isOpen()) {
        open(input.value);
        return;
      }
      const step = event.key === 'ArrowDown' ? 1 : -1;
      activeIndex = Math.min(shown.length - 1, Math.max(0, activeIndex + step));
      highlight();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (isOpen() && shown[activeIndex]) choose(shown[activeIndex]);
    } else if (event.key === 'Escape') {
      close();
      input.value = describe(selected);
      input.blur();
    }
  });

  return {
    getValue: () => selected.number,
    setValue: (number) => {
      const group = groups.find((candidate) => candidate.number === Number(number));
      if (group) choose(group);
    },
  };
}
