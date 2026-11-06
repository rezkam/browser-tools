---
'@rezkam/browser-tools': minor
---

Add `browser-tools serve`, a tab broker that runs one lean Chrome for every client on a machine and hands out at most `--max-tabs` tabs at a time (default 4), each in its own browser context and taken back after `--tab-seconds` (default 120). A lease is an open HTTP request, so a client that exits gives its tab back. With `--proxy-server`, every request goes through the proxy, loopback and WebRTC included. The broker logs Chrome's memory by process type and every lease as JSON lines. `leaseTab` and `serveTabs` are exported from `@rezkam/browser-tools/tab-broker.mjs`, and `connectLeasedTab` connects to a leased tab.
