import { bootstrapAuthoritative, createBrowserHost } from './BrowserHost.js';

// This module is loaded before the application module. It captures the
// launch capability in module-private state and removes it before any later
// application fetch can inherit it through a Referer header.
const launch = (() => {
  const params = new URLSearchParams(window.location.search);
  if (!params.has('_crysviz_manifest')) return { present: false, capability: null };
  const capability = params.get('_crysviz_manifest');
  const url = new URL(window.location.href);
  url.searchParams.delete('_crysviz_manifest');
  window.history.replaceState({}, document.title, url.toString());
  return { present: true, capability };
})();

// Widget mode (?widget=1): capture the launch URL and suppress the full-UI
// chrome up front so it never flashes before WidgetMode.js takes over. The
// href is captured here, before FileURLLoader strips the #load-file hash, so
// the widget's logo can link back to the same structure in the full UI.
const widget = (() => {
  const params = new URLSearchParams(window.location.search);
  if (!params.has('widget')) return { present: false, href: '' };
  const href = window.location.href;
  document.body.classList.add('widget-mode', 'panel-hidden');
  document.getElementById('ui')?.classList.add('panel-hidden');
  return { present: true, href };
})();

// Install the public object while the core module graph is still evaluating.
// It remains NOT_READY until core supplies its private callbacks and finishes
// the authoritative bootstrap.
const hostController = createBrowserHost();
hostController.install();

async function start() {
  try {
    await bootstrapAuthoritative({
      host: hostController,
      launch,
      initialize: async () => {
        const core = await import('../core/crystal-viewer.js');
        return core.initializeCore(hostController);
      },
    });
    hostController.markReady();
    if (widget.present) {
      const { initWidgetMode } = await import('../ui/WidgetMode.js');
      await initWidgetMode({ href: widget.href });
    }
  } catch (error) {
    hostController.reportError(error);
    hostController.close();
    const status = document.getElementById('status');
    if (status) status.textContent = `Error: ${error.message}`;
    // The embed hides all app chrome, so a boot failure would otherwise be a
    // silent blank iframe. Surface a minimal plain-text notice (styled in
    // widgetMode.css). document.body already carries widget-mode from the top.
    if (widget.present && !document.getElementById('widgetBootError')) {
      const el = document.createElement('div');
      el.id = 'widgetBootError';
      el.className = 'widget-boot-error';
      el.textContent = 'CrysViz could not load this structure.';
      document.body.appendChild(el);
    }
    console.error(error);
  }
}

void start();
