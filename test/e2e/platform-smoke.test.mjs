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

test('native sandboxed browser: navigation, eval, screenshot, ownership, endpoint identity and cleanup', { timeout: 40000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'bt-platform-smoke-'));
  const oldCache = process.env.BROWSER_TOOLS_CACHE_DIR;
  process.env.BROWSER_TOOLS_CACHE_DIR = join(root, 'cache');
  const server = createServer((request, response) => response.end('<title>Platform smoke</title><h1>Linux and macOS</h1><script>window.answer=42</script>'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let started;
  let browser;
  try {
    started = await startChrome({ port: 19450, autoAllocatePort: true, headless: true, ownerId: 'platform-smoke' });
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
    browser = await connectBrowser(port, { ownerToken });
    const page = await browser.newPage({ background: true });
    assert.equal((await page.goto('http://127.0.0.1:' + server.address().port)).status(), 200);
    assert.equal(await page.title(), 'Platform smoke');
    assert.equal(await page.evaluate(() => window.answer), 42);
    const ua = await page.evaluate(() => navigator.userAgent);
    assert.equal(ua.includes('HeadlessChrome'), false);
    if (process.platform === 'linux') assert.match(ua, /Linux/);
    const screenshot = join(root, 'smoke.png');
    await page.screenshot({ path: screenshot });
    assert.ok(statSync(screenshot).size > 100);
    browser.disconnect(); browser = null;
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
