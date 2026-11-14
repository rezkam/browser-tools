import test from 'node:test';
import assert from 'node:assert/strict';
import { expectedImageSize, parseViewport, pngSize, stripViewportArgs } from '../scripts/viewport.mjs';

test('parseViewport reads a size, scale and mobile flag, and is absent when no size is asked for', () => {
  assert.equal(parseViewport(['--port', '9223']), null);
  assert.deepEqual(parseViewport(['--viewport', '375x667']), { width: 375, height: 667, deviceScaleFactor: 1, mobile: false });
  assert.deepEqual(parseViewport(['--viewport', '1280x800', '--scale', '1.5', '--mobile']), { width: 1280, height: 800, deviceScaleFactor: 1.5, mobile: true });
});

test('parseViewport rejects sizes and scales that Chrome would silently reinterpret', () => {
  for (const args of [['--viewport'], ['--viewport', '375'], ['--viewport', '375x'], ['--viewport', '0x600'], ['--viewport', '375X667'], ['--viewport', '-1x5'], ['--viewport', '375x667x2']]) {
    assert.throws(() => parseViewport(args), /--viewport/, args.join(' '));
  }
  for (const scale of ['0', '-1', 'two', '9']) {
    assert.throws(() => parseViewport(['--viewport', '375x667', '--scale', scale]), /--scale/, scale);
  }
  assert.throws(() => parseViewport(['--mobile']), /need --viewport/);
  assert.throws(() => parseViewport(['--scale', '2']), /need --viewport/);
});

test('stripViewportArgs leaves the rest of a command line in order', () => {
  assert.deepEqual(stripViewportArgs(['--viewport', '375x667', 'document.title', '--mobile', '--scale', '2', '+ 1']), ['document.title', '+ 1']);
  assert.deepEqual(stripViewportArgs(['innerWidth']), ['innerWidth']);
});

test('only a plain viewport capture has a size the image must match', () => {
  const viewport = { width: 375, height: 667, deviceScaleFactor: 2, mobile: true };
  assert.deepEqual(expectedImageSize(viewport), { width: 750, height: 1334 });
  assert.equal(expectedImageSize(viewport, { fullPage: true }), null);
  assert.equal(expectedImageSize(viewport, { selector: '#t' }), null);
  assert.equal(expectedImageSize(null), null);
});

test('pngSize reads the header of a PNG from a Buffer or a byte array, and rejects other data', () => {
  const header = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
  header.writeUInt32BE(750, 16);
  header.writeUInt32BE(1334, 20);
  assert.deepEqual(pngSize(header), { width: 750, height: 1334 });
  assert.deepEqual(pngSize(new Uint8Array(header)), { width: 750, height: 1334 });
  assert.throws(() => pngSize(Buffer.from('not an image, just some text here')), /Not a PNG/);
});
