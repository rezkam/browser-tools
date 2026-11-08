#!/usr/bin/env node
/**
 * Serves tabs of one shared Chrome to every client that leases one (see tab-broker.mjs).
 *
 * Usage: serve.mjs [--max-tabs <n>] [--tab-seconds <n>] [--headless] [--proxy-server <url>]
 *                  [--chrome-arg <arg>]... [--port <n>] [--until-stdin-closes]
 *
 * Prints {"url": ...} on stdout once it listens, and one JSON log line per event on stderr.
 */

import { browserToolsChromeBin, hasFlag, parsePositiveIntegerOption, requiredOptionValue } from './browser-control.mjs';
import { DEFAULT_MAX_TABS, DEFAULT_TAB_SECONDS, serveTabs } from './tab-broker.mjs';

const args = process.argv.slice(2);
const chromeArgs = args.flatMap((arg, index) => (args[index - 1] === '--chrome-arg' ? [arg] : []));

const served = await serveTabs({
  chromeBin: browserToolsChromeBin(),
  chromeArgs,
  headless: hasFlag(args, '--headless'),
  proxyServer: requiredOptionValue(args, '--proxy-server'),
  maxTabs: parsePositiveIntegerOption(args, '--max-tabs', DEFAULT_MAX_TABS),
  tabSeconds: parsePositiveIntegerOption(args, '--tab-seconds', DEFAULT_TAB_SECONDS),
  port: parsePositiveIntegerOption(args, '--port', 0),
});
process.stdout.write(`${JSON.stringify({ url: served.url })}\n`);

function stop() {
  // The served instance owns idempotent shutdown, not a second CLI-local stopping flag.
  void served.close().then(() => process.exit(0), (error) => {
    console.error(error.message);
    process.exit(1);
  });
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
// A parent that holds our stdin and dies, even by SIGKILL, closes it, so the browser goes with it.
if (hasFlag(args, '--until-stdin-closes')) {
  process.stdin.on('end', stop);
  process.stdin.on('close', stop);
  process.stdin.resume();
}
