import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startChrome, stopChrome, connectBrowser, browserWSEndpoint } from '../../scripts/browser-control.mjs';
import { loadManagedExtension } from '../../scripts/extensions.mjs';

const BIN = fileURLToPath(new URL('../../bin/browser-tools.mjs', import.meta.url));

function extension(directory, version) {
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: 'Browser Tools extension fixture', version,
    permissions: ['storage', 'declarativeNetRequest'], host_permissions: ['http://127.0.0.1/*'],
    background: { service_worker: 'worker.js' },
    content_scripts: [{ matches: ['http://127.0.0.1/*'], js: ['content.js'] }],
  }));
  writeFileSync(join(directory, 'content.js'), `document.documentElement.dataset.extensionVersion=${JSON.stringify(version)};`);
  writeFileSync(join(directory, 'worker.js'), `
    chrome.runtime.onInstalled.addListener(async () => {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [1], addRules: [{
        id: 1, priority: 1,
        action: { type: 'modifyHeaders', requestHeaders: [{ header: 'x-browser-tools-extension', operation: 'set', value: ${JSON.stringify(version)} }] },
        condition: { urlFilter: '127.0.0.1', resourceTypes: ['main_frame'] }
      }] });
    });
  `);
}

test('Rebrowser loads and updates a real MV3 extension, retaining settings and applying network rules', { timeout: 120000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'bt-extensions-'));
  const oldCache = process.env.BROWSER_TOOLS_CACHE_DIR;
  process.env.BROWSER_TOOLS_CACHE_DIR = join(root, 'cache');
  const directory = join(root, 'extension');
  mkdirSync(directory);
  extension(directory, '1.0.0');
  const headers = [];
  const server = createServer((request, response) => {
    headers.push(request.headers['x-browser-tools-extension']);
    response.end('<title>Extension fixture</title><h1>Extension fixture</h1>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let started;
  let browser;
  try {
    const ownerToken = randomUUID();
    const launched = spawnSync(process.execPath, [BIN, 'start', '--headless', '--extension', directory], {
      encoding: 'utf8', env: { ...process.env, BROWSER_TOOLS_OWNER_TOKEN: ownerToken }, timeout: 45000,
    });
    assert.equal(launched.status, 0, launched.stderr);
    const port = Number(launched.stdout.match(/Chrome ready on :(\d+)/)?.[1]);
    assert.ok(port, launched.stdout);
    started = { port, ownerToken };
    assert.match(launched.stdout, /1\.0\.0 loaded.*worker verified: true/);
    await assert.rejects(loadManagedExtension({ port, ownerToken: 'wrong-owner', directory }), /owner-token-mismatch/);
    const installed = await loadManagedExtension({ port, ownerToken, directory });
    assert.match(installed.id, /^[a-p]{32}$/);
    assert.equal(installed.version, '1.0.0');
    browser = await connectBrowser(port, { ownerToken });
    const worker = await (await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().includes(installed.id))).worker();
    await worker.evaluate(() => chrome.storage.local.set({ retainedSetting: 'keep-me' }));
    await worker.evaluate(async () => {
      for (let i = 0; i < 100; i++) {
        if ((await chrome.declarativeNetRequest.getSessionRules()).length) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error('Extension network rules not active');
    });
    const page = await browser.newPage({ background: true });
    const url = 'http://127.0.0.1:' + server.address().port;
    await page.goto(url);
    await page.waitForFunction(() => document.documentElement.dataset.extensionVersion === '1.0.0');
    assert.ok(headers.includes('1.0.0'));
    extension(directory, '1.0.1');
    const update = spawnSync(process.execPath, [BIN, 'extensions', 'update', directory, '--port', String(port)], {
      encoding: 'utf8', env: { ...process.env, BROWSER_TOOLS_OWNER_TOKEN: ownerToken }, timeout: 45000,
    });
    assert.equal(update.status, 0, update.stderr);
    const updated = JSON.parse(update.stdout);
    assert.equal(updated.id, installed.id, 'updates must retain the extension identity');
    assert.equal(updated.version, '1.0.1');
    const nextWorker = await (await browser.waitForTarget(async t => {
      if (t.type() !== 'service_worker' || !t.url().includes(installed.id)) return false;
      try { return await (await t.worker()).evaluate(() => chrome.runtime.getManifest().version === '1.0.1'); }
      catch { return false; }
    })).worker();
    assert.equal(await nextWorker.evaluate(async () => (await chrome.storage.local.get('retainedSetting')).retainedSetting), 'keep-me');
    await nextWorker.evaluate(async () => {
      for (let i = 0; i < 100; i++) {
        const rules = await chrome.declarativeNetRequest.getSessionRules();
        if (rules[0]?.action?.requestHeaders?.[0]?.value === '1.0.1') return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error('Updated network rules not active');
    });
    await page.reload();
    await page.waitForFunction(() => document.documentElement.dataset.extensionVersion === '1.0.1');
    assert.ok(headers.includes('1.0.1'));
    const mismatch = spawnSync(process.execPath, [BIN, 'start', '--headless', '--port', String(port)], {
      encoding: 'utf8', env: { ...process.env, BROWSER_TOOLS_OWNER_TOKEN: ownerToken }, timeout: 10000,
    });
    assert.equal(mismatch.status, 1);
    assert.match(mismatch.stderr, /different extension-debugging permissions/);
  } finally {
    browser?.disconnect();
    if (started) stopChrome({ port: started.port, ownerToken: started.ownerToken, clean: true });
    await new Promise(resolve => server.close(resolve));
    if (oldCache === undefined) delete process.env.BROWSER_TOOLS_CACHE_DIR;
    else process.env.BROWSER_TOOLS_CACHE_DIR = oldCache;
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('an update whose service worker never starts is reported as a failure', { timeout: 60000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'bt-extension-dead-worker-'));
  const oldCache = process.env.BROWSER_TOOLS_CACHE_DIR;
  process.env.BROWSER_TOOLS_CACHE_DIR = join(root, 'cache');
  const directory = join(root, 'extension');
  mkdirSync(directory);
  let started;
  try {
    started = await startChrome({ port: 19470, autoAllocatePort: true, headless: true, ownerId: 'extension-test', extensionDebugging: true });
    const { port, ownerToken } = started;
    extension(directory, '1.0.0');
    writeFileSync(join(directory, 'worker.js'), 'chrome.runtime.onInstalled.addListener(() => {});');
    assert.equal((await loadManagedExtension({ port, ownerToken, directory, timeout: 10000 })).workerVerified, true);
    // Chrome accepts the manifest, but a script that fails to evaluate never becomes a running worker.
    for (const [version, script] of [['1.0.1', 'this is not valid JavaScript ((('], ['1.0.2', 'throw new Error("fails at startup");']]) {
      extension(directory, version);
      writeFileSync(join(directory, 'worker.js'), script);
      await assert.rejects(
        loadManagedExtension({ port, ownerToken, directory, timeout: 3000 }),
        new RegExp(`${version.replaceAll('.', '\\.')}.*service worker did not start`),
      );
    }
    extension(directory, '1.0.3');
    assert.equal((await loadManagedExtension({ port, ownerToken, directory, timeout: 10000 })).workerVerified, true);
  } finally {
    if (started) stopChrome({ port: started.port, ownerToken: started.ownerToken, clean: true });
    if (oldCache === undefined) delete process.env.BROWSER_TOOLS_CACHE_DIR;
    else process.env.BROWSER_TOOLS_CACHE_DIR = oldCache;
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('a failed initial extension load cleans up its newly launched browser',{ timeout: 60000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'bt-extension-failure-'));
  const oldCache = process.env.BROWSER_TOOLS_CACHE_DIR;
  process.env.BROWSER_TOOLS_CACHE_DIR = join(root, 'cache');
  const directory = join(root, 'extension');
  mkdirSync(directory);
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: 'Broken extension fixture', version: '1.0.0',
    background: { service_worker: 'missing-worker.js' },
  }));
  const port = 19461;
  const ownerToken = randomUUID();
  try {
    const failed = spawnSync(process.execPath, [BIN, 'start', '--headless', '--extension', directory, '--port', String(port)], {
      encoding: 'utf8', env: { ...process.env, BROWSER_TOOLS_OWNER_TOKEN: ownerToken }, timeout: 45000,
    });
    assert.equal(failed.status, 1, failed.stderr);
    assert.match(failed.stderr, /Extensions\.loadUnpacked/);
    assert.doesNotMatch(failed.stdout, /Chrome ready/);
    assert.equal(await browserWSEndpoint(port, 250), null);
    const status = spawnSync(process.execPath, [BIN, 'status', '--port', String(port), '--json'], { encoding: 'utf8' });
    assert.equal(status.status, 0, status.stderr);
    assert.deepEqual(JSON.parse(status.stdout), { running: false, port });
  } finally {
    stopChrome({ port, ownerToken, clean: true });
    if (oldCache === undefined) delete process.env.BROWSER_TOOLS_CACHE_DIR;
    else process.env.BROWSER_TOOLS_CACHE_DIR = oldCache;
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
