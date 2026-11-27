import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  browserToolsChromeBin, readManagedStateForPort, startChrome, stopChrome, sweepOrphanedChromeTempDirs,
} from '../scripts/browser-control.mjs';

const chromeBin = process.env.BROWSER_TOOLS_CHROME_BIN || browserToolsChromeBin();
const skip = process.platform === 'darwin' ? 'macOS keeps Chrome in its own per-user temporary directory'
  : existsSync(chromeBin) ? false : `no Chrome at ${chromeBin}; set BROWSER_TOOLS_CHROME_BIN`;

/** Runs `body` with TMPDIR pointing at an empty private directory, so every leftover is attributable. */
async function withPrivateTmp(t, body) {
  const root = mkdtempSync(join(tmpdir(), 'bt-chrome-temp-'));
  const scratch = join(root, 'tmp');
  mkdirSync(scratch);
  const previous = { TMPDIR: process.env.TMPDIR, BROWSER_TOOLS_CACHE_DIR: process.env.BROWSER_TOOLS_CACHE_DIR };
  process.env.TMPDIR = scratch;
  process.env.BROWSER_TOOLS_CACHE_DIR = join(root, 'cache');
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  return body(scratch);
}

test('a stopped managed Chrome leaves nothing in the temporary directory', { skip, timeout: 120000 }, async (t) => {
  await withPrivateTmp(t, async (scratch) => {
    const started = await startChrome({ port: 19470, autoAllocatePort: true, headless: true, ownerId: 'chrome-temp-test' });
    const state = readManagedStateForPort(started.port);
    assert.ok(state.tempDir?.startsWith(scratch), 'Chrome gets its own temporary directory');
    assert.equal(stopChrome({ port: started.port, ownerToken: started.ownerToken, clean: true }).status, 'stopped');
    assert.deepEqual(readdirSync(scratch), []);
  });
});

test('the start-time sweep removes temporary directories of Chromes that are gone and keeps live ones', async (t) => {
  await withPrivateTmp(t, async (scratch) => {
    const live = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    t.after(() => live.kill());
    const owned = (name, owner) => {
      const dir = join(scratch, name);
      mkdirSync(dir);
      if (owner) writeFileSync(join(dir, 'browser-tools-owner.json'), JSON.stringify(owner));
      return dir;
    };
    const dead = owned('browser-tools-chrome-dead', { pid: 2 ** 22 + 7, startIdentity: 'gone' });
    const alive = owned('browser-tools-chrome-alive', { pid: live.pid, startIdentity: null });
    const launching = owned('browser-tools-chrome-launching', null);
    const abandoned = owned('browser-tools-chrome-abandoned', null);
    const old = (Date.now() - 10 * 60_000) / 1000;
    utimesSync(abandoned, old, old);
    const unrelated = owned('someone-else', null);

    sweepOrphanedChromeTempDirs();

    assert.equal(existsSync(dead), false);
    assert.equal(existsSync(abandoned), false);
    assert.equal(existsSync(alive), true);
    assert.equal(existsSync(launching), true, 'a directory whose launch is still in progress is kept');
    assert.equal(existsSync(unrelated), true);
  });
});
