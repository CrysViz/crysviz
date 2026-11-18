// @ts-nocheck
// Cross-origin isolation shim for static hosting (GitHub Pages / crysviz.org).
//
// The threaded PET-MAD wasm (external/mlip_wasm/cpu-mt) runs ggml on several
// cores, which needs SharedArrayBuffer, which browsers only expose on a
// cross-origin isolated page: one served with
//   Cross-Origin-Opener-Policy: same-origin
//   Cross-Origin-Embedder-Policy: credentialless
// A static host cannot send those, but a service worker can add them to every
// same-origin response it serves. The page then reloads once so the headers
// apply, and `crossOriginIsolated` is true from then on.
//
// Opt-in only (the PET-MAD "multi-threaded" control; see host/coi.js): COOP
// severs window.opener, which the #load-opener hand-off needs, and
// `credentialless` is what lets cross-origin scripts/images without CORS keep
// loading, so an engine without it (older Safari) simply never isolates.
// Same idea as the widely used coi-serviceworker, written for this repo.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'deregister') {
    self.registration.unregister().then(() => self.clients.matchAll()).then((clients) => {
      clients.forEach((client) => client.navigate(client.url));
    });
  }
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;
  event.respondWith(fetch(request).then((response) => {
    // Opaque (no-CORS cross-origin) responses cannot be re-headed; let them
    // through untouched — credentialless COEP admits them.
    if (response.status === 0 || response.type === 'opaque') return response;
    const headers = new Headers(response.headers);
    headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }));
});
