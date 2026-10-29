import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';

const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const LINUX_NAMES = [
  'google-chrome', 'google-chrome-stable', 'google-chrome-beta',
  'google-chrome-unstable', 'chromium', 'chromium-browser',
];
const LINUX_LOCATIONS = ['/usr/bin', '/usr/local/bin', '/opt/bin']
  .flatMap((directory) => LINUX_NAMES.map((name) => join(directory, name))).concat([
    // Use the supported snap launcher, never its internal binary.
    '/snap/bin/chromium',
    '/opt/google/chrome/chrome', '/opt/google/chrome-beta/chrome',
    '/opt/google/chrome-unstable/chrome',
    '/usr/lib/chromium/chromium', '/usr/lib64/chromium-browser/chromium-browser',
    '/usr/lib/chromium-browser/chromium-browser', '/usr/lib64/chromium/chromium',
  ]);

function executable(file) {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch { return false; }
}

/** Read-only discovery: executable Linux launcher or null if absent.
 * macOS preserves its historical default even when not installed.
 * Explicit configuration/env overrides belong to the caller.
 */
export function discoverChromeBinary({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  if (platform === 'darwin') return MAC_CHROME;
  if (platform !== 'linux') return null;
  void home; // Do not infer installations from arbitrary downloads/caches.
  const directories = (env.PATH || '').split(':').filter(Boolean);
  for (const name of LINUX_NAMES) {
    for (const directory of directories) {
      const candidate = join(directory, name);
      if (executable(candidate)) return candidate;
    }
  }
  return LINUX_LOCATIONS.find(executable) || null;
}

function directoryExists(directory) {
  try { return statSync(directory).isDirectory(); } catch { return false; }
}

function snapChromium(binary) {
  if (binary === '/snap/bin/chromium' || binary.includes('/snap/chromium/')) return true;
  try {
    const target = realpathSync(binary);
    if (target === '/usr/bin/snap' || target.includes('/snap/chromium/')) return true;
    // Ubuntu's chromium-browser compatibility launcher delegates to snap.
    if (statSync(binary).size < 64 * 1024) {
      return /(?:\/snap\/bin\/chromium|\bsnap\s+run\s+chromium\b)/.test(readFileSync(binary, 'utf8'));
    }
  } catch { /* Missing or unreadable launchers retain predictable defaults. */ }
  return false;
}

/** User-data root for the selected browser family/channel; never creates it.
 * Never substitutes another browser family's existing profile.
 */
export function discoverChromeSourceDir({ chromeBin, platform = process.platform, env = process.env, home = homedir() } = {}) {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Google', 'Chrome');
  if (platform !== 'linux') return null;
  const binary = chromeBin || discoverChromeBinary({ platform, env, home }) || 'google-chrome';
  const name = basename(binary).toLowerCase();
  const configRoot = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME)
    ? env.XDG_CONFIG_HOME : join(home, '.config');
  if (name.includes('chromium') || binary.includes('/snap/chromium/')) {
    const native = join(configRoot, 'chromium');
    const snap = join(home, 'snap', 'chromium', 'common', 'chromium');
    if (snapChromium(binary)) return snap;
    // Distro launchers can delegate to snap; stay within the Chromium family.
    return !directoryExists(native) && directoryExists(snap) ? snap : native;
  }
  const channel = /(?:google-chrome|chrome)[-/]beta(?:[/]|$)/.test(binary) ? '-beta'
    : /(?:google-chrome|chrome)[-/](?:unstable|dev)(?:[/]|$)/.test(binary) ? '-unstable' : '';
  return join(configRoot, 'google-chrome' + channel);
}

/** User-agent platform component, not a full User-Agent string. */
export function chromePlatformToken({ platform = process.platform, arch = process.arch } = {}) {
  if (platform === 'darwin') return 'Macintosh; Intel Mac OS X 10_15_7';
  if (platform === 'win32') return 'Windows NT 10.0; Win64; x64';
  if (platform === 'linux') {
    const machine = { x64: 'x86_64', arm64: 'aarch64', ia32: 'i686', arm: 'armv7l' }[arch] || arch;
    return 'X11; Linux ' + machine;
  }
  return 'X11; ' + platform + ' ' + arch;
}
