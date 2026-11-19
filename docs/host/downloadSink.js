// Where the app's downloads go in a window the Python host launched.
// BrowserHost.js sets a sink in such a window; downloadBlob (ui/SavePanel.js),
// the one path every app download takes, offers its file to it. When the host
// takes it (crysviz.Viewer with a download_dir; crysviz-mcp's export folder),
// Python saves it there and tells the caller; when it declines, the app
// downloads as usual (a native window's Save dialog). A browser visit sets no
// sink and downloads as it always did.

/** @type {((fileName: string, blob: Blob) => Promise<boolean>)|null} resolves false when the host declines */
let sink = null;
/** Hand-overs still uploading, so a host command can wait for the files it caused. */
const pending = new Set();

export function setDownloadSink(fn) {
  sink = typeof fn === 'function' ? fn : null;
}

/**
 * Offer a download to the host. False when there is no host sink: the caller
 * downloads it itself. True when offered: if the host then declines or fails,
 * `fallback` downloads it the usual way.
 */
export function sendToDownloadSink(fileName, blob, fallback) {
  if (!sink) return false;
  const upload = Promise.resolve()
    .then(() => sink(fileName, blob))
    .catch((error) => { console.warn('CrysViz host download failed', error); return false; })
    .then((taken) => { if (!taken) fallback(fileName, blob); })
    .finally(() => pending.delete(upload));
  pending.add(upload);
  return true;
}

/** Wait for the hand-overs started so far (bounded), so their files exist before a command answers. */
export async function settleDownloads(timeoutMs = 30000) {
  if (!pending.size) return;
  await Promise.race([
    Promise.allSettled([...pending]),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}
