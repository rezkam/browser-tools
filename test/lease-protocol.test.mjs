import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { leaseTab } from '../scripts/tab-broker.mjs';

async function fixture(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('a terminal frame before a grant rejects rather than granting an empty lease', async (t) => {
  const url = await fixture(t, (_, response) => response.end('{"ended":"closed"}\n'));
  await assert.rejects(leaseTab(url), /closed.*before granting/);
});

test('a terminal frame closes its transport even when the server leaves the response open', { timeout: 1000 }, async (t) => {
  let disconnected;
  const closed = new Promise((resolve) => { disconnected = resolve; });
  const url = await fixture(t, (_, response) => {
    response.on('close', disconnected);
    response.write('{"ended":"closed"}\n');
  });
  await assert.rejects(leaseTab(url), /closed.*before granting/);
  await closed;
});

test('a lease protocol failure is terminal even if a grant follows', async (t) => {
  const url = await fixture(t, (_, response) => response.end([
    { error: 'fixture allocation failure' },
    { cdp_url: 'ws://fixture', target_id: 'fixture', tab_url: 'about:blank', deadline: 1 },
  ].map((line) => JSON.stringify(line)).join('\n') + '\n'));
  await assert.rejects(leaseTab(url), /fixture allocation failure/);
});

for (const frame of ['not-json\n', '{}\n', 'null\n']) {
  test(`an invalid lease frame rejects and the next request can retry (${JSON.stringify(frame)})`, async (t) => {
    let attempts = 0;
    const grant = { cdp_url: 'ws://fixture', target_id: 'fixture', tab_url: 'about:blank', deadline: 1 };
    const url = await fixture(t, (_, response) => response.end(++attempts === 1 ? frame : `${JSON.stringify(grant)}\n`));
    await assert.rejects(leaseTab(url));
    const retry = await leaseTab(url);
    assert.equal(retry.targetId, 'fixture');
    retry.release();
    assert.equal(await retry.ended, 'released');
  });
}

test('HTTP refusal and transport failure reject pending leases', async (t) => {
  const url = await fixture(t, (_, response) => response.writeHead(503).end());
  await assert.rejects(leaseTab(url), /HTTP 503/);
  const closed = await fixture(t, (request) => request.socket.destroy());
  await assert.rejects(leaseTab(closed));
});

test('a fragmented grant and terminal frame retain the broker end reason', async (t) => {
  const url = await fixture(t, (_, response) => {
    response.write('{"cdp_url":"ws://fixture",');
    setImmediate(() => response.end('"target_id":"fixture","tab_url":"about:blank","deadline":1}\n{"ended":"expired"}\n'));
  });
  const lease = await leaseTab(url);
  assert.equal(lease.targetId, 'fixture');
  assert.equal(await lease.ended, 'expired');
  lease.release();
  lease.release();
});
