import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  startChrome, stopChrome, connectBrowser, browserWSEndpoint,
  readManagedStateForPort, launchedEndpointMatches,
} from '../../scripts/browser-control.mjs';

test('native sandboxed browser: navigation, eval, screenshot, ownership, endpoint identity and cleanup', { timeout: 120000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'bt-platform-smoke-'));
  const oldCache = process.env.BROWSER_TOOLS_CACHE_DIR;
  process.env.BROWSER_TOOLS_CACHE_DIR = join(root, 'cache');
  const server = createServer((request, response) => response.end('<title>Platform smoke</title><h1>Linux and macOS</h1><script>window.answer=42</script>'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let started;
  let browser;
  try {
    console.error('smoke: starting native browser');
    started = await startChrome({ port: 19450, autoAllocatePort: true, headless: true, ownerId: 'platform-smoke' });
    console.error('smoke: native browser started');
    const { port, ownerToken } = started;
    const state = readManagedStateForPort(port);
    assert.equal(statSync(state.userDataDir).mode & 0o777, 0o700);
    assert.equal(state.args.includes('--no-sandbox'), false);
    const endpoint = await browserWSEndpoint(port);
    // Force the fixed-port proof path, even on builds that happen to write the marker.
    rmSync(join(state.userDataDir, 'DevToolsActivePort'), { force: true });
    assert.equal(await launchedEndpointMatches({ port, endpoint, state }), true);
    assert.equal(await launchedEndpointMatches({ port, endpoint, state: { ...state, managedToken: 'wrong-launch' } }), false);
    await assert.rejects(connectBrowser(port, { ownerToken: 'wrong-owner' }), /owner-token-mismatch/);
    assert.equal(stopChrome({ port, ownerToken: 'wrong-owner', clean: true }).status, 'not-owned');
    assert.ok(existsSync(state.userDataDir));
    console.error('smoke: endpoint and ownership proofs passed');
    browser = await connectBrowser(port, { ownerToken });
    const page = await browser.newPage({ background: true });
    assert.equal((await page.goto('http://127.0.0.1:' + server.address().port)).status(), 200);
    assert.equal(await page.title(), 'Platform smoke');
    assert.equal(await page.evaluate(() => window.answer), 42);
    const ua = await page.evaluate(() => navigator.userAgent);
    assert.equal(ua.includes('HeadlessChrome'), false);
    if (process.platform === 'linux') assert.match(ua, /Linux/);
    // Bot defenses reject a page that reports automation or headless Chrome's default 800x600 screen.
    // A headless background tab reports a 0x0 window, so the window size is read from a page in its own window.
    const windowed = await browser.newPage({ type: 'window', background: true });
    const fingerprint = await windowed.evaluate(() => ({ webdriver: navigator.webdriver, screen: [screen.width, screen.height], outer: [outerWidth, outerHeight] }));
    await windowed.close();
    assert.equal(fingerprint.webdriver, false);
    assert.ok(fingerprint.screen[0] > 800 && fingerprint.screen[1] > 600, `screen ${fingerprint.screen}`);
    assert.ok(fingerprint.outer[0] > 800 && fingerprint.outer[0] <= fingerprint.screen[0] && fingerprint.outer[1] <= fingerprint.screen[1], `window ${fingerprint.outer} on ${fingerprint.screen}`);
    const screenshot = join(root, 'smoke.png');
    await page.screenshot({ path: screenshot });
    assert.ok(statSync(screenshot).size > 100);
    console.error('smoke: navigation/eval/screenshot passed');
    browser.disconnect(); browser = null;
    // The backend does not send Runtime.enable, so console and page-error events are off unless a
    // process opts out of that patch. The documented opt-out must keep working with the pinned backend.
    const pageEvents = async () => {
      const connection = await connectBrowser(port, { ownerToken });
      try {
        const observed = await connection.newPage({ background: true });
        const events = [];
        observed.on('console', message => events.push(`console:${message.text()}`));
        observed.on('pageerror', error => events.push(`pageerror:${error.message}`));
        await observed.goto('http://127.0.0.1:' + server.address().port);
        await observed.evaluate(() => { console.log('smoke-log'); setTimeout(() => { throw new Error('smoke-error'); }, 0); });
        await new Promise(resolve => setTimeout(resolve, 500));
        await observed.close();
        return events;
      } finally {
        connection.disconnect();
      }
    };
    const oldFixMode = process.env.REBROWSER_PATCHES_RUNTIME_FIX_MODE;
    try {
      delete process.env.REBROWSER_PATCHES_RUNTIME_FIX_MODE;
      assert.deepEqual(await pageEvents(), []);
      process.env.REBROWSER_PATCHES_RUNTIME_FIX_MODE = '0';
      const restored = await pageEvents();
      assert.equal(restored.length, 2, restored.join(', '));
      assert.equal(restored[0], 'console:smoke-log');
      assert.match(restored[1], /^pageerror:.*smoke-error$/);
    } finally {
      if (oldFixMode === undefined) delete process.env.REBROWSER_PATCHES_RUNTIME_FIX_MODE;
      else process.env.REBROWSER_PATCHES_RUNTIME_FIX_MODE = oldFixMode;
    }
    console.error('smoke: page event opt-out passed');
    assert.ok(['stopped', 'already-gone', 'killed'].includes(stopChrome({ port, ownerToken, clean: true }).status));
    assert.equal(await browserWSEndpoint(port, 250), null);
    assert.equal(existsSync(state.userDataDir), false);
  } finally {
    browser?.disconnect();
    if (started) stopChrome({ port: started.port, ownerToken: started.ownerToken, clean: true });
    await new Promise(resolve => server.close(resolve));
    if (oldCache === undefined) delete process.env.BROWSER_TOOLS_CACHE_DIR;
    else process.env.BROWSER_TOOLS_CACHE_DIR = oldCache;
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
