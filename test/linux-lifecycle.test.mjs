import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launchChrome, chromeLaunchArgs, managedChromeCommandSafety, launchedEndpointMatches } from '../scripts/browser-control.mjs';

test('Linux headed launch without a display fails before spawning or writing lifecycle files', { skip: process.platform !== 'linux' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'bt-no-display-'));
  const names = ['BROWSER_TOOLS_CACHE_DIR', 'BROWSER_TOOLS_CHROME_BIN', 'DISPLAY', 'WAYLAND_DISPLAY'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    process.env.BROWSER_TOOLS_CACHE_DIR = root;
    process.env.BROWSER_TOOLS_CHROME_BIN = process.execPath;
    delete process.env.DISPLAY; delete process.env.WAYLAND_DISPLAY;
    assert.throws(() => launchChrome({ port: 19488, ownerId: 'no-display-test' }), /No Linux display.*--headless/);
    assert.equal(existsSync(join(root, 'chrome-19488.pid')), false);
  } finally {
    for (const name of names) if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
    rmSync(root, { recursive: true, force: true });
  }
});

test('launch arguments retain sandbox and secret-store defaults and bind CDP to loopback', () => {
  const args = chromeLaunchArgs({ headless: true });
  assert.ok(args.includes('--remote-debugging-address=127.0.0.1'));
  assert.ok(args.includes('--enable-automation'));
  assert.equal(args.some(arg => /no-sandbox|password-store|mock-keychain/.test(arg)), false);
});

test('process identity does not accept prefix-matching ports or tokens', () => {
  const args = chromeLaunchArgs({ port: 9222, managedToken: 'expected' });
  const userDataDir = args.find(arg => arg.startsWith('--user-data-dir=')).slice(16);
  const state = { managedBy: 'browser-tools', pid: 123, port: 9222, userDataDir, managedToken: 'expected', args };
  assert.equal(managedChromeCommandSafety({ pid: 123, port: 9222, state, command: args.join(' ') }).ok, true);
  for (const command of [args.join(' ').replace('port=9222', 'port=92220'), args.join(' ').replace('managed=expected', 'managed=expected-suffix')]) {
    assert.equal(managedChromeCommandSafety({ pid: 123, port: 9222, state, command }).ok, false);
  }
});

test('fixed-port readiness rejects remote, non-websocket and wrong-port endpoints before connection', async () => {
  for (const endpoint of ['ws://example.invalid:9222/devtools/browser/test', 'http://127.0.0.1:9222/devtools/browser/test', 'ws://127.0.0.1:9223/devtools/browser/test']) {
    assert.equal(await launchedEndpointMatches({ port: 9222, endpoint, state: {} }), false);
  }
});
