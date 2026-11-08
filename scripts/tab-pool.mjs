import { randomUUID } from 'node:crypto';

// Transport-independent owner of the service, lazy browser, and individual lease lifecycles.
// Queued leases hold no slot. Allocating leases keep their slot until late resources are disposed.
export function createTabPool({ launchChrome, maxTabs, tabSeconds, proxyServer, log }) {
  const waiting = [];
  const held = new Set();
  const allocations = new Set();
  const releases = new Set();
  let service = { phase: 'open' };
  let browser = { phase: 'idle' };

  function track(set, task) {
    set.add(task);
    task.then(() => set.delete(task), () => set.delete(task));
    return task;
  }

  function stopBrowser(running) {
    const result = Promise.resolve().then(() => running.close()).then(() => {
      browser = { phase: 'idle' };
    }, (error) => {
      // Keep ownership on failure so a later stop can retry, never orphan the process.
      browser = { phase: 'running', value: running };
      throw error;
    });
    browser = { phase: 'stopping', result };
    return result;
  }

  async function ensureChrome() {
    if (service.phase !== 'open') throw new Error('The tab broker is closed');
    if (browser.phase === 'running') {
      const running = browser.value;
      if (running.browser.connected && running.child.exitCode === null && running.child.signalCode === null) return running;
      await stopBrowser(running);
      return ensureChrome();
    }
    if (browser.phase === 'stopping') {
      await browser.result;
      return ensureChrome();
    }
    if (browser.phase === 'idle') {
      const result = Promise.resolve().then(launchChrome).then((running) => {
        browser = { phase: 'running', value: running };
        running.exited.then(({ code, signal }) => {
          if (browser.phase === 'running' && browser.value === running) browser = { phase: 'idle' };
          for (const lease of held) {
            if (lease.chrome !== running) continue;
            lease.error = `Chrome exited (${signal ?? code})`;
            end(lease, 'error');
          }
        });
        return running;
      }, (error) => {
        browser = { phase: 'idle' };
        throw error;
      });
      browser = { phase: 'starting', result };
    }
    return browser.result;
  }

  function pump() {
    while (service.phase === 'open' && held.size < maxTabs && waiting.length > 0) {
      const lease = waiting.shift();
      lease.state = { phase: 'allocating' };
      held.add(lease);
      track(allocations, grant(lease));
    }
  }

  function write(lease, line) {
    if (!lease.response.writableEnded && !lease.response.destroyed) lease.response.write(`${JSON.stringify(line)}\n`);
  }

  function dispose(lease) {
    lease.disposal ??= track(releases, (async () => {
      if (lease.context) {
        try {
          await lease.chrome.session.send('Target.disposeBrowserContext', { browserContextId: lease.context });
        } catch {
          // An unconfirmed disposal must not free capacity while its browser can still own the tab.
          if (browser.phase === 'running' && browser.value === lease.chrome) await stopBrowser(lease.chrome);
          else if (browser.phase === 'stopping') await browser.result;
        }
      }
      held.delete(lease);
      pump();
    })());
    return lease.disposal;
  }

  function end(lease, reason) {
    const previous = lease.state.phase;
    if (previous === 'ended') return;
    lease.state = { phase: 'ended', reason };
    clearTimeout(lease.timer);
    const queued = waiting.indexOf(lease);
    if (queued >= 0) waiting.splice(queued, 1);
    log({
      event: 'tab_lease',
      client: lease.client,
      waited_ms: (lease.granted ?? Date.now()) - lease.asked,
      held_ms: lease.granted ? Date.now() - lease.granted : 0,
      ended: reason,
      tabs: [...held].filter((candidate) => candidate.state.phase !== 'ended').length,
      waiting: waiting.length,
    });
    if (reason !== 'released') write(lease, reason === 'error' ? { error: lease.error } : { ended: reason });
    lease.response.end();
    if (previous === 'active') void dispose(lease);
    // An allocating lease is disposed by grant's finally, even if the context arrives after end.
  }

  async function grant(lease) {
    try {
      const running = await ensureChrome();
      if (lease.state.phase !== 'allocating') return;
      lease.chrome = running;
      const { browserContextId } = await running.session.send('Target.createBrowserContext', {
        disposeOnDetach: false,
        ...(proxyServer ? { proxyServer, proxyBypassList: '<-loopback>' } : {}),
      });
      lease.context = browserContextId;
      if (lease.state.phase !== 'allocating') return;
      await running.session.send('Browser.setDownloadBehavior', { behavior: 'deny', browserContextId });
      if (lease.state.phase !== 'allocating') return;
      const tabUrl = `about:blank#${randomUUID()}`;
      const { targetId } = await running.session.send('Target.createTarget', { url: tabUrl, browserContextId });
      if (lease.state.phase !== 'allocating') return;
      lease.state = { phase: 'active' };
      lease.granted = Date.now();
      lease.timer = setTimeout(() => end(lease, 'expired'), tabSeconds * 1000);
      write(lease, { cdp_url: running.cdpUrl, target_id: targetId, tab_url: tabUrl, deadline: lease.granted + tabSeconds * 1000 });
    } catch (error) {
      lease.error = error instanceof Error ? error.message : String(error);
      end(lease, 'error');
    } finally {
      if (lease.state.phase === 'ended') await dispose(lease);
    }
  }

  function close() {
    if (service.phase === 'closing' || service.phase === 'closed') return service.result;
    // Publish closing before ending responses, whose close handlers can reenter the pool.
    const result = Promise.resolve().then(async () => {
      if (browser.phase === 'starting') await browser.result.catch(() => {});
      // Closing Chrome breaks stalled CDP work. Waiting for allocations first could deadlock.
      if (browser.phase === 'running') await stopBrowser(browser.value);
      else if (browser.phase === 'stopping') await browser.result;
      await Promise.allSettled([...allocations]);
      await Promise.allSettled([...releases]);
    }).then(() => { service = { phase: 'closed', result }; }, (error) => {
      service = { phase: 'close-failed', error };
      throw error;
    });
    service = { phase: 'closing', result };
    for (const lease of [...held, ...waiting]) end(lease, 'closed');
    return result;
  }

  return {
    get running() { return browser.phase === 'running' ? browser.value : null; },
    get counts() { return { tabs: held.size, waiting: waiting.length }; },
    add(response, client) {
      if (service.phase !== 'open') { response.writeHead(503).end(); return; }
      const lease = { state: { phase: 'queued' }, client, asked: Date.now(), response };
      response.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
      response.flushHeaders();
      response.on('close', () => end(lease, 'released'));
      waiting.push(lease);
      pump();
    },
    close,
  };
}
