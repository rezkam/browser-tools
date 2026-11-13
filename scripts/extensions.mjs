#!/usr/bin/env node
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  connectBrowser, expandHomePath, parseOwnerToken, parsePort, readManagedStateForPort,
} from './browser-control.mjs';

// Only load explicitly trusted local files. Downloads, archive validation and provider-specific
// configuration belong to the caller; an extension can access the browsing session's site data.
export function extensionDirectory(directory) {
  if (typeof directory !== 'string' || !directory || directory.startsWith('--')) {
    throw new Error('An unpacked extension directory is required');
  }
  const path = realpathSync(expandHomePath(directory));
  if (!statSync(path).isDirectory()) throw new Error('Extension path must be a directory');
  const manifest = JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf8'));
  if (![2, 3].includes(manifest.manifest_version) || typeof manifest.name !== 'string' || !manifest.name.trim()
      || typeof manifest.version !== 'string' || !/^\d+(\.\d+){0,3}$/.test(manifest.version)) {
    throw new Error('Invalid extension manifest');
  }
  return { path, manifest };
}

const WORKER_POLL_MS = 100;
const WORKER_PROBE_MS = 2000;

// The manifest version alone proves nothing about the worker: Chrome answers getManifest() in the
// short-lived global of a worker whose script failed to evaluate. Only a script that ran reaches
// "activated", so require both. Poll instead of waiting on target events, because a healthy worker
// can still be installing when its target appears and no later event would re-check it.
async function extensionWorkerStarted(browser, { id, version, timeout }) {
  const deadline = Date.now() + timeout;
  const probe = async (target) => {
    const worker = await target.worker();
    return worker.evaluate(
      expected => chrome.runtime.getManifest().version === expected && self.serviceWorker?.state === 'activated',
      version,
    );
  };
  while (Date.now() < deadline) {
    const targets = browser.targets().filter(target => target.type() === 'service_worker' && target.url().startsWith(`chrome-extension://${id}/`));
    for (const target of targets) {
      // A worker that is being torn down can leave an evaluation unanswered, so bound each probe.
      let timer;
      const expired = new Promise(resolve => { timer = setTimeout(resolve, WORKER_PROBE_MS, false); });
      try {
        if (await Promise.race([probe(target).catch(() => false), expired])) return true;
      } finally {
        clearTimeout(timer);
      }
    }
    await new Promise(resolve => setTimeout(resolve, WORKER_POLL_MS));
  }
  return false;
}

export async function loadManagedExtension({ directory, port, ownerToken, timeout = 30000 }) {
  const { path, manifest } = extensionDirectory(directory);
  const browser = await connectBrowser(port, { ownerToken });
  try {
    if (!readManagedStateForPort(port)?.extensionDebugging) {
      throw new Error('Extension loading requires a browser started with --extension-debugging or --extension');
    }
    // Chrome reloads an existing unpacked extension at the same path, retaining its ID and storage.
    // Do not uninstall as part of an update: uninstalling destroys the extension settings.
    const id = await browser.installExtension(path);
    const workerVerified = Boolean(manifest.background?.service_worker);
    if (workerVerified && !await extensionWorkerStarted(browser, { id, version: manifest.version, timeout })) {
      throw new Error(`Extension ${manifest.name} ${manifest.version} was loaded, but its service worker did not start within ${timeout}ms. Check the worker script for errors, then update again.`);
    }
    return { id, name: manifest.name, version: manifest.version, directory: path, workerVerified };
  } finally {
    await browser.disconnect();
  }
}

export async function main(args = process.argv.slice(2)) {
  const [command, directory, ...options] = args;
  if (!command || command === '--help' || command === '-h') {
    console.error('Usage: browser-tools extensions load|update <trusted-unpacked-directory> --port <n> [--owner-token <token>]\nUpdate reloads the same directory without uninstalling, retaining extension identity and settings.\nRequires start --extension-debugging (or start --extension <directory>).');
    return command ? 0 : 1;
  }
  if (!['load', 'update'].includes(command)) throw new Error(`Unknown extensions command: ${command}`);
  const result = await loadManagedExtension({ directory, port: parsePort(options), ownerToken: parseOwnerToken(options) });
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch (error) { console.error(`✗ ${error.message}`); process.exitCode = 1; }
}
