// .xyz trajectories too large for one string (io/ReadeXYZModule.js
// parseXYZBlob): the worker reads the file in chunks and parses the complete
// frames of each, carrying the rest over. A browser caps a string at ~512 M
// characters, so a GB-sized trajectory could not be loaded at all before.
// Parsed in chunks that cut through lines and frames — and through a
// multi-byte character in a comment — the trajectory must be exactly the one
// a whole-text parse gives: elements, lattice, positions, forces per frame.
// A composition change and a trailing blank line are included.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  const r = await page.evaluate(async () => {
    const { parseXYZFile, parseXYZBlob } = await import('./io/ReadeXYZModule.js');
    const { FileSource } = await import('./io/FileSource.js');
    const parts = [];
    for (let t = 0; t < 9; t++) {
      const n = t < 6 ? 400 : 402; // composition change at frame 6
      parts.push(String(n), `Lattice="20 0 0 0 21 0 0 0 22" Properties=species:S:1:pos:R:3:forces:R:3 note="Å frame ${t}"`);
      for (let i = 0; i < n; i++) {
        const el = i % 3 === 0 ? 'O' : (i >= 400 ? 'H' : 'Si');
        parts.push(`${el} ${(1 + (i % 10) * 1.9 + 0.01 * t).toFixed(5)} ${(1 + Math.floor(i / 10) % 10 * 2).toFixed(5)} ${(1 + Math.floor(i / 100) * 4.1).toFixed(5)} ${Math.sin(i + t).toFixed(5)} 0.5 -0.25`);
      }
    }
    const text = parts.join('\r\n') + '\r\n\r\n';
    const dump = (c) => {
      const out = [];
      for (let f = 0; f < c.store.frameCount; f++) {
        const ph = c.store.getFramePhysics(f);
        out.push({ el: ph.elements.join(), lat: JSON.stringify(ph.lattice), pos: Array.from(ph.positions), frc: ph.forces ? Array.from(ph.forces) : null });
      }
      return out;
    };
    const whole = dump(await parseXYZFile(text, 'whole.xyz'));
    const results = {};
    for (const chunkBytes of [1000, 7777, 65536, 1 << 20]) {
      const chunked = dump(await parseXYZBlob(new Blob([text]), 'chunked.xyz', { chunkBytes }));
      results[chunkBytes] = { frames: chunked.length, same: JSON.stringify(chunked) === JSON.stringify(whole) };
    }
    // A FileSource from a (small) file still takes the text path.
    const viaSource = dump(await parseXYZFile(FileSource.fromFile(new Blob([text])), 'source.xyz'));
    // Through the app's loader, by content: ASE's `.extxyz` and a file with no
    // extension are (ext)XYZ too, although only `.xyz` / `.exyz` say so by name.
    const cv = await import('./core/crystal-viewer.js');
    const { fileBrowser, structureShip } = await import('./state/store.js');
    const byName = {};
    for (const name of ['run.extxyz', 'md_dump']) {
      await cv.loadStructure(new File([text], name), name);
      const c = structureShip.container[fileBrowser.selectedRowIndex];
      byName[name] = c && c.fileName === name && JSON.stringify(dump(c)) === JSON.stringify(whole);
    }
    return { frames: whole.length, results, viaSource: JSON.stringify(viaSource) === JSON.stringify(whole), byName };
  });
  H.check(`whole-text parse: ${r.frames} frames`, r.frames === 9, JSON.stringify(r));
  for (const [chunk, res] of Object.entries(r.results)) {
    H.check(`chunked parse (${chunk}-byte chunks) gives exactly the same trajectory`, res.same && res.frames === 9, JSON.stringify(res));
  }
  H.check('a small file through its FileSource reads the same', r.viaSource, '');
  for (const [name, ok] of Object.entries(r.byName)) {
    H.check(`loading it as "${name}" finds (ext)XYZ by content and reads the same`, ok, '');
  }
  const relevant = errors.filter((e) => !/ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|Plotly/.test(e));
  H.check('no page errors', relevant.length === 0, relevant[0] || '');
  await H.finish(browser);
})().catch(H.crash);
