---
name: context
description: Open the native Context side-pane panel to inspect live token usage, prompt cache status, and category breakdown for the current conversation. Use when the user runs /context or asks to open the context panel.
---

# Context panel

Open or guide the user to the **Context** side-pane panel (`context/context_panel`).

## Instructions

1. Check read-only whether the `context/context_panel` sidecar is active:
   - Look up `.sidecars["context/context_panel"].enabled == true` in `~/.gemini/config/config.json`, or
   - Check if `~/.gemini/antigravity/sidecar_data/context/context_panel/logs/sidecar.log` exists and is non-empty.
2. **If active**, output the one-click pill on its own line:
   `[Context](sidecar://context/context_panel/)`
   Tell the user they can open it from the `+` button (`Cmd+T`) in the side panel, and pin the tab via **Right-click tab -> Pin Tab**.
3. **If not yet enabled**, do not output a `sidecar://context/context_panel/` link. Instead, provide:
   - `[Context](customization://context)`
   - `[Open Sidecars Dashboard](sidecar://dashboard)`
   Tell them to turn on the **Context** sidecar once so it appears in the side panel `+` menu (`Cmd+T`) at zero token cost.
