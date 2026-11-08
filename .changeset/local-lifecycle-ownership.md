---
"@rezkam/browser-tools": patch
---

Fixed tab allocation, retry and shutdown races with locally owned lifecycle states. Capture failures now release their listeners without waiting for stalled body reads, GIF finalization runs once, and terminal lease messages cannot grant an empty tab. Failed disposal can retry or recover capacity after verified browser exit without overwriting a replacement browser.
