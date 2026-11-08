import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createTabPool } from '../scripts/tab-pool.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function until(predicate) {
  for (let turn = 0; turn < 50; turn += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('fixture did not reach the expected state');
}

class Response extends EventEmitter {
  lines = [];
  writeHead(status) { this.status = status; return this; }
  flushHeaders() {}
  write(line) { this.lines.push(JSON.parse(line)); }
  end() { this.writableEnded = true; this.emit('close'); }
  cancel() { this.destroyed = true; this.emit('close'); }
  get granted() { return this.lines.some((line) => line.target_id); }
}

function chrome(before = async () => {}) {
  const exited = deferred();
  const contexts = new Set();
  const calls = [];
  let nextId = 0;
  const running = {
    browser: { connected: true },
    child: { exitCode: null, signalCode: null },
    cdpUrl: 'ws://fixture',
    contexts,
    calls,
    exited: exited.promise,
    exit() {
      running.browser.connected = false;
      running.child.exitCode = 1;
      contexts.clear();
      exited.resolve({ code: 1, signal: null });
    },
    session: {
      async send(method, params) {
        calls.push(method);
        await before(method);
        if (method === 'Target.createBrowserContext') {
          const browserContextId = String(++nextId);
          contexts.add(browserContextId);
          return { browserContextId };
        }
        if (method === 'Target.disposeBrowserContext') contexts.delete(params.browserContextId);
        return { targetId: `target-${nextId}` };
      },
    },
    async close() { calls.push('close'); running.exit(); },
  };
  return running;
}

function pool(t, launchChrome, maxTabs = 1) {
  const logs = [];
  const owner = createTabPool({ launchChrome, maxTabs, tabSeconds: 60, log: (line) => logs.push(line) });
  t.after(() => owner.close());
  return { owner, logs, add() { const response = new Response(); owner.add(response, 'fixture'); return response; } };
}

test('a pool shares one startup, preserves FIFO, and removes cancelled queued leases', async (t) => {
  const running = chrome();
  let launches = 0;
  const { owner, add } = pool(t, async () => { launches += 1; return running; }, 2);
  const first = add();
  const second = add();
  const cancelled = add();
  const fourth = add();
  cancelled.cancel();
  await until(() => first.granted && second.granted);
  assert.equal(launches, 1);
  assert.equal(fourth.granted, false);
  first.cancel();
  await until(() => fourth.granted);
  assert.equal(running.contexts.size, 2);
  assert.equal(cancelled.granted, false);
  await owner.close();
  assert.equal(running.contexts.size, 0);
  assert.equal(running.calls.filter((method) => method === 'close').length, 1);
});

for (const pauseAt of ['launch', 'Target.createBrowserContext', 'Browser.setDownloadBehavior', 'Target.createTarget']) {
  for (const action of ['cancel', 'shutdown']) {
    test(`${action} during ${pauseAt} cannot grant a late tab or leak its context`, async (t) => {
      const gate = deferred();
      t.after(() => gate.resolve());
      let entered = false;
      const running = chrome(async (method) => {
        if (method === pauseAt) { entered = true; await gate.promise; }
      });
      const { owner, logs, add } = pool(t, async () => {
        if (pauseAt === 'launch') { entered = true; await gate.promise; }
        return running;
      });
      const response = add();
      await until(() => entered);
      const closing = action === 'shutdown' ? owner.close() : null;
      if (action === 'cancel') response.cancel();
      gate.resolve();
      await until(() => owner.counts.tabs === 0);
      if (closing) await closing;
      assert.equal(response.granted, false);
      assert.equal(running.contexts.size, 0);
      assert.equal(logs.length, 1, 'a lease has only one terminal transition');
      assert.equal(logs[0].ended, action === 'cancel' ? 'released' : 'closed');
      if (action === 'cancel') {
        const retry = add();
        await until(() => retry.granted);
      } else {
        const refused = add();
        assert.equal(refused.status, 503);
      }
    });
  }
}

for (const failureAt of ['launch', 'Target.createBrowserContext', 'Browser.setDownloadBehavior', 'Target.createTarget']) {
  test(`failure in ${failureAt} releases the slot and the next lease can retry`, async (t) => {
    let failure = failureAt;
    const running = chrome(async (method) => { if (method === failure) throw new Error('fixture allocation failure'); });
    const { owner, add } = pool(t, async () => {
      if (failure === 'launch') throw new Error('fixture launch failure');
      return running;
    });
    const failed = add();
    await until(() => failed.writableEnded && owner.counts.tabs === 0);
    assert.match(failed.lines[0].error, /fixture/);
    assert.equal(running.contexts.size, 0);
    failure = null;
    const retry = add();
    await until(() => retry.granted);
  });
}

test('browser exit ends its active leases and the queued client starts a new browser', async (t) => {
  const browsers = [];
  const { add } = pool(t, async () => { const running = chrome(); browsers.push(running); return running; });
  const first = add();
  const next = add();
  await until(() => first.granted);
  browsers[0].exit();
  await until(() => next.granted);
  assert.equal(browsers.length, 2);
  assert.match(first.lines.at(-1).error, /Chrome exited/);
  assert.equal(browsers[0].contexts.size, 0);
});

test('a disposal failure retires the browser before granting another context', async (t) => {
  const firstBrowser = chrome(async (method) => {
    if (method === 'Target.disposeBrowserContext') throw new Error('fixture disposal failure');
  });
  const nextBrowser = chrome();
  let launches = 0;
  const { add } = pool(t, async () => ++launches === 1 ? firstBrowser : nextBrowser);
  const first = add();
  const queued = add();
  await until(() => first.granted);
  first.cancel();
  await until(() => queued.granted);
  assert.equal(firstBrowser.contexts.size, 0);
  assert.equal(launches, 2);
  assert.equal(nextBrowser.contexts.size, 1);
});

test('shutdown ends queued leases, is idempotent, and does not launch an idle browser', async (t) => {
  let launches = 0;
  const { owner, add } = pool(t, async () => { launches += 1; return chrome(); });
  const first = owner.close();
  assert.equal(owner.close(), first);
  assert.equal(add().status, 503);
  await first;
  assert.equal(owner.close(), first);
  assert.equal(launches, 0);
});

test('a failed stop of a disconnected browser can retry without losing its handle', async (t) => {
  const firstBrowser = chrome();
  const nextBrowser = chrome();
  let launches = 0;
  const { owner, add } = pool(t, async () => ++launches === 1 ? firstBrowser : nextBrowser);
  const first = add();
  await until(() => first.granted);
  first.cancel();
  await until(() => owner.counts.tabs === 0);
  firstBrowser.browser.connected = false;
  const close = firstBrowser.close;
  let stops = 0;
  firstBrowser.close = async () => {
    if (++stops === 1) throw new Error('fixture stop failure');
    await close();
  };
  const failed = add();
  await until(() => failed.writableEnded);
  assert.match(failed.lines[0].error, /fixture stop failure/);
  const retry = add();
  await until(() => retry.granted);
  assert.equal(launches, 2);
  assert.equal(stops, 2);
});

for (const stalledAt of ['Target.createTarget', 'Target.disposeBrowserContext']) {
  test(`shutdown closes Chrome before waiting for stalled ${stalledAt}`, async (t) => {
    const gate = deferred();
    t.after(() => gate.resolve());
    let entered = false;
    const running = chrome(async (method) => {
      if (method === stalledAt) { entered = true; await gate.promise; }
    });
    const { owner, add } = pool(t, async () => running);
    const response = add();
    if (stalledAt === 'Target.disposeBrowserContext') {
      await until(() => response.granted);
      response.cancel();
    }
    await until(() => entered);
    const closing = owner.close();
    await until(() => running.calls.includes('close'));
    gate.resolve();
    await closing;
    assert.equal(running.contexts.size, 0);
  });
}

test('shutdown failure retains the browser handle for a shutdown retry', async (t) => {
  const running = chrome();
  const close = running.close;
  let attempts = 0;
  running.close = async () => {
    if (++attempts === 1) throw new Error('fixture shutdown failure');
    await close();
  };
  const { owner, add } = pool(t, async () => running);
  const first = add();
  const queued = add();
  await until(() => first.granted);
  await assert.rejects(owner.close(), /fixture shutdown failure/);
  assert.equal(queued.granted, false);
  assert.deepEqual(queued.lines, [{ ended: 'closed' }]);
  assert.equal(add().status, 503);
  assert.equal(owner.running, running);
  await owner.close();
  assert.equal(attempts, 2);
  assert.equal(owner.running, null);
});
