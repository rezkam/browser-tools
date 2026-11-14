import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startChrome, stopChrome, connectBrowser } from '../../scripts/browser-control.mjs';
import { capturePage, pngSize, withViewport } from '../../scripts/viewport.mjs';

const BIN = fileURLToPath(new URL('../../bin/browser-tools.mjs', import.meta.url));
const PAGE = '<meta name="viewport" content="width=device-width"><style>body{margin:0}table{width:100%}</style>'
  + '<table id="t" border="1"><tr><td>a</td><td>b</td></tr></table><div style="height:2000px"></div>'
  + '<script>window.widthAtLoad = innerWidth</script>';

test('a requested screen size reaches the screenshot and the page, and does not outlive the command', { timeout: 120000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'bt-viewport-'));
  const oldCache = process.env.BROWSER_TOOLS_CACHE_DIR;
  const oldArtifacts = process.env.BROWSER_TOOLS_ARTIFACT_DIR;
  process.env.BROWSER_TOOLS_CACHE_DIR = join(root, 'cache');
  process.env.BROWSER_TOOLS_ARTIFACT_DIR = join(root, 'artifacts');
  const server = createServer((request, response) => { response.setHeader('content-type', 'text/html'); response.end(PAGE); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  let started;
  try {
    started = await startChrome({ port: 19460, autoAllocatePort: true, headless: true, ownerId: 'viewport-test' });
    const { port, ownerToken } = started;
    // The fixture server shares this process, so a blocking child would starve the page it loads.
    const cli = (...args) => new Promise(resolve => {
      execFile(process.execPath, [BIN, ...args, '--port', String(port)], {
        encoding: 'utf-8', timeout: 30000, env: { ...process.env, BROWSER_TOOLS_OWNER_TOKEN: ownerToken },
      }, (error, stdout, stderr) => resolve({ status: error ? error.code ?? null : 0, stdout: stdout.trim(), stderr: stderr.trim() }));
    });
    const shot = async (...args) => {
      const result = await cli('screenshot', ...args);
      assert.equal(result.status, 0, result.stderr);
      return pngSize(readFileSync(result.stdout.split('\n').at(-1)));
    };
    const browser = await connectBrowser(port, { ownerToken });
    const others = await browser.pages();
    const page = await browser.newPage({ background: true });
    await page.goto(url);
    // Browser Tools opens tabs in the background by default, and Puppeteer's own element capture
    // waits forever on a hidden tab. The capture must finish there.
    assert.equal(await page.evaluate(() => document.visibilityState), 'hidden');
    const element = pngSize(await Promise.race([
      capturePage(page, { selector: '#t' }),
      new Promise((resolve, reject) => setTimeout(reject, 10000, new Error('element capture did not finish on a hidden tab'))),
    ]));
    // The table spans the desktop page, give or take a scrollbar.
    const pageWidth = await page.evaluate(() => innerWidth);
    assert.ok(element.width > 375 && pageWidth - element.width <= 20, `element ${element.width} on a ${pageWidth} px page`);
    // Chrome does not draw a hidden tab, and without a drawn frame it keeps the size it was last
    // given. The tab must be back at its own size when a sized call returns.
    const size = () => page.evaluate(() => [innerWidth, innerHeight].join());
    const phone = { width: 375, height: 667, deviceScaleFactor: 1, mobile: true };
    const own = await size();
    assert.equal(await withViewport(page, phone, size), '375,667');
    assert.equal(await size(), own);
    assert.equal(pngSize(await capturePage(page, { viewport: phone, selector: '#t' })).width, 375);
    assert.equal(await size(), own);
    await assert.rejects(capturePage(page, { viewport: phone, selector: '#absent' }), /No element matches #absent/);
    assert.equal(await size(), own);
    assert.equal(await page.evaluate(() => document.visibilityState), 'hidden');
    // Leave the fixture as the only tab, so it is the active tab for the commands below.
    for (const other of others) await other.close();
    browser.disconnect();
    const run = async (...args) => (await cli(...args)).stdout;

    const desktop = Number(await run('eval', 'innerWidth'));
    assert.ok(desktop > 375, `desktop width ${desktop}`);
    // An unsized full-page capture covers the whole document, without the scrollbar gutter.
    const whole = await shot('--full');
    assert.ok(whole.width <= desktop && desktop - whole.width <= 20 && whole.height > 2000, `full page ${whole.width}x${whole.height} on a ${desktop} px page`);

    assert.deepEqual(await shot('--viewport', '375x667', '--mobile'), { width: 375, height: 667 });
    assert.deepEqual(await shot('--viewport', '375x667', '--scale', '2'), { width: 750, height: 1334 });
    // A phone has no scrollbar gutter, so the content is exactly as wide as the screen.
    const full = await shot('--viewport', '375x667', '--mobile', '--full');
    assert.ok(full.width === 375 && full.height > 2000, `full page ${full.width}x${full.height}`);

    const measured = await cli('eval', '--viewport', '375x667', '--mobile', '[innerWidth, Math.round(document.querySelector("#t").getBoundingClientRect().width)].join()');
    assert.equal(measured.stdout, '375,375', measured.stderr);

    // An element capture is exactly as wide as the element.
    assert.equal((await shot('--viewport', '375x667', '--mobile', '--selector', '#t')).width, 375);
    const unsized = (await shot('--selector', '#t')).width;
    assert.ok(unsized > 375 && desktop - unsized <= 20, `element ${unsized} on a ${desktop} px page`);
    const missing = await cli('screenshot', '--selector', '#absent');
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /No element matches #absent/);

    // The size belongs to the command that asked for it, and asking for it must not reload the tab.
    assert.equal(Number(await run('eval', 'innerWidth')), desktop);
    assert.equal(Number(await run('eval', 'widthAtLoad')), desktop);

    // A page that picks its layout while loading has to be loaded at that size.
    assert.equal((await cli('nav', url, '--viewport', '375x667', '--mobile')).status, 0);
    assert.equal(await run('eval', 'widthAtLoad'), '375');

    // A size sent as a raw call ends with that call. Say so instead of leaving a silent desktop page.
    const raw = await cli('cdp', 'call', 'Emulation.setDeviceMetricsOverride', '--params', '{"width":375,"height":667,"deviceScaleFactor":1,"mobile":true}');
    assert.equal(raw.status, 0, raw.stderr);
    assert.match(raw.stderr, /ends with this command.*--viewport/s);
    assert.equal(Number(await run('eval', 'innerWidth')), desktop);

    for (const bad of [['--mobile'], ['--scale', '2'], ['--viewport', '375'], ['--viewport', '0x600'], ['--viewport', '375x667', '--scale', '0']]) {
      const result = await cli('screenshot', ...bad);
      assert.equal(result.status, 1, bad.join(' '));
      assert.match(result.stderr, /--viewport|--scale/, bad.join(' '));
    }
  } finally {
    if (started) stopChrome({ port: started.port, ownerToken: started.ownerToken, clean: true });
    await new Promise(resolve => server.close(resolve));
    if (oldCache === undefined) delete process.env.BROWSER_TOOLS_CACHE_DIR;
    else process.env.BROWSER_TOOLS_CACHE_DIR = oldCache;
    if (oldArtifacts === undefined) delete process.env.BROWSER_TOOLS_ARTIFACT_DIR;
    else process.env.BROWSER_TOOLS_ARTIFACT_DIR = oldArtifacts;
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
