---
"@rezkam/browser-tools": major
---

Require Node.js 22.12 or newer for the pinned Rebrowser Puppeteer backend and add owner-protected unpacked extension loading and updates. Verify on load that a service worker of the loaded version activated, retain extension settings during updates, and keep extension-debugging permissions explicit at launch and during browser reuse.

Breaking: the Rebrowser backend does not send `Runtime.enable`, so `page.on('console')` and `page.on('pageerror')` no longer receive events on pages from `connectBrowser`, `withBrowser`, or `connectLeasedTab`. Pages can detect that call, so it stays off. Read page state with `page.evaluate` or report through `exposeFunction` instead.
