---
"@rezkam/browser-tools": patch
---

Automatically reclaim managed Chrome sessions that have run for two hours after their recorded launcher exits. Record launcher process identity to detect PID reuse, keep live launchers protected regardless of age, and run the fail-safe reap before enforcing the browser limit.
