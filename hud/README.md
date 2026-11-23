# Antigravity Context HUD (macOS)

A lightweight, native macOS floating overlay HUD built on top of [`ahmetdotsh/agy-context`](https://github.com/ahmetdotsh/agy-context)'s unmodified `analyzer.mjs` engine.

## Why?

Antigravity 2.0's official Sidecar UI API currently only supports right-hand auxiliary pane tabs (`AUX_PANE`), not a composer-footer status bar. This HUD gives you a subtle, non-activating floating pill you can place right beneath Antigravity's input box — **without modifying or injecting into the Antigravity app bundle**.

- **100% Read-Only & Local**: Uses the exact unmodified `sidecars/context_panel/analyzer.mjs` engine over local NDJSON stdin/stdout (zero network requests, zero extra LLM tokens, zero client patching).
- **Auto-Show / Auto-Hide**: Appears automatically when `Antigravity` (`com.google.antigravity`) is frontmost and hides when you switch to other apps (configurable).
- **Non-Activating & Draggable**: Drag the pill anywhere (position is saved automatically); clicking or dragging never steals focus from Antigravity's input box.
- **Per-Session Control**: Auto-tracks the latest active session by default, or click the pill to inspect category breakdowns, cache hit rates, compaction count, and switch/pin any recent session.
- **Easy Upstream Sync**: Because `sidecars/context_panel/analyzer.mjs` is untouched, syncing upstream core updates is simply:
  ```bash
  git fetch upstream && git merge upstream/main
  ```

## Requirements

- macOS 13+ with Xcode Command Line Tools (`swiftc`)
- Node.js 22.5+ (for built-in `node:sqlite`)

## Build & Run

```bash
chmod +x hud/build.sh
./hud/build.sh
open hud/build/AntigravityContextHUD.app
```

## License

MIT (same as upstream `ahmetdotsh/agy-context`).
