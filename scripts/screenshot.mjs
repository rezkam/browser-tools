#!/usr/bin/env node
/**
 * Take a screenshot of the active tab's viewport, full page, or one element.
 * Prints the file path so the agent can read it.
 *
 * Usage:
 *   scripts/screenshot.mjs
 *   scripts/screenshot.mjs --port 9223
 *   scripts/screenshot.mjs --full
 *   scripts/screenshot.mjs --viewport 375x667 --mobile
 *   scripts/screenshot.mjs --viewport 375x667 --scale 2 --selector 'table.results'
 *   scripts/screenshot.mjs --owner-token "$BROWSER_TOOLS_OWNER_TOKEN"
 */

import { writeFileSync } from 'node:fs';
import { activePage, hasFlag, parseOwnerToken, parsePort, requiredOptionValue, timestampedTmpPath, withBrowser } from './browser-control.mjs';
import { capturePage, parseViewport, pngSize } from './viewport.mjs';

try {
  const args = process.argv.slice(2);
  const port = parsePort(args);
  const ownerToken = parseOwnerToken(args);
  const fullPage = hasFlag(args, '--full');
  const selector = requiredOptionValue(args, '--selector', null);
  const viewport = parseViewport(args);
  if (fullPage && selector) throw new Error('Use only one of --full or --selector');

  await withBrowser(port, async (browser) => {
    const page = await activePage(browser);
    const filepath = timestampedTmpPath('browser-screenshot', 'png');
    const image = await capturePage(page, { viewport, fullPage, selector });
    writeFileSync(filepath, image);
    const { width, height } = pngSize(image);
    console.error(`${width}x${height} px`);
    console.log(filepath);
  }, { ownerToken });
} catch (error) {
  console.error(`✗ ${error.message}`);
  process.exitCode = 1;
}
