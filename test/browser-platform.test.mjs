import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverChromeBinary, discoverChromeSourceDir, chromePlatformToken } from '../scripts/browser-platform.mjs';

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'browser-platform-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  const options = { platform: 'linux', env: { PATH: bin }, home };
  const launcher = (name, text = '#!/bin/sh\nexit 0\n', mode = 0o755) => {
    const path = join(bin, name);
    writeFileSync(path, text);
    chmodSync(path, mode);
    return path;
  };
  return { home, bin, options, launcher };
}

for (const name of ['google-chrome', 'google-chrome-stable', 'google-chrome-beta', 'google-chrome-unstable', 'chromium', 'chromium-browser']) {
  test('Linux discovers executable PATH launcher: ' + name, (t) => {
    const { options, launcher } = fixture(t);
    const expected = launcher(name);
    assert.equal(discoverChromeBinary(options), expected);
  });
}

test('prefers Google Chrome then its stable channel over Chromium', (t) => {
  const { options, launcher } = fixture(t);
  launcher('chromium');
  launcher('google-chrome-beta');
  const stable = launcher('google-chrome-stable');
  assert.equal(discoverChromeBinary(options), stable);
  const chrome = launcher('google-chrome');
  assert.equal(discoverChromeBinary(options), chrome);
});

test('preserves PATH order within the selected launcher name and preserves symlinks', (t) => {
  const { options, launcher, home, bin } = fixture(t);
  launcher('google-chrome');
  const first = join(home, 'first');
  mkdirSync(first);
  const target = launcher('actual-browser');
  symlinkSync(target, join(first, 'google-chrome'));
  assert.equal(discoverChromeBinary({ ...options, env: { PATH: first + ':' + bin } }), join(first, 'google-chrome'));
});

test('ignores non-executable files, directories, and dangling symlinks', (t) => {
  const { options, launcher, bin } = fixture(t);
  launcher('google-chrome', '', 0o644);
  mkdirSync(join(bin, 'google-chrome-stable'));
  symlinkSync(join(bin, 'missing'), join(bin, 'google-chrome-beta'));
  const expected = launcher('chromium-browser');
  assert.equal(discoverChromeBinary(options), expected);
});

test('missing Linux executable returns null including absent distro fallbacks', (t) => {
  const { options } = fixture(t);
  // Model an uninstalled host without renaming or touching system executables.
  const access = t.mock.method(fs, 'accessSync', () => {
    throw Object.assign(new Error('fixture executable absent'), { code: 'ENOENT' });
  });
  syncBuiltinESMExports();
  try {
    assert.equal(discoverChromeBinary(options), null);
    assert.equal(discoverChromeSourceDir(options), join(options.home, '.config', 'google-chrome'));
  } finally {
    access.mock.restore();
    syncBuiltinESMExports();
  }
});

test('source directory automatically follows discovered Chromium instead of existing Chrome', (t) => {
  const { options, launcher, home } = fixture(t);
  launcher('chromium');
  mkdirSync(join(home, '.config', 'google-chrome'), { recursive: true });
  assert.equal(discoverChromeSourceDir(options), join(home, '.config', 'chromium'));
});

for (const [binary, directory] of [
  ['/usr/bin/google-chrome', 'google-chrome'],
  ['/usr/bin/google-chrome-stable', 'google-chrome'],
  ['/usr/bin/google-chrome-beta', 'google-chrome-beta'],
  ['/usr/bin/google-chrome-unstable', 'google-chrome-unstable'],
  ['/opt/google/chrome-beta/chrome', 'google-chrome-beta'],
  ['/opt/google/chrome-unstable/chrome', 'google-chrome-unstable'],
  ['/usr/bin/chromium', 'chromium'],
  ['/usr/bin/chromium-browser', 'chromium'],
]) {
  test('source matches chosen family/channel: ' + binary, (t) => {
    const { options, home } = fixture(t);
    const config = join(home, 'xdg');
    mkdirSync(join(config, directory === 'chromium' ? 'google-chrome' : 'chromium'), { recursive: true });
    assert.equal(discoverChromeSourceDir({ ...options, chromeBin: binary, env: { XDG_CONFIG_HOME: config } }), join(config, directory));
  });
}

test('relative XDG_CONFIG_HOME is ignored according to XDG specification', (t) => {
  const { options, home } = fixture(t);
  assert.equal(discoverChromeSourceDir({ ...options, chromeBin: '/usr/bin/google-chrome', env: { XDG_CONFIG_HOME: 'relative' } }), join(home, '.config', 'google-chrome'));
});

test('snap launcher uses common profile even when native Chromium profile exists', (t) => {
  const { options, home } = fixture(t);
  mkdirSync(join(home, '.config', 'chromium'), { recursive: true });
  assert.equal(discoverChromeSourceDir({ ...options, chromeBin: '/snap/bin/chromium' }), join(home, 'snap', 'chromium', 'common', 'chromium'));
});

test('Ubuntu snap compatibility wrapper stays intact and selects snap common profile', (t) => {
  const { options, launcher, home } = fixture(t);
  const binary = launcher('chromium-browser', '#!/bin/sh\nexec /snap/bin/chromium "$@"\n');
  assert.equal(discoverChromeBinary(options), binary);
  assert.equal(discoverChromeSourceDir({ ...options, chromeBin: binary }), join(home, 'snap', 'chromium', 'common', 'chromium'));
});

test('snap run wrapper selects snap common profile', (t) => {
  const { options, launcher, home } = fixture(t);
  const binary = launcher('chromium', '#!/bin/sh\nexec snap run chromium "$@"\n');
  assert.equal(discoverChromeSourceDir({ ...options, chromeBin: binary }), join(home, 'snap', 'chromium', 'common', 'chromium'));
});

test('existing snap common directory is fallback only within Chromium family', (t) => {
  const { options, home } = fixture(t);
  const snap = join(home, 'snap', 'chromium', 'common', 'chromium');
  mkdirSync(snap, { recursive: true });
  assert.equal(discoverChromeSourceDir({ ...options, chromeBin: '/usr/bin/chromium' }), snap);
  assert.equal(discoverChromeSourceDir({ ...options, chromeBin: '/usr/bin/google-chrome' }), join(home, '.config', 'google-chrome'));
  const native = join(home, '.config', 'chromium');
  mkdirSync(native, { recursive: true });
  assert.equal(discoverChromeSourceDir({ ...options, chromeBin: '/usr/bin/chromium' }), native);
});

test('macOS preserves Google Chrome defaults independently of PATH and XDG', (t) => {
  const { home } = fixture(t);
  const options = { platform: 'darwin', home, env: { PATH: '', XDG_CONFIG_HOME: '/unused' } };
  assert.equal(discoverChromeBinary(options), '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  assert.equal(discoverChromeSourceDir(options), join(home, 'Library', 'Application Support', 'Google', 'Chrome'));
});

test('unsupported OS discovery returns null', () => {
  assert.equal(discoverChromeBinary({ platform: 'freebsd' }), null);
  assert.equal(discoverChromeSourceDir({ platform: 'freebsd' }), null);
});

for (const [platform, arch, expected] of [
  ['linux', 'arm64', 'X11; Linux aarch64'],
  ['linux', 'x64', 'X11; Linux x86_64'],
  ['linux', 'ia32', 'X11; Linux i686'],
  ['linux', 'arm', 'X11; Linux armv7l'],
  ['darwin', 'arm64', 'Macintosh; Intel Mac OS X 10_15_7'],
  ['darwin', 'x64', 'Macintosh; Intel Mac OS X 10_15_7'],
]) {
  test('UA platform token: ' + platform + '/' + arch, () => {
    assert.equal(chromePlatformToken({ platform, arch }), expected);
  });
}
