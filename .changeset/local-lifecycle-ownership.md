---
"@rezkam/browser-tools": patch
---

Fixed tab allocation, retry and shutdown races with locally owned lifecycle states. Capture failures now release their listeners, GIF finalization runs once, and terminal lease messages cannot grant an empty tab.
