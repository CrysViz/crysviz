// Optional real-browser coverage for the installed Python launcher. Set
// CRYSVIZ_COMMAND to the installed crysviz executable in a packaging/browser
// job; ordinary frontend browser runs skip when that executable is absent.
'use strict';
const { spawn } = require('child_process');
const H = require('../harness');

function commandAvailable(command) {
  return new Promise((resolve) => {
    const child = spawn(command, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    child.once('error', () => resolve(false));
    child.once('exit', (code) => resolve(code === 0));
  });
}

(async () => {
  const command = process.env.CRYSVIZ_COMMAND || 'crysviz';
  if (!(await commandAvailable(command))) {
    console.log(`  SKIP  installed CLI browser smoke (${command} is unavailable)`);
    return;
  }
  const { browser, page, errors } = await H.launchApp();
  const child = spawn(command, ['--browser', '--no-open'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  try {
    const url = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('CLI did not print a URL')), 10000);
      child.stdout.on('data', (chunk) => {
        output += chunk.toString();
        const line = output.split(/\r?\n/, 1)[0].trim();
        if (line) { clearTimeout(timer); resolve(line); }
      });
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
    await page.goto(url, { waitUntil: 'load', timeout: 90000 });
    await page.waitForTimeout(5000);
    const state = await page.evaluate(async () => {
      const result = await window.crysvizHost.dispatch({ command: 'list_structures' });
      return { ready: result.ok, count: result.ok ? result.result.length : 0 };
    });
    H.check('installed crysviz --browser --no-open starts the viewer', state.ready && state.count === 1, stderr);
    H.check('installed CLI browser smoke has no page errors', errors.length === 0, errors.join(' | '));
  } finally {
    if (child.exitCode === null) child.kill('SIGINT');
    await H.finish(browser);
  }
})().catch(H.crash);
