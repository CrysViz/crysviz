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
  } catch (error) {
    hostController.reportError(error);
    hostController.close();
    const status = document.getElementById('status');
    if (status) status.textContent = `Error: ${error.message}`;
    console.error(error);
  }
}

void start();
