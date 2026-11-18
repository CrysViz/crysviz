// CHGCAR / ELFCAR loading (io/chgcarParse.js, io/ReadChgcarModule.js): the
// file is parsed in a pool worker ('chgcarParse'), handed over as a Blob, and
// the load-progress strip along the top of the view (render/LoadProgressModule.js)
// fills while the worker reads and fades out when the load is done. The view
// keeps drawing frames during the parse, and the fields come out as before:
// blocks scaled to e/Å³ (CHGCAR only), labelled, the spin channels derived,
// augmentation sections and the per-ion line between blocks skipped.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  page.on('dialog', (d) => d.accept());
  await H.loadDefaultStructure(page);

  const result = await page.evaluate(async () => {
    const { loadStructure } = await import('./core/crystal-viewer.js');
    const { fileBrowser } = await import('./state/store.js');

    // A spin-polarised CHGCAR: cubic 5 Å cell (V = 125 Å³), two atoms, two
    // 96³ blocks (~23 MB of text, several parse chunks) with augmentation
    // occupancies and the per-ion line between them.
    const n = 96;
    const count = n * n * n;
    const raw0 = (i) => ((i % 1000) / 100).toExponential(5);
    const raw1 = (i) => (-(i % 500) / 1000).toExponential(5);
    const block = (raw) => {
      const lines = [];
      for (let i = 0; i < count; i += 5) {
        const row = [];
        for (let k = i; k < Math.min(count, i + 5); k++) row.push(raw(k));
        lines.push(` ${row.join(' ')}`);
      }
      return lines.join('\n');
    };
    const header = [
      'synthetic', '   1.0', '     5.0 0.0 0.0', '     0.0 5.0 0.0', '     0.0 0.0 5.0',
      '   Fe   O', '     1     1', 'Direct', '  0.0 0.0 0.0', '  0.5 0.5 0.5', '',
    ].join('\n');
    const aug = 'augmentation occupancies   1   3\n 0.1 0.2 0.3\naugmentation occupancies   2   3\n 0.4 0.5 0.6';
    const text = `${header}\n   ${n}   ${n}   ${n}\n${block(raw0)}\n${aug}\n 0.75 0.75\n   ${n}   ${n}   ${n}\n${block(raw1)}\n${aug}\n`;

    // Which tasks the pool is handed (the pool's workers already exist, so
    // the prototype is the place to listen).
    const tasks = [];
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (msg, ...rest) {
      if (msg && typeof msg.task === 'string') tasks.push(msg.task);
      return post.call(this, msg, ...rest);
    };

    // Frames drawn and widths the strip shows while the load runs.
    let frames = 0;
    let running = true;
    let framesWhenParsed = null;
    const widths = [];
    const tick = () => { frames++; if (running) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    const observer = new MutationObserver(() => {
      const fill = document.querySelector('#loadProgress .tracer-progress-fill');
      if (!fill) return;
      const w = parseFloat(fill.style.width);
      if (widths[widths.length - 1] !== w) widths.push(w);
      if (w >= 94 && framesWhenParsed === null) framesWhenParsed = frames;
    });
    observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['style'] });

    const started = performance.now();
    const status = await loadStructure(new File([text], 'CHGCAR'), 'CHGCAR');
    const loadMs = performance.now() - started;
    running = false;
    observer.disconnect();
    Worker.prototype.postMessage = post;
    const opacityAtEnd = document.getElementById('loadProgress')?.style.opacity;
    await new Promise((r) => setTimeout(r, 800));
    const opacityLater = document.getElementById('loadProgress')?.style.opacity;

    const s = fileBrowser.selectedStructure;
    const fields = s.volumetricFields?.fields ?? [];
    const sample = [0, 1, 999, 1000, 123457, count - 1];
    const expect = (raw, i) => Math.fround(Math.fround(Number(raw(i))) * (1 / 125));
    const valuesOk = fields.length >= 2 && sample.every((i) =>
      fields[0].values[i] === expect(raw0, i) && fields[1].values[i] === expect(raw1, i));

    // ELFCAR: same layout, left unscaled, named per spin channel.
    const elf = `${header}\n   4   4   4\n${Array.from({ length: 64 }, (_, i) => (i / 64).toFixed(5)).join(' ')}\n`
      + `   4   4   4\n${Array.from({ length: 64 }, (_, i) => (1 - i / 64).toFixed(5)).join(' ')}\n`;
    await loadStructure(new File([elf], 'ELFCAR'), 'ELFCAR');
    const e = fileBrowser.selectedStructure.volumetricFields?.fields ?? [];

    return {
      ok: status?.ok, loadMs, tasks, frames, framesWhenParsed, widths, opacityAtEnd, opacityLater,
      atoms: s.atoms.length,
      labels: fields.map((f) => f.label),
      dims: fields.map((f) => `${f.nx}x${f.ny}x${f.nz}`),
      valuesOk,
      sample: sample.map((i) => [fields[0]?.values[i], expect(raw0, i)]),
      maxValue: fields[0]?.maxValue,
      elf: { labels: e.map((f) => f.label), v: e[0]?.values[32], max: e[0]?.maxValue },
    };
  });

  H.check('the CHGCAR loads', result.ok === true && result.atoms === 2, JSON.stringify({ ok: result.ok, atoms: result.atoms }));
  H.check('it is parsed in a pool worker', result.tasks.includes('chgcarParse'), JSON.stringify(result.tasks));
  H.check('the view keeps drawing frames while the worker parses',
    result.framesWhenParsed !== null && result.framesWhenParsed >= 5,
    JSON.stringify({ frames: result.frames, framesWhenParsed: result.framesWhenParsed, loadMs: result.loadMs }));
  const partial = result.widths.filter((w) => w > 0 && w < 90);
  H.check('the strip shows the read progressing, then full',
    result.widths[0] === 0 && partial.length >= 2 && result.widths[result.widths.length - 1] === 100
    && result.widths.every((w, i) => i === 0 || w >= result.widths[i - 1]),
    JSON.stringify(result.widths));
  H.check('the strip fades out after the load', result.opacityAtEnd === '1' && result.opacityLater === '0',
    JSON.stringify({ end: result.opacityAtEnd, later: result.opacityLater }));
  H.check('blocks, labels and derived spin channels are as before',
    JSON.stringify(result.labels) === JSON.stringify(['Charge Density', 'Magnetization Density', 'Spin Up Density', 'Spin Down Density'])
    && result.dims.every((d) => d === '96x96x96'), JSON.stringify({ labels: result.labels, dims: result.dims }));
  H.check('values are scaled to e/Å³ with the cell volume, augmentation skipped',
    result.valuesOk && Math.abs(result.maxValue - 9.99 / 125) < 1e-7, JSON.stringify({ sample: result.sample, max: result.maxValue }));
  H.check('an ELFCAR is left unscaled and named per spin channel',
    JSON.stringify(result.elf.labels) === JSON.stringify(['ELF-up', 'ELF-down'])
    && Math.abs(result.elf.v - 0.5) < 1e-6, JSON.stringify(result.elf));
  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
