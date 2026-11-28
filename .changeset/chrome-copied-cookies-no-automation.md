---
"@rezkam/browser-tools": patch
---

Preserve copied-profile cookies on Chrome 158+ on macOS by disabling `KeychainKeyProviderUserDataDirProtection` for cloned profiles, and remove `--enable-automation` from Chrome launches by verifying fixed-port DevTools endpoint ownership through OS socket-to-PID inspection instead of `Browser.getBrowserCommandLine`.
