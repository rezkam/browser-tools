import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { chromeLaunchArgs, managedBrowserReuseDecision, ownerTokenHash } from '../scripts/browser-control.mjs';

const require = createRequire(import.meta.url);

test('the Puppeteer API resolves to the pinned Rebrowser backend', () => {
  const backend = require('puppeteer-core/package.json');
  assert.equal(backend.name, 'rebrowser-puppeteer-core');
  assert.equal(backend.version, '25.16.0');
  assert.equal(require('../package.json').engines.node, backend.engines.node);
});

test('extension debugging is explicit and fixed at browser launch', () => {
  assert.equal(chromeLaunchArgs().includes('--enable-unsafe-extension-debugging'), false);
  assert.ok(chromeLaunchArgs({ extensionDebugging: true }).includes('--enable-unsafe-extension-debugging'));
  const state = { managedBy: 'browser-tools', ownerTokenHash: ownerTokenHash('owner'), ownerId: 'extension-test' };
  const options = { safety: { ok: true }, state, ownerToken: 'owner', extensionDebugging: true };
  assert.equal(managedBrowserReuseDecision(options).reason, 'extension-debugging-mismatch');
  assert.equal(managedBrowserReuseDecision({ ...options, state: { ...state, extensionDebugging: true } }).ok, true);
  assert.equal(managedBrowserReuseDecision({ ...options, extensionDebugging: false, state: { ...state, extensionDebugging: true } }).reason, 'extension-debugging-mismatch');
});
