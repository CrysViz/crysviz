const aboutTrigger = document.getElementById('aboutTrigger');
const aboutOverlay = document.getElementById('aboutOverlay');
const aboutModal = document.getElementById('aboutModal');
const aboutClose = document.getElementById('aboutClose');
const aboutContent = document.getElementById('aboutContent');
let aboutLoaded = false;
let aboutLoading = false;
let aboutPreviousFocus = null;

import {resizeRenderer} from './WindowAndSceneControls.js';

export async function loadAboutContent() {
  if (!aboutContent || aboutLoading || aboutLoaded) return;
  aboutLoading = true;
  aboutContent.innerHTML = '<p id="aboutLoading">Loading About content…</p>';
  try {
    const response = await fetch('./panels/about.md', { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Request failed (${response.status})`);
    }
    const text = await response.text();
    aboutContent.innerHTML = renderMarkdownContent(text) || '<p>No About content available.</p>';
    aboutLoaded = true;
  } catch (error) {
    aboutContent.innerHTML = `<p class="about-error">${escapeHtml(error.message || 'Failed to load About content.')}</p>`;
  } finally {
    aboutLoading = false;
  }
}

export function openAboutPanel() {
  if (!aboutOverlay) return;
  if (aboutOverlay.hasAttribute('hidden')) {
    aboutOverlay.removeAttribute('hidden');
  }
  requestAnimationFrame(() => aboutOverlay.classList.add('visible'));
  aboutPreviousFocus = document.activeElement;
  if (!aboutLoaded) {
    loadAboutContent();
  }
  setTimeout(() => {
    if (aboutModal) {
      aboutModal.focus({ preventScroll: true });
    }
    if (aboutClose) {
      aboutClose.focus({ preventScroll: true });
    }
    resizeRenderer();
  }, 120);
}

export function closeAboutPanel() {
  if (!aboutOverlay) return;
  aboutOverlay.classList.remove('visible');
  setTimeout(() => {
    if (!aboutOverlay.classList.contains('visible')) {
      aboutOverlay.setAttribute('hidden', '');
    }
  }, 160);
  const focusTarget = aboutPreviousFocus;
  aboutPreviousFocus = null;
  if (focusTarget && typeof focusTarget.focus === 'function') {
    setTimeout(() => focusTarget.focus({ preventScroll: true }), 160);
  }
  setTimeout(resizeRenderer, 200);
}

// eventListener

if (aboutTrigger) {
  aboutTrigger.setAttribute('aria-haspopup', 'dialog');
  aboutTrigger.addEventListener('click', (event) => {
    event.preventDefault();
    openAboutPanel();
  });
  aboutTrigger.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openAboutPanel();
    }
  });
}

if (aboutOverlay) {
  aboutOverlay.addEventListener('click', (event) => {
    if (event.target === aboutOverlay) {
      closeAboutPanel();
    }
  });
}

if (aboutClose) {
  aboutClose.addEventListener('click', (event) => {
    event.preventDefault();
    closeAboutPanel();
  });
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && aboutOverlay && !aboutOverlay.hasAttribute('hidden')) {
    closeAboutPanel();
  }
});

function escapeHtml(str = '') {
  return String(str).replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}

function escapeAttribute(str = '') {
  return escapeHtml(str).replace(/`/g, '&#96;');
}

function renderMarkdownContent(markdown) {
  if (!markdown) return '';
  const lines = markdown.split(/\r?\n/);
  const html = [];
  let inList = false;

  const closeList = () => {
    if (inList) {
      html.push('</ul>');
      inList = false;
    }
  };

  lines.forEach(line => {
    const trimmed = line.trim();
    if (!trimmed) {
      closeList();
      html.push('');
      return;
    }

    const headingMatch = trimmed.match(/^(#{1,3})\s+(.*)$/);
    if (headingMatch) {
      closeList();
      const level = headingMatch[1].length;
      const content = renderMarkdownInline(headingMatch[2]);
      html.push(`<h${level}>${content}</h${level}>`);
      return;
    }

    const listMatch = trimmed.match(/^[-*+]\s+(.*)$/);
    if (listMatch) {
      if (!inList) {
        html.push('<ul>');
        inList = true;
      }
      html.push(`<li>${renderMarkdownInline(listMatch[1])}</li>`);
      return;
    }

    closeList();
    html.push(`<p>${renderMarkdownInline(trimmed)}</p>`);
  });

  closeList();
  return html.join('\n');
}

function renderMarkdownInline(text) {
  if (!text) return '';
  const codePlaceholders = [];
  const linkPlaceholders = [];
  let working = text.replace(/`([^`]+)`/g, (_, code) => {
    const index = codePlaceholders.push(code) - 1;
    return `\u0000CODE${index}\u0000`;
  }).replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
    const index = linkPlaceholders.push({ label, url }) - 1;
    return `\u0000LINK${index}\u0000`;
  });

  working = escapeHtml(working);

  working = working.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
                   .replace(/\*(.+?)\*/g, '<em>$1</em>');

  working = working.replace(/\u0000LINK(\d+)\u0000/g, (_, idx) => {
    const entry = linkPlaceholders[Number(idx)];
    if (!entry) return '';
    return `<a href="${escapeAttribute(entry.url)}" target="_blank" rel="noopener">${escapeHtml(entry.label)}</a>`;
  });

  working = working.replace(/\u0000CODE(\d+)\u0000/g, (_, idx) => {
    const code = codePlaceholders[Number(idx)];
    return `<code>${escapeHtml(code)}</code>`;
  });

  return working;
}
