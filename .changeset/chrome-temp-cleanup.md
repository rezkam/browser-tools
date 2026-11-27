---
"@rezkam/browser-tools": patch
---

Give each managed Chrome its own temporary directory and remove it when Chrome stops, so stopped browsers no longer leave `org.chromium.Chromium.*` directories in the system temporary directory. The next launch also removes directories left by a Chrome that crashed or was killed.
