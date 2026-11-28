import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchedEndpointMatches, syncChromeProfile, chromeLaunchArgs, managedChromeCommandSafety } from '../scripts/browser-control.mjs';
import { discoverChromeSourceDir } from '../scripts/browser-platform.mjs';

test('endpoint verifier rejects non-managed local listeners without opening a WebSocket', { timeout: 3000 }, async () => {
  let connected = false;
  const server = createServer(() => { connected = true; });
  server.on('upgrade', () => { connected = true; });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    assert.equal(await launchedEndpointMatches({
      port,
      endpoint: 'ws://127.0.0.1:' + port + '/devtools/browser/test',
      state: { userDataDir: '/nonexistent', managedToken: 'test' },
      timeoutMs: 150,
    }), false);
    assert.equal(connected, false);
  } finally {
    await new Promise(r => server.close(r));
  }
});

test('endpoint verifier matches listener PID command arguments without --enable-automation', async () => {
  const port = 19455;
  const state = { userDataDir: '/nonexistent/fixture-profile', managedToken: 'fixture-launch' };
  const managedCommand = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${state.userDataDir}`,
    `--pi-browser-tools-managed=${state.managedToken}`,
    '',
  ].join('\0');
  const probe = (identity, listeners = [4242], commands = new Map([[4242, managedCommand]])) => launchedEndpointMatches({
    port,
    endpoint: `ws://127.0.0.1:${port}/devtools/browser/fixture`,
    state: identity,
    listeningPids: () => listeners,
    readCommand: (pid) => commands.get(pid) ?? null,
  });
  assert.equal(await probe(state), true);
  assert.equal(await probe({ ...state, managedToken: 'other-launch' }), false);
  assert.equal(await probe({ ...state, userDataDir: '/nonexistent/other-profile' }), false);
  assert.equal(await probe(state, []), false, 'no listener must fail closed');
  assert.equal(
    await probe(state, [4242, 9999], new Map([[4242, managedCommand], [9999, 'node rogue-server.js']])),
    false,
    'any non-matching listener on the same port must fail closed',
  );
  assert.equal(await probe(state), true, 'a fresh probe can retry after rejection');
});

test('malformed WebSocket URL fails closed instead of rejecting launch cleanup', async () => {
  assert.equal(await launchedEndpointMatches({ port: 19450, endpoint: 'ws://127.0.0.1:19450/devtools/browser/test#fragment', state: { managedToken: 'test', userDataDir: '/nonexistent' } }), false);
});

test('marker cannot bypass endpoint authority', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bt-marker-'));
  try {
    writeFileSync(join(root, 'DevToolsActivePort'), '19450\n/devtools/browser/test\n');
    for (const endpoint of ['ws://example.invalid:19450/devtools/browser/test', 'http://127.0.0.1:19450/devtools/browser/test', 'ws://127.0.0.1:19450/devtools/browser/test']) {
      assert.equal(await launchedEndpointMatches({ port: 19451, endpoint, state: { userDataDir: root } }), false);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('bare snap PATH override selects snap profile even when native profile exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'bt-bare-snap-'));
  try {
    mkdirSync(join(root, '.config', 'chromium'), { recursive: true });
    mkdirSync(join(root, 'snap', 'chromium', 'common', 'chromium'), { recursive: true });
    writeFileSync(join(root, 'chromium'), '#!/bin/sh\nexec snap run chromium "$@"\n', { mode: 0o755 });
    assert.equal(discoverChromeSourceDir({ chromeBin: 'chromium', platform: 'linux', env: { PATH: root }, home: root }), join(root, 'snap', 'chromium', 'common', 'chromium'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('procfs argv boundaries reject managed flags embedded in another argument', () => {
  const args = chromeLaunchArgs({ port: 9222, managedToken: 'expected' });
  const state = { managedBy: 'browser-tools', pid: 123, port: 9222, userDataDir: args.find(a => a.startsWith('--user-data-dir=')).slice(16), managedToken: 'expected', args };
  assert.equal(managedChromeCommandSafety({ pid: 123, port: 9222, state, command: ['browser', ...args, ''].join('\0') }).ok, true);
  assert.equal(managedChromeCommandSafety({ pid: 123, port: 9222, state, command: ['not-browser', '--message=hello ' + args.join(' '), ''].join('\0') }).ok, false);
});

test('cached profile cannot be reused from a different source root', () => {
  const root = mkdtempSync(join(tmpdir(), 'bt-source-cache-'));
  const old = process.env.BROWSER_TOOLS_CACHE_DIR;
  process.env.BROWSER_TOOLS_CACHE_DIR = root;
  try {
    const destDir = join(root, 'chrome-data-19459');
    mkdirSync(join(destDir, 'Default'), { recursive: true });
    writeFileSync(join(destDir, 'Local State'), '{}');
    writeFileSync(join(destDir, 'Default', 'Cookies'), '');
    writeFileSync(join(root, 'chrome-profile-sync-19459.json'), JSON.stringify({ sourceDir: join(root, 'account-A'), includeGoogle: false, googleStripOk: true }));
    assert.throws(() => syncChromeProfile('Default', { port: 19459, destDir, sourceDir: join(root, 'account-B') }), /profile folder not found/);
  } finally { if (old === undefined) delete process.env.BROWSER_TOOLS_CACHE_DIR; else process.env.BROWSER_TOOLS_CACHE_DIR = old; rmSync(root, { recursive: true, force: true }); }
});
