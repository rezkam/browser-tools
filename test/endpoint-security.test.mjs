import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchedEndpointMatches, syncChromeProfile, chromeLaunchArgs, managedChromeCommandSafety } from '../scripts/browser-control.mjs';
import { discoverChromeSourceDir } from '../scripts/browser-platform.mjs';

for (const mode of ['handshake-stall', 'cdp-stall', 'redirect']) {
  test('endpoint verifier bounds and closes ' + mode, { timeout: 3000 }, async () => {
    const sockets = new Set();
    let redirected = false;
    const other = createServer(() => { redirected = true; });
    await new Promise(r => other.listen(0, '127.0.0.1', r));
    const server = createServer();
    const wss = mode === 'cdp-stall' ? new WebSocketServer({ server }) : null;
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    if (mode !== 'cdp-stall') server.on('upgrade', (req, socket) => {
      socket.on('end', () => socket.end());
      if (mode === 'redirect') socket.end('HTTP/1.1 302 Found\r\nLocation: ws://127.0.0.1:' + other.address().port + '/outside\r\nContent-Length: 0\r\n\r\n');
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    try {
      assert.equal(await launchedEndpointMatches({ port, endpoint: 'ws://127.0.0.1:' + port + '/devtools/browser/test', state: { userDataDir: '/nonexistent', managedToken: 'test' }, timeoutMs: 150 }), false);
      await new Promise(r => setTimeout(r, 50));
      assert.equal(sockets.size, 0);
      assert.equal(redirected, false);
    } finally { for (const socket of sockets) socket.destroy(); wss?.close(); await new Promise(r => server.close(r)); await new Promise(r => other.close(r)); }
  });
}

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
