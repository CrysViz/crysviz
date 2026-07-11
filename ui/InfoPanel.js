// Simple markdown renderer (for basic formatting)
function renderMarkdown(text) {
  return text
    .replace(/^# (.*$)/gm, '<h1>$1</h1>') // Headers
    .replace(/^## (.*$)/gm, '<h2>$1</h2>')
    .replace(/^### (.*$)/gm, '<h3>$1</h3>')
    .replace(/^\> (.*$)/gm, '<blockquote>$1</blockquote>') // Blockquotes
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>') // Bold
    .replace(/\*(.*?)\*/g, '<em>$1</em>') // Italic
    .replace(/`(.*?)`/g, '<code>$1</code>') // Inline code
    .replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2">$1</a>') // Links
    .replace(/^\- (.*$)/gm, '<li>$1</li>') // Lists
    .replace(/<li>.*<\/li>/gms, (match) => `<ul>${match}</ul>`);
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

  // Create close button
  const closeButton = document.createElement('button');
  closeButton.className = 'info-panel-close';
  closeButton.textContent = 'Close';
  closeButton.onclick = () => {
    panel.remove();
    overlay.remove();
  };

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
    content.innerHTML = `<p>Error loading info: ${error.message}</p>`;
  }
}

