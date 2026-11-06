/**
 * One Chrome shared by every client on the machine, handing out at most `maxTabs` tabs at a time.
 *
 * A client leases a tab with an HTTP request that the broker answers with one JSON line once a tab is
 * free and then holds open. The tab lives in a browser context of its own, so tabs share no cookies or
 * storage, and the context is disposed when the client closes the connection (or exits), or when the
 * tab has been held for `tabSeconds`.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, get as httpGet } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectOwnBrowser } from './browser-control.mjs';

export const DEFAULT_MAX_TABS = 4;
export const DEFAULT_TAB_SECONDS = 120;
export const DEFAULT_SAMPLE_SECONDS = 15;
const CHROME_START_TIMEOUT_MS = 30_000;
const CHROME_STOP_TIMEOUT_MS = 5_000;

// Everything a fresh profile would start in the background is off: tabs are the only work.
export const LEAN_CHROME_ARGS = [
  '--no-first-run',
  '--no-default-browser-check',
  '--no-startup-window',
  '--disable-sync',
  '--disable-extensions',
  '--disable-component-extensions-with-background-pages',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-background-networking',
  '--disable-domain-reliability',
  '--disable-client-side-phishing-detection',
  '--disable-breakpad',
  '--disable-crash-reporter',
  '--no-service-autorun',
  '--password-store=basic',
  '--mute-audio',
  '--disable-blink-features=AutomationControlled',
  // A closed tab's renderer would otherwise stay alive for the back-forward cache, and a spare
  // renderer is kept warm for the next navigation.
  '--disable-features=BackForwardCache,SpareRendererForSitePerProcess,Translate,MediaRouter,OptimizationHints,InterestFeedContentSuggestions,AutofillServerCommunication',
];

function defaultLog(line) {
  process.stderr.write(`${JSON.stringify(line)}\n`);
}

export async function serveTabs({
  chromeBin,
  chromeArgs = [],
  headless = false,
  proxyServer = null,
  maxTabs = DEFAULT_MAX_TABS,
  tabSeconds = DEFAULT_TAB_SECONDS,
  sampleSeconds = DEFAULT_SAMPLE_SECONDS,
  host = '127.0.0.1',
  port = 0,
  log = defaultLog,
}) {
  if (!chromeBin) throw new Error('chromeBin is required');
  if (!Number.isInteger(maxTabs) || maxTabs < 1) throw new Error('maxTabs must be a positive integer');
  if (!(tabSeconds > 0)) throw new Error('tabSeconds must be positive');

  const waiting = [];
  const held = new Set();
  let chrome = null;
  let starting = null;
  let closed = false;

  async function launchChrome() {
    const profile = mkdtempSync(join(tmpdir(), 'browser-tools-tabs-'));
    const args = [...LEAN_CHROME_ARGS, `--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'];
    if (headless) args.push('--headless=new');
    if (proxyServer) {
      // Chrome sends loopback addresses around a proxy unless told otherwise, and WebRTC around it
      // over UDP, either of which would let a page reach what the proxy refuses.
      args.push(`--proxy-server=${proxyServer}`, '--proxy-bypass-list=<-loopback>', '--webrtc-ip-handling-policy=disable_non_proxied_udp');
    }
    args.push(...chromeArgs);
    const child = spawn(chromeBin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    const portFile = join(profile, 'DevToolsActivePort');
    const deadline = Date.now() + CHROME_START_TIMEOUT_MS;
    let exit = null;
    exited.then((value) => {
      exit = value;
    });
    while (!existsSync(portFile) || readFileSync(portFile, 'utf8').split('\n').length < 2) {
      if (exit) throw new Error(`Chrome exited while starting (${exit.signal ?? exit.code}): ${stderr.trim().slice(-500)}`);
      if (Date.now() > deadline) {
        child.kill('SIGKILL');
        throw new Error(`Chrome did not start within ${CHROME_START_TIMEOUT_MS}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const [cdpPort, path] = readFileSync(portFile, 'utf8').split('\n');
    const cdpUrl = `ws://127.0.0.1:${cdpPort}${path}`;
    const browser = await connectOwnBrowser(cdpUrl, { targetFilter: () => false });
    const session = await browser.target().createCDPSession();
    const started = { child, browser, session, cdpUrl, cdpPort: Number(cdpPort), profile, exited };
    exited.then(({ code, signal }) => {
      if (chrome === started) chrome = null;
      rmSync(profile, { recursive: true, force: true });
      if (!closed) log({ event: 'browser_exit', code, signal });
    });
    log({ event: 'browser_start', pid: child.pid });
    return started;
  }

  async function ensureChrome() {
    if (chrome && chrome.browser.connected && chrome.child.exitCode === null && chrome.child.signalCode === null) return chrome;
    chrome = null;
    starting ??= launchChrome().finally(() => {
      starting = null;
    });
    chrome = await starting;
    return chrome;
  }

  function pump() {
    while (!closed && held.size < maxTabs && waiting.length > 0) {
      const lease = waiting.shift();
      held.add(lease);
      void grant(lease);
    }
  }

  function write(lease, line) {
    if (!lease.response.writableEnded && !lease.response.destroyed) lease.response.write(`${JSON.stringify(line)}\n`);
  }

  function end(lease, ended) {
    if (lease.ended) return;
    lease.ended = ended;
    clearTimeout(lease.timer);
    held.delete(lease);
    if (lease.context && lease.chrome) {
      lease.chrome.session.send('Target.disposeBrowserContext', { browserContextId: lease.context }).catch(() => {});
    }
    log({
      event: 'tab_lease',
      client: lease.client,
      waited_ms: (lease.granted ?? Date.now()) - lease.asked,
      held_ms: lease.granted ? Date.now() - lease.granted : 0,
      ended,
      tabs: held.size,
      waiting: waiting.length,
    });
    if (ended !== 'released') {
      write(lease, ended === 'error' ? { error: lease.error } : { ended });
      lease.response.end();
    }
    pump();
  }

  async function grant(lease) {
    try {
      const running = await ensureChrome();
      lease.chrome = running;
      const { browserContextId } = await running.session.send('Target.createBrowserContext', {
        disposeOnDetach: false,
        ...(proxyServer ? { proxyServer, proxyBypassList: '<-loopback>' } : {}),
      });
      lease.context = browserContextId;
      await running.session.send('Browser.setDownloadBehavior', { behavior: 'deny', browserContextId });
      // The tab opens on an address of its own, which is how a client finds it among the browser's targets.
      const tabUrl = `about:blank#${randomUUID()}`;
      const { targetId } = await running.session.send('Target.createTarget', { url: tabUrl, browserContextId });
      if (lease.gone) return end(lease, 'released');
      lease.granted = Date.now();
      lease.timer = setTimeout(() => end(lease, 'expired'), tabSeconds * 1000);
      write(lease, { cdp_url: running.cdpUrl, target_id: targetId, tab_url: tabUrl, deadline: lease.granted + tabSeconds * 1000 });
    } catch (error) {
      lease.error = error instanceof Error ? error.message : String(error);
      end(lease, 'error');
    }
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://broker');
    if (request.method !== 'GET' || url.pathname !== '/lease') {
      response.writeHead(404).end();
      return;
    }
    if (closed) {
      response.writeHead(503).end();
      return;
    }
    const lease = { client: url.searchParams.get('client') || 'unnamed', asked: Date.now(), response, gone: false };
    response.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
    response.flushHeaders();
    response.on('close', () => {
      lease.gone = true;
      const queued = waiting.indexOf(lease);
      if (queued >= 0) waiting.splice(queued, 1);
      else if (lease.granted) end(lease, 'released');
    });
    waiting.push(lease);
    pump();
  });
  server.requestTimeout = 0;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const sampler =
    process.platform === 'linux'
      ? setInterval(() => {
          if (!chrome) return;
          const sample = chromeMemory(chrome.child.pid);
          if (sample) log({ event: 'browser_memory', ...sample, tabs: held.size, waiting: waiting.length });
        }, sampleSeconds * 1000)
      : null;
  sampler?.unref();

  const address = server.address();
  return {
    url: `http://${host}:${address.port}`,
    get cdpPort() {
      return chrome?.cdpPort ?? null;
    },
    async close() {
      closed = true;
      if (sampler) clearInterval(sampler);
      for (const lease of [...held]) end(lease, 'closed');
      for (const lease of waiting.splice(0)) lease.response.writeHead?.(503) && lease.response.end();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      const running = chrome ?? (await starting?.catch(() => null));
      if (!running) return;
      await running.session.send('Browser.close').catch(() => {});
      running.browser.disconnect().catch?.(() => {});
      const stopped = await Promise.race([
        running.exited.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), CHROME_STOP_TIMEOUT_MS)),
      ]);
      if (!stopped) {
        running.child.kill('SIGKILL');
        await running.exited;
      }
    },
  };
}

const PROCESS_TYPES = { renderer: 'renderer', 'gpu-process': 'gpu', utility: 'utility', zygote: 'zygote' };

/** Proportional set size of Chrome's process tree, by process type, from /proc. */
export function chromeMemory(rootPid) {
  const children = new Map();
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid).push(Number(name));
    } catch {
      // The process exited while the table was read.
    }
  }
  const pss = { browser: 0, renderer: 0, gpu: 0, utility: 0, zygote: 0, other: 0 };
  let processes = 0;
  let renderers = 0;
  const pending = [rootPid];
  while (pending.length > 0) {
    const pid = pending.pop();
    pending.push(...(children.get(pid) ?? []));
    try {
      const rollup = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
      const kib = Number(/^Pss:\s+(\d+)/m.exec(rollup)?.[1] ?? 0);
      const type = /--type=([\w-]+)/.exec(readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' '))?.[1];
      const key = pid === rootPid ? 'browser' : (PROCESS_TYPES[type] ?? 'other');
      pss[key] += kib;
      processes += 1;
      if (key === 'renderer') renderers += 1;
    } catch {
      // The process exited while it was read.
    }
  }
  if (processes === 0) return null;
  const mib = (kib) => Math.round(kib / 1024);
  return {
    total_mib: mib(Object.values(pss).reduce((sum, kib) => sum + kib, 0)),
    pss_mib: Object.fromEntries(Object.entries(pss).map(([key, kib]) => [key, mib(kib)])),
    processes,
    renderers,
  };
}

/**
 * Waits for a tab from the broker at `brokerUrl`. The tab is the client's until `release()` is called
 * or the process exits; `ended` settles with 'expired' if the broker took the tab back first.
 * The tab is the page at `tabUrl` in the browser at `cdpUrl`.
 */
export function leaseTab(brokerUrl, { client = 'unnamed' } = {}) {
  return new Promise((resolve, reject) => {
    let granted = null;
    let finish;
    const ended = new Promise((resolveEnded) => {
      finish = resolveEnded;
    });
    const request = httpGet(`${brokerUrl}/lease?client=${encodeURIComponent(client)}`, { agent: false }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`the tab broker refused the lease with HTTP ${response.statusCode}`));
        return;
      }
      response.setEncoding('utf8');
      let buffer = '';
      response.on('data', (chunk) => {
        buffer += chunk;
        for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
          const line = JSON.parse(buffer.slice(0, index));
          buffer = buffer.slice(index + 1);
          if (line.error) {
            reject(new Error(`the tab broker could not open a tab: ${line.error}`));
          } else if (!granted) {
            granted = {
              cdpUrl: line.cdp_url,
              targetId: line.target_id,
              tabUrl: line.tab_url,
              deadline: line.deadline,
              ended,
              release: () => request.destroy(),
            };
            resolve(granted);
          } else if (line.ended) {
            finish(line.ended);
          }
        }
      });
      response.on('close', () => {
        if (!granted) reject(new Error('the tab broker closed the lease before granting a tab'));
        finish('released');
      });
    });
    request.on('error', (error) => {
      if (!granted) reject(error);
      finish('released');
    });
  });
}
