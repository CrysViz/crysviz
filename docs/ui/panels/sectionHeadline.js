// Non-interactive section headline used inside panel window bodies — the flat
// replacement for the old per-section collapsible flip-outs (the window
// itself is collapsible, so sections don't need to be).

/** @param {string} text */
export function makeSectionHeadline(text) {
  const head = document.createElement('div');
  head.className = 'panel-headline';
  const title = document.createElement('h4');
  title.textContent = text;
  head.appendChild(title);
  return head;
}
