---
"@rezkam/browser-tools": patch
---

Headless launches no longer report automation or Chrome's default 800x600 screen. They disable the `AutomationControlled` Blink feature so `navigator.webdriver` is false, and present a 1920x1080 screen with a 1920x1040 window, so bot defenses that reject those headless signals treat the browser like a windowed one.
