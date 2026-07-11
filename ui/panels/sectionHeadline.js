// Non-interactive section headline used inside panel window bodies — the flat
// replacement for the old collapsible flip-outs (the window itself is
// collapsible, so sections don't need to be). A plain <label>, so it renders
// with the same font as the control labels ("Atom Size:" etc.), like the
// Settings window's original "Local storage" header.

/** @param {string} text */
export function makeSectionHeadline(text) {
  const head = document.createElement('label');
  head.className = 'panel-headline';
  head.textContent = text;
  return head;
}
