# @rezkam/browser-tools

Managed Chrome automation with isolated profiles and owner-protected sessions. Browser Tools can drive pages, inspect the DOM, capture visual and network evidence, and extract page content without connecting to or stopping your main Chrome.

This repository provides both the `browser-tools` skill and the `@rezkam/browser-tools` npm package. The skill uses the same CLI that the package installs.

## Features

- **Isolated browser sessions:** launch windowed or headless Chrome with a fresh profile or a copied Chrome profile, including existing site sessions and extensions.
- **Safe lifecycle management:** every managed browser has an owner token. Browser Tools verifies process identity before connecting or stopping, limits concurrent browsers, reports stale sessions, and can reap orphaned or unowned sessions.
- **Page control and inspection:** navigate tabs, evaluate asynchronous JavaScript, take viewport or full-page screenshots, and interactively pick single or multiple DOM elements.
- **Page extraction:** collect article-like links and nearby timestamps, or extract readable article text from the active tab.
- **Visual evidence:** record an active-tab interaction as a GIF, then generate a sampled contact sheet and JSON metadata for review.
- **Network and protocol tooling:** capture filtered HAR 1.2 traffic, extract a chronological request recipe, record selected raw CDP events, and send guarded CDP calls to the active tab.
- **Local profile configuration:** discover Chrome profiles, create private aliases, and associate one or more profiles with a task.

## Install

Install the skill when Browser Tools should be discoverable as an automation skill:

```bash
npx skills add rezkam/browser-tools
```

Install the package for the global CLI and programmatic exports:

```bash
npm install -g @rezkam/browser-tools
```

Commands can also run without a global install:

```bash
npx @rezkam/browser-tools <command>
```

Browser Tools requires macOS, Google Chrome, and Node.js 20 or newer. GIF recording and review additionally require `ffmpeg` and `ffprobe`:

```bash
brew install ffmpeg
```

## Quick start

```bash
browser-tools start --headless
export BROWSER_TOOLS_OWNER_TOKEN="<owner token from start output>"

browser-tools nav https://example.com --port <reported port>
browser-tools eval 'document.title' --port <reported port>
browser-tools screenshot --full --port <reported port>

browser-tools stop --clean --port <reported port>
```

Use `--profile "<profile or alias>"` when an existing login is needed, `--sync` to refresh the copied profile, or `--task <task>` to use configured task profiles.

## CLI capabilities

| Area | Commands | What they do |
| --- | --- | --- |
| Browser lifecycle | `start`, `status`, `stop` | Launch, inspect, stop, clean, reap, and prune managed Chrome sessions |
| Profile configuration | `config` | Discover profiles, list active profiles, and manage task-to-profile mappings |
| Page control | `nav`, `eval`, `screenshot` | Navigate the active tab or a new background tab, run page JavaScript, and capture PNG screenshots |
| DOM inspection | `pick` | Select one or more visible elements and return tag, id, class, text, HTML, and parent information |
| Page extraction | `scrape-page`, `extract-article` | Extract article-like links with timestamps or readable article text from the active tab |
| Visual recording | `record-gif`, `review-gif` | Record an interaction with pre-roll and post-roll frames, then create a contact sheet and metadata report |
| HTTP capture | `record-har`, `extract-har` | Capture filtered active-tab traffic and derive a compact, non-executable request recipe |
| Chrome DevTools Protocol | `record-cdp`, `cdp` | Record selected raw protocol events or send one guarded direct method call |

Run `browser-tools --help` for the command list. Commands with detailed option references, such as `record-har`, `record-cdp`, and `review-gif`, also support command-level `--help`.

## Safety model

- Managed Chrome always uses a separate user data directory. Copied profiles are snapshots and never run against the live Chrome profile.
- Commands that connect to Chrome or stop an owned browser require the owner token printed by `start`. The token protects browser control, recordings, network capture, CDP access, and shutdown.
- Google identity data is removed from copied profiles by default to protect the source session. `--include-google` is an explicit opt-in for Google-backed workflows.
- Starting without an explicit port can reuse a browser already owned by the caller or allocate another available port. The default concurrent browser limit is five.
- HAR files, extracted recipes, raw CDP events, and GIF review artifacts are written as private local files. Network and protocol output preserves exact evidence by default, with `--redact` available when sensitive values are not needed.
- `extract-har` only describes captured requests. It does not execute or replay them. Known direct CDP methods that bypass managed-browser lifecycle controls are blocked.

Browser Tools stores local configuration under `~/.agents/browser-tools` and managed profiles under `~/.cache/pi-browser-tools`. Timestamped artifacts such as screenshots default to the system temporary directory, while derived outputs such as HAR recipes and GIF reviews stay beside their input files. The documented `BROWSER_TOOLS_*` environment variables override configurable locations.

For detailed ownership rules, profile behavior, capture filters, and command options, see the repository's [SKILL.md](https://github.com/rezkam/browser-tools/blob/main/SKILL.md) and [Browser Control reference](https://github.com/rezkam/browser-tools/blob/main/references/browser-control.md).

## Programmatic use

```js
import { activePage, connectBrowser, startChrome, stopChrome, withBrowser } from '@rezkam/browser-tools';
import { runBrowserResource } from '@rezkam/browser-tools/resource-helper.mjs';
```

The root package export and `@rezkam/browser-tools/browser-control.mjs` both expose the browser lifecycle and connection module. The resource helper export provides the shared lifecycle for generic extractors.

## Development

```bash
npm test             # Unit and CLI contract tests
npm run test:e2e     # Real Chrome and ffmpeg integration tests
npm run validate     # Full validation suite
```

## License

Apache-2.0
