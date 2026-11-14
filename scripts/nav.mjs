#!/usr/bin/env node
/**
 * Navigate the active tab or open a new one.
 *
 * Usage:
 *   scripts/nav.mjs https://example.com
 *   scripts/nav.mjs https://example.com --new
 *   scripts/nav.mjs https://example.com --port 9223
 *   scripts/nav.mjs https://example.com --viewport 375x667 --mobile
 *   scripts/nav.mjs https://example.com --owner-token "$BROWSER_TOOLS_OWNER_TOKEN"
 */

import { activePage, hasFlag, parseOwnerToken, parsePort, withBrowser } from './browser-control.mjs';
import { parseViewport, withViewport } from './viewport.mjs';

const args = process.argv.slice(2);
const url = args.find((a) => a.startsWith('http') || a.startsWith('file'));
const newTab = hasFlag(args, '--new');
const port = parsePort(args);
const ownerToken = parseOwnerToken(args);
let viewport;
try {
  viewport = parseViewport(args);
} catch (error) {
  console.error(`✗ ${error.message}`);
  process.exit(1);
}

if (!url) {
  console.log('Usage: scripts/nav.mjs <url> [--new] [--port <n>] [--viewport <width>x<height> [--mobile] [--scale <n>]]');
  console.log('  scripts/nav.mjs https://example.com');
  console.log('  scripts/nav.mjs https://example.com --new');
  process.exit(1);
}

await withBrowser(port, async (browser) => {
  if (newTab) {
    const page = await browser.newPage({ background: true });
    await withViewport(page, viewport, () => page.goto(url, { waitUntil: 'domcontentloaded' }));
    console.log(`✓ Opened new tab: ${url}`);
    return;
  }

  const page = await activePage(browser);
  await withViewport(page, viewport, () => page.goto(url, { waitUntil: 'domcontentloaded' }));
  console.log(`✓ Navigated to: ${url}`);
}, { ownerToken });
