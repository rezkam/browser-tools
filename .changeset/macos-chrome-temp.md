---
"@rezkam/browser-tools": patch
---

Keep Chrome's own temporary directory on macOS, where a private directory nested in the per-user TMPDIR made Chrome's singleton socket path too long and Chrome failed to start. The temporary-directory cleanup now applies to Linux only.
