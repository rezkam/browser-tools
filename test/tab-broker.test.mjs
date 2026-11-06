import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect as netConnect } from 'node:net';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { browserToolsChromeBin, connectLeasedTab } from '../scripts/browser-control.mjs';
import { leaseTab, serveTabs } from '../scripts/tab-broker.mjs';

const chromeBin = process.env.BROWSER_TOOLS_CHROME_BIN || browserToolsChromeBin();
const skip = existsSync(chromeBin) ? false : `no Chrome at ${chromeBin}; set BROWSER_TOOLS_CHROME_BIN`;
const chromeArgs = process.platform === 'linux' ? ['--no-sandbox'] : [];

async function broker(t, options = {}) {
  const lines = [];
  const served = await serveTabs({ chromeBin, chromeArgs, headless: true, log: (line) => lines.push(line), ...options });
  t.after(() => served.close());
  served.lines = lines;
  return served;
}

const leasedPage = connectLeasedTab;

function settled(promise) {
  return Promise.race([promise.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 300))]);
}

test('a lease beyond the tab limit waits until a tab is released', { skip }, async (t) => {
  const { url } = await broker(t, { maxTabs: 2 });
  const first = await leaseTab(url, { client: 'first' });
  const second = await leaseTab(url, { client: 'second' });
  const third = leaseTab(url, { client: 'third' });
  assert.equal(await settled(third), false);
  first.release();
  const granted = await third;
  assert.ok(granted.targetId);
  second.release();
  granted.release();
});

test('a tab held past its time limit is closed and its lease ends', { skip }, async (t) => {
  const { url, lines } = await broker(t, { maxTabs: 1, tabSeconds: 1 });
  const lease = await leaseTab(url, { client: 'slow' });
  const { browser, page } = await leasedPage(lease);
  t.after(() => browser.disconnect());
  assert.equal(await lease.ended, 'expired');
  await assert.rejects(page.evaluate(() => 1));
  const next = await leaseTab(url, { client: 'next' });
  next.release();
  assert.ok(lines.some((line) => line.event === 'tab_lease' && line.client === 'slow' && line.ended === 'expired'));
});

test('a client that exits without releasing frees its tab', { skip }, async (t) => {
  const { url } = await broker(t, { maxTabs: 1 });
  const module = fileURLToPath(new URL('../scripts/tab-broker.mjs', import.meta.url));
  const child = spawn(process.execPath, [
    '--input-type=module',
    '-e',
    `const { leaseTab } = await import(${JSON.stringify(module)}); await leaseTab(${JSON.stringify(url)}, { client: 'child' }); console.log('leased'); process.exit(0);`,
  ]);
  await new Promise((resolve) => child.stdout.once('data', resolve));
  const lease = await leaseTab(url, { client: 'after-exit' });
  lease.release();
});

test('tabs do not share cookies', { skip }, async (t) => {
  const { url } = await broker(t);
  const a = await leaseTab(url, { client: 'a' });
  const b = await leaseTab(url, { client: 'b' });
  const pa = await leasedPage(a);
  const pb = await leasedPage(b);
  t.after(() => {
    pa.browser.disconnect();
    pb.browser.disconnect();
    a.release();
    b.release();
  });
  await pa.page.setCookie({ name: 'account', value: 'one', domain: 'example.com', path: '/' });
  assert.equal((await pa.page.cookies('https://example.com/')).length, 1);
  assert.deepEqual(await pb.page.cookies('https://example.com/'), []);
});

test('with a proxy, every request goes through it, loopback included', { skip }, async (t) => {
  const seen = [];
  const proxy = createServer((request, response) => {
    seen.push(request.url);
    response.writeHead(403).end();
  });
  proxy.on('connect', (request, socket) => {
    seen.push(request.url);
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => proxy.close());
  const served = await broker(t, { proxyServer: `http://127.0.0.1:${proxy.address().port}` });
  const lease = await leaseTab(served.url, { client: 'guarded' });
  const cdpPort = served.cdpPort;
  const { browser, page } = await leasedPage(lease);
  t.after(() => {
    browser.disconnect();
    lease.release();
  });
  await page.goto(`http://127.0.0.1:${cdpPort}/json/version`).catch(() => null);
  await page.goto('https://example.com/').catch(() => null);
  assert.ok(seen.some((target) => target.includes(`127.0.0.1:${cdpPort}`)), `proxy saw ${seen.join(', ')}`);
  assert.ok(seen.some((target) => target.startsWith('example.com:443')), `proxy saw ${seen.join(', ')}`);
});

test('the broker reports Chrome memory and its tabs', { skip: skip || (process.platform !== 'linux' && 'memory is read from /proc') }, async (t) => {
  const { url, lines } = await broker(t, { sampleSeconds: 0.2 });
  const lease = await leaseTab(url, { client: 'sampled' });
  await new Promise((resolve) => setTimeout(resolve, 600));
  lease.release();
  const sample = lines.find((line) => line.event === 'browser_memory' && line.tabs === 1);
  assert.ok(sample, JSON.stringify(lines));
  assert.ok(sample.pss_mib.browser > 0);
  assert.ok(sample.processes > 1);
});

test('the broker stops its Chrome when closed', { skip }, async () => {
  const served = await serveTabs({ chromeBin, chromeArgs, headless: true, log: () => {} });
  const lease = await leaseTab(served.url, { client: 'last' });
  lease.release();
  const port = served.cdpPort;
  await served.close();
  const reachable = await new Promise((resolve) => {
    const socket = netConnect(port, '127.0.0.1', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
  });
  assert.equal(reachable, false);
});

test('browser-tools serve stops itself and its Chrome when its parent goes away', { skip }, async () => {
  const bin = fileURLToPath(new URL('../bin/browser-tools.mjs', import.meta.url));
  const args = ['serve', '--headless', '--until-stdin-closes', ...chromeArgs.flatMap((arg) => ['--chrome-arg', arg])];
  const child = spawn(process.execPath, [bin, ...args], { env: { ...process.env, BROWSER_TOOLS_CHROME_BIN: chromeBin } });
  const { url } = JSON.parse(await new Promise((resolve) => child.stdout.once('data', (chunk) => resolve(String(chunk)))));
  const lease = await leaseTab(url, { client: 'cli' });
  const browser = await puppeteer.connect({ browserWSEndpoint: lease.cdpUrl });
  const disconnected = new Promise((resolve) => browser.once('disconnected', resolve));
  child.stdin.end();
  await disconnected;
  assert.equal(await lease.ended, 'closed');
  await new Promise((resolve) => child.once('exit', resolve));
});

test('with a proxy, WebRTC cannot send UDP around it', { skip }, async (t) => {
  const { createSocket } = await import('node:dgram');
  const listener = createSocket('udp4');
  const received = [];
  listener.on('message', (message) => received.push(message));
  await new Promise((resolve) => listener.bind(0, '127.0.0.1', resolve));
  t.after(() => listener.close());
  const proxy = createServer((request, response) => response.writeHead(403).end());
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => proxy.close());
  const served = await broker(t, { proxyServer: `http://127.0.0.1:${proxy.address().port}` });
  const lease = await leaseTab(served.url, { client: 'webrtc' });
  const { browser, page } = await leasedPage(lease);
  t.after(() => {
    browser.disconnect();
    lease.release();
  });
  await page.evaluate(async (port) => {
    const peer = new RTCPeerConnection({ iceServers: [{ urls: `stun:127.0.0.1:${port}` }] });
    peer.createDataChannel('probe');
    await peer.setLocalDescription(await peer.createOffer());
  }, listener.address().port);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.deepEqual(received, []);
});
