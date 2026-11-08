import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecordingLifecycle } from '../scripts/recording-lifecycle.mjs';

const paths = {
  gif: ['starting', 'pre-roll', 'recording', 'post-roll', 'completed'],
  har: ['starting', 'recording', 'draining', 'completed'],
  cdp: ['starting', 'recording', 'post-wait', 'completed'],
};

for (const [kind, path] of Object.entries(paths)) {
  test(`${kind} state graph permits only the next phase or failure, with terminal states absorbing`, () => {
    for (let index = 0; index < path.length; index += 1) {
      for (const candidate of [...path, 'failed', 'unknown']) {
        const saved = [];
        const owner = createRecordingLifecycle(kind, { output: 'fixture' }, (state) => saved.push(state));
        for (const phase of path.slice(1, index + 1)) owner.transition(phase);
        const before = owner.snapshot();
        if (index < path.length - 1 && [path[index + 1], 'failed'].includes(candidate)) {
          const after = owner.transition(candidate, { reason: 'fixture' });
          const expectedStatus = ['completed', 'failed'].includes(candidate) ? candidate
            : candidate === 'pre-roll' ? 'starting' : 'recording';
          assert.equal(after.status, expectedStatus);
          assert.equal(after.phase, candidate);
          assert.equal(after.output, 'fixture');
          assert.deepEqual(saved.at(-1), after);
          if (candidate === 'recording') assert.ok(after.readyAt);
          if (['completed', 'failed'].includes(candidate)) assert.ok(after.completedAt);
          if (candidate === 'failed') assert.throws(() => owner.transition('recording'), /Invalid/);
        } else {
          assert.throws(() => owner.transition(candidate), /Invalid/);
          assert.deepEqual(owner.snapshot(), before);
        }
      }
    }
  });
}

test('recording owners are isolated and snapshots cannot mutate their phase', () => {
  const first = createRecordingLifecycle('gif');
  const second = createRecordingLifecycle('gif');
  first.transition('pre-roll');
  first.snapshot().phase = 'completed';
  assert.equal(first.phase, 'pre-roll');
  assert.equal(second.phase, 'starting');
  assert.throws(() => createRecordingLifecycle('unknown'), /Unknown/);
});

test('failed persistence does not commit a transition and can be retried', () => {
  let fail = false;
  const owner = createRecordingLifecycle('har', {}, () => { if (fail) throw new Error('fixture persistence failure'); });
  fail = true;
  assert.throws(() => owner.transition('recording'), /fixture persistence failure/);
  assert.equal(owner.phase, 'starting');
  fail = false;
  owner.transition('recording');
  assert.equal(owner.phase, 'recording');
});
