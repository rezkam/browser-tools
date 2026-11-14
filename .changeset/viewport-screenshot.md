---
"@rezkam/browser-tools": minor
---

Add `--viewport <width>x<height> [--mobile] [--scale <n>]` to `screenshot`, `eval`, and `nav`, and `screenshot --selector <css>` for one element. A screen size sent with `cdp call` ended with that call, so later commands silently saw a desktop page; the size is now held for the command that asks for it, without reloading the tab, and `cdp call` says when an Emulation override will not last. `screenshot` reports the image size and fails when a viewport capture does not match the requested size, element captures no longer wait forever on background tabs, and a full-page or element capture no longer leaves a desktop page a scrollbar wider than it was. Library code can use `capturePage` and `withViewport` from `@rezkam/browser-tools/viewport.mjs`.
