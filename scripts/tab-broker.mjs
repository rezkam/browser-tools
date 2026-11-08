/**
 * One Chrome shared by every client on the machine, handing out at most `maxTabs` tabs at a time.
 *
 * A client leases a tab with an HTTP request that the broker answers with one JSON line once a tab is
 * free and then holds open. The tab lives in a browser context of its own, so tabs share no cookies or
 * storage, and the context is disposed when the client closes the connection (or exits), or when the
 * tab has been held for `tabSeconds`.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, get as httpGet } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectOwnBrowser } from './browser-control.mjs';
import { createTabPool } from './tab-pool.mjs';

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
    let processState = { phase: 'starting' };
    child.once('error', (error) => { processState = { phase: 'failed', error }; });
    const exited = new Promise((resolve) => child.once('close', (code, signal) => {
      const previous = processState.phase;
      if (previous !== 'failed') processState = { phase: 'exited', code, signal };
      rmSync(profile, { recursive: true, force: true });
      if (previous === 'running') log({ event: 'browser_exit', code, signal });
      resolve({ code, signal });
    }));
    let browser;
    try {
      const portFile = join(profile, 'DevToolsActivePort');
      const deadline = Date.now() + CHROME_START_TIMEOUT_MS;
      while (!existsSync(portFile) || readFileSync(portFile, 'utf8').split('\n').length < 2) {
        if (processState.phase === 'failed') throw processState.error;
        if (processState.phase === 'exited') throw new Error(`Chrome exited while starting (${processState.signal ?? processState.code}): ${stderr.trim().slice(-500)}`);
        if (Date.now() > deadline) throw new Error(`Chrome did not start within ${CHROME_START_TIMEOUT_MS}ms`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const [cdpPort, path] = readFileSync(portFile, 'utf8').split('\n');
      const cdpUrl = `ws://127.0.0.1:${cdpPort}${path}`;
      browser = await connectOwnBrowser(cdpUrl, { targetFilter: () => false });
      const session = await browser.target().createCDPSession();
      processState = { phase: 'running' };
      log({ event: 'browser_start', pid: child.pid });
      return {
        child, browser, session, cdpUrl, cdpPort: Number(cdpPort), exited,
        async close() {
          if (processState.phase === 'exited' || processState.phase === 'failed') return;
          processState = { phase: 'stopping' };
          // Do not let an unresponsive CDP connection prevent the bounded process shutdown.
          void session.send('Browser.close').catch(() => {});
          let timer;
          const stopped = await Promise.race([
            exited.then(() => true),
            new Promise((resolve) => { timer = setTimeout(() => resolve(false), CHROME_STOP_TIMEOUT_MS); }),
          ]);
          clearTimeout(timer);
          if (!stopped) { child.kill('SIGKILL'); await exited; }
          await browser.disconnect().catch(() => {});
        },
      };
    } catch (error) {
      await browser?.disconnect().catch(() => {});
      if (processState.phase !== 'exited' && processState.phase !== 'failed') child.kill('SIGKILL');
      await exited;
      throw error;
    }
  }

  const pool = createTabPool({ launchChrome, maxTabs, tabSeconds, proxyServer, log });

  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://broker');
    if (request.method !== 'GET' || url.pathname !== '/lease') {
      response.writeHead(404).end();
      return;
    }
    pool.add(response, url.searchParams.get('client') || 'unnamed');
  });
  server.requestTimeout = 0;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const sampler =
    process.platform === 'linux'
      ? setInterval(() => {
          if (!pool.running) return;
          const sample = chromeMemory(pool.running.child.pid);
          if (sample) log({ event: 'browser_memory', ...sample, ...pool.counts });
        }, sampleSeconds * 1000)
      : null;
  sampler?.unref();

  const address = server.address();
  return {
    url: `http://${host}:${address.port}`,
    get cdpPort() {
      return pool.running?.cdpPort ?? null;
    },
    async close() {
      if (sampler) clearInterval(sampler);
      const closing = pool.close();
      const transportClosed = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections();
      await Promise.all([transportClosed, closing]);
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
    let state = { phase: 'waiting' };
    let resolveEnded;
    const ended = new Promise((resolve) => { resolveEnded = resolve; });
    const finish = (reason, error = null) => {
      if (state.phase === 'ended') return;
      if (state.phase === 'waiting') reject(error ?? new Error(`the tab broker ${reason} the lease before granting a tab`));
      state = { phase: 'ended', reason };
      resolveEnded(reason);
    };
    const request = httpGet(`${brokerUrl}/lease?client=${encodeURIComponent(client)}`, { agent: false }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        finish('error', new Error(`the tab broker refused the lease with HTTP ${response.statusCode}`));
        request.destroy();
        return;
      }
      response.setEncoding('utf8');
      let buffer = '';
      response.on('data', (chunk) => {
        buffer += chunk;
        for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
          if (state.phase === 'ended') return;
          try {
            const line = JSON.parse(buffer.slice(0, index));
            buffer = buffer.slice(index + 1);
            if (line.error) {
              finish('error', new Error(`the tab broker could not open a tab: ${line.error}`));
              request.destroy();
            } else if (line.ended) {
              finish(line.ended);
              request.destroy();
            } else if (state.phase === 'waiting') {
              if (!line.cdp_url || !line.target_id || !line.tab_url || !Number.isFinite(line.deadline)) {
                throw new Error('the tab broker sent an invalid lease grant');
              }
              state = { phase: 'active' };
              resolve({
                cdpUrl: line.cdp_url,
                targetId: line.target_id,
                tabUrl: line.tab_url,
                deadline: line.deadline,
                ended,
                release: () => { finish('released'); request.destroy(); },
              });
            }
          } catch (error) {
            finish('error', error);
            request.destroy();
          }
        }
      });
      response.on('error', (error) => finish('released', error));
      response.on('close', () => finish('released', new Error('the tab broker closed the lease before granting a tab')));
    });
    request.on('error', (error) => finish('released', error));
  });
}
