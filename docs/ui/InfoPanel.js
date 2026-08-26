/**
 * Minimal markdown renderer for the per-panel "i" blurbs in `data/*Info.md`.
 *
 * Line-based rather than a chain of regex substitutions: HTML collapses raw
 * newlines, so blocks have to be wrapped in real <p>/<ul>/<ol> elements or the
 * whole file renders as one run-on paragraph. Supports headings, blockquotes,
 * horizontal rules, nested bullet and numbered lists (nesting by indent),
 * hard-wrapped paragraphs and list items (continuation lines are joined), and
 * inline bold/italic/code/links. Everything else is escaped, not passed
 * through — these files are content, not templates.
 */
function renderMarkdown(markdown) {
  if (!markdown) return '';

  const lines = String(markdown).replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  /** Open lists, outermost first: { tag, indent, liOpen }. */
  const stack = [];
  /** Hard-wrapped lines of the current paragraph or list item. */
  let buffer = [];
  let bufferMode = null; // 'p' | 'li'

  const flush = () => {
    if (!buffer.length) return;
    const content = renderInline(buffer.join(' '));
    buffer = [];
    if (bufferMode === 'li') {
      html.push(`<li>${content}`); // closed by the next sibling / list close
      const top = stack[stack.length - 1];
      if (top) top.liOpen = true;
    } else {
      html.push(`<p>${content}</p>`);
    }
    bufferMode = null;
  };

  const closeLi = (entry) => {
    if (entry?.liOpen) {
      html.push('</li>');
      entry.liOpen = false;
    }
  };

  const closeList = () => {
    const entry = stack.pop();
    closeLi(entry);
    html.push(`</${entry.tag}>`);
  };

  const closeAllLists = () => {
    while (stack.length) closeList();
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, '    ');
    const trimmed = line.trim();

    // Blank line ends the current paragraph/item but not the list itself —
    // "loose" lists (blank lines between top-level bullets) stay one list.
    if (!trimmed) {
      flush();
      continue;
    }

    const heading = trimmed.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flush();
      closeAllLists();
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flush();
      closeAllLists();
      html.push('<hr>');
      continue;
    }

    const quote = trimmed.match(/^>\s?(.*)$/);
    if (quote) {
      flush();
      closeAllLists();
      html.push(`<blockquote>${renderInline(quote[1])}</blockquote>`);
      continue;
    }

    const item = line.match(/^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/);
    if (item) {
      const indent = item[1].length;
      const tag = item[2] ? 'ul' : 'ol';
      flush(); // emits the previous <li>, left open so a nested list can go inside

      // Deeper indent nests inside the still-open <li>; shallower closes back out.
      while (stack.length && indent < stack[stack.length - 1].indent) closeList();

      const top = stack[stack.length - 1];
      if (!top || indent > top.indent) {
        const start = tag === 'ol' ? Number(item[3]) : 1;
        html.push(tag === 'ol' && start !== 1 ? `<ol start="${start}">` : `<${tag}>`);
        stack.push({ tag, indent, liOpen: false });
      } else if (top.tag !== tag) {
        closeList(); // sibling list of the other kind
        const start = tag === 'ol' ? Number(item[3]) : 1;
        html.push(tag === 'ol' && start !== 1 ? `<ol start="${start}">` : `<${tag}>`);
        stack.push({ tag, indent, liOpen: false });
      } else {
        closeLi(top);
      }

      buffer = [item[4].trim()];
      bufferMode = 'li';
      continue;
    }

    // Continuation of the hard-wrapped paragraph or list item above it.
    if (buffer.length) {
      buffer.push(trimmed);
      continue;
    }

    closeAllLists();
    buffer = [trimmed];
    bufferMode = 'p';
  }

  flush();
  closeAllLists();
  return html.join('\n');
}

function escapeHtml(str = '') {
  return String(str).replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}

/** Inline spans. Code, backslash-escaped punctuation and links are pulled out
 *  first so their contents can't be mangled by the emphasis passes, then
 *  re-inserted escaped.
 *
 *  The extractions are ordered the way markdown defines them: a backtick span
 *  wins over what is inside it, a backslash then disarms whatever punctuation
 *  follows it, and only what survives both can still form a link or emphasis.
 *  That ordering is what makes "NGXF \* NGYF" print its asterisks instead of
 *  italicising the gap between them. */
function renderInline(text) {
  if (!text) return '';
  const code = [];
  const escapes = [];
  const links = [];

  let working = String(text)
    .replace(/`([^`]+)`/g, (_, body) => `\u0000CODE${code.push(body) - 1}\u0000`)
    // A backslash before markdown punctuation: keep the character, drop the
    // backslash, and hide it from every rule below.
    .replace(/\\([\\`*_{}[\]()#+\-.!<>|~])/g, (_, ch) => `\u0000ESC${escapes.push(ch) - 1}\u0000`)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => `\u0000LINK${links.push({ label, url }) - 1}\u0000`);

  working = escapeHtml(working)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>');

  return working
    .replace(/\u0000LINK(\d+)\u0000/g, (_, i) => {
      const entry = links[Number(i)];
      if (!entry) return '';
      const href = escapeHtml(entry.url).replace(/`/g, '&#96;');
      return `<a href="${href}" target="_blank" rel="noopener">${escapeHtml(entry.label)}</a>`;
    })
    .replace(/\u0000CODE(\d+)\u0000/g, (_, i) => `<code>${escapeHtml(code[Number(i)])}</code>`)
    .replace(/\u0000ESC(\d+)\u0000/g, (_, i) => escapeHtml(escapes[Number(i)]));
}

/**
 * A small round "i" button that opens a markdown blurb, for explaining one
 * control rather than a whole panel (a panel's own button is built from its
 * `infoMd` in ui/panels/PanelWindow.js).
 *
 * `doc` may be a function so the document can be chosen at click time — the
 * field selector picks a different file per loaded format, and resolving late
 * means the button survives a catalog swap underneath it.
 *
 * @param {string | (() => string)} doc path to the markdown file
 * @param {string} [label] tooltip / accessible name
 * @returns {HTMLButtonElement}
 */
export function createInfoButton(doc, label = 'About this control') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'info-button info-button-inline';
  button.textContent = 'i';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.setAttribute('aria-haspopup', 'dialog');
  button.addEventListener('click', (event) => {
    event.preventDefault();
    // These buttons sit inside <label>s and clickable headings; without this the
    // click would also toggle whatever control owns the row.
    event.stopPropagation();
    const path = typeof doc === 'function' ? doc() : doc;
    if (path) showInfoPanel(path);
  });
  return button;
}

// Show info panel with markdown content
export async function showInfoPanel(mdFilePath) {
  // Create overlay
  const overlay = document.createElement('div');
  overlay.className = 'info-panel-overlay';

  // Create panel
  const panel = document.createElement('div');
  panel.className = 'info-panel';

  // Create content
  const content = document.createElement('div');
  content.className = 'info-panel-content';

  const close = () => {
    panel.remove();
    overlay.remove();
  };

  // Create close button
  const closeButton = document.createElement('button');
  closeButton.className = 'info-panel-close';
  closeButton.textContent = 'Close';
  closeButton.onclick = close;

  // Clicking away dismisses it too. The panel is a sibling of the backdrop
  // rather than a child (it has to outrank it in z-order), so any click that
  // lands on the backdrop is by definition outside the panel — no need to test
  // the event target against it.
  overlay.addEventListener('click', close);

  // Append elements
  panel.appendChild(content);
  panel.appendChild(closeButton);
  document.body.appendChild(overlay);
  document.body.appendChild(panel);

  // Show overlay and panel
  overlay.classList.add('show');
  panel.classList.add('show');

  try {
    const response = await fetch(mdFilePath);
    if (!response.ok) throw new Error('Failed to load markdown file');
    const markdown = await response.text();
    content.innerHTML = renderMarkdown(markdown); // Use your renderer
  } catch (error) {
    content.innerHTML = `<p>Error loading info: ${escapeHtml(error.message)}</p>`;
  }
}
