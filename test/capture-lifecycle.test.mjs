import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { parseCdpEventCaptureOptions, runCdpEventCapture } from '../scripts/cdp-event-capture.mjs';
import { HarCollector, parseHarCaptureOptions, runHarCapture } from '../scripts/har-capture.mjs';
import { recordGifSession } from '../scripts/gif-recorder.mjs';

for (const kind of ['cdp', 'har']) {
  for (const failureAt of [null, 'enable', 'recording', kind === 'cdp' ? 'post-wait' : 'draining']) {
    test(`${kind} capture releases listeners after ${failureAt || 'normal stop'} and can retry`, async () => {
      const session = new EventEmitter();
      const unrelated = () => {};
      session.on('unrelated', unrelated);
      let failure = failureAt;
      session.send = async () => {
        if (failure === 'enable') throw new Error('fixture enable failure');
      };
      const phases = [];
      const run = () => {
        const common = {
          session,
          shouldStop: () => true,
          onPhase: (phase) => {
            phases.push(phase);
            if (phase === failure) throw new Error('fixture phase failure');
          },
        };
        return kind === 'cdp'
          ? runCdpEventCapture({
            ...common,
            options: { ...parseCdpEventCaptureOptions([]), postWaitMs: 0 },
            writeEvent: () => {},
          })
          : runHarCapture({
            ...common,
            page: { url: () => 'about:blank', title: async () => 'Fixture' },
            options: { ...parseHarCaptureOptions([]), idleMs: 0, drainTimeoutMs: 1 },
          });
      };
      if (failure) await assert.rejects(run(), /fixture/);
      else assert.equal((await run()).reason, 'requested');
      assert.deepEqual(session.eventNames(), ['unrelated']);
      failure = null;
      assert.equal((await run()).reason, 'requested');
      assert.deepEqual(session.eventNames(), ['unrelated']);
      assert.deepEqual(phases.slice(-2), ['recording', kind === 'cdp' ? 'post-wait' : 'draining']);
    });
  }
}

for (const kind of ['cdp', 'har']) {
  test(`${kind} duration limit follows the same finalization path as requested shutdown`, async () => {
    const session = new EventEmitter();
    session.send = async () => {};
    const phases = [];
    const common = { session, shouldStop: () => false, onPhase: (phase) => phases.push(phase) };
    const result = kind === 'cdp'
      ? await runCdpEventCapture({ ...common, writeEvent: () => {}, options: {
        ...parseCdpEventCaptureOptions([]), maxDurationSeconds: 0, postWaitMs: 0,
      } })
      : await runHarCapture({ ...common, page: { url: () => 'about:blank', title: async () => 'Fixture' }, options: {
        ...parseHarCaptureOptions([]), maxDurationSeconds: 0, idleMs: 0, drainTimeoutMs: 1,
      } });
    assert.equal(result.reason, 'max-duration');
    assert.deepEqual(phases, ['recording', kind === 'cdp' ? 'post-wait' : 'draining']);
    assert.deepEqual(session.eventNames(), []);
  });
}

test('CDP writer failure is captured by the owner rather than escaping an event callback', async () => {
  const session = new EventEmitter();
  session.send = async () => {};
  await assert.rejects(runCdpEventCapture({
    session,
    options: parseCdpEventCaptureOptions([]),
    shouldStop: () => true,
    writeEvent: () => { throw new Error('fixture disk failure'); },
    onPhase: () => session.emit('*', 'Network.requestWillBeSent', {}),
  }), /fixture disk failure/);
  assert.deepEqual(session.eventNames(), []);
});

test('HAR redirect, success and failure states own drain membership', async () => {
  const collector = new HarCollector(parseHarCaptureOptions(['--capture', 'headers,timing']));
  const request = (requestId, timestamp, extra = {}) => collector.requestWillBeSent({
    requestId, timestamp, wallTime: timestamp,
    type: 'Fetch', request: { url: 'https://example.test/fixture', method: 'GET', headers: {} }, ...extra,
  });
  request('redirect', 1);
  const redirected = collector.entries[0];
  request('redirect', 2, { redirectResponse: { status: 302, headers: {} } });
  assert.equal(redirected.state, 'redirected');
  collector.responseReceived({ requestId: 'redirect', timestamp: 3, response: { status: 200, headers: {} } });
  assert.equal(collector.currentByRequestId.get('redirect').state, 'responding');
  await collector.loadingFinished({ requestId: 'redirect', timestamp: 4 }, {});
  request('failure', 2);
  assert.equal(await collector.waitForDrain({ idleMs: 0, timeoutMs: 1 }), false);
  collector.loadingFailed({ requestId: 'failure', timestamp: 5, errorText: 'fixture failure' });
  assert.equal(await collector.waitForDrain({ idleMs: 0, timeoutMs: 1 }), true);
  assert.deepEqual(collector.entries.map((entry) => entry.state), ['redirected', 'completed', 'failed']);
  collector.loadingFailed({ requestId: 'redirect', timestamp: 6, errorText: 'late failure' });
  assert.equal(collector.currentByRequestId.get('redirect').state, 'completed');
  assert.doesNotMatch(JSON.stringify(collector.build()), /"state"/);
});

test('GIF finalization failure does not stop the same encoder twice', async () => {
  let stops = 0;
  let clock = 0;
  await assert.rejects(recordGifSession({
    page: { screenshot: async () => Buffer.from('fixture') },
    output: '/captures/fixture_action.gif',
    preRollMs: 1,
    postRollMs: 1,
    shouldStop: () => true,
    now: () => clock,
    sleepFn: async (ms) => { clock += ms; },
    encoderFactory: () => ({
      writeFrame: async () => {},
      stop: async () => { stops += 1; throw new Error('fixture encoder failure'); },
    }),
  }), /fixture encoder failure/);
  assert.equal(stops, 1);
});
