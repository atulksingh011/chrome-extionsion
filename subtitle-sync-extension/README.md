# Subtitle Sync Loader

Load **`.srt`** subtitles onto the video in the active tab—including **JW Player** and **iframe** players—then fine-tune sync with buttons or **`[`** / **`]`**.

## Quick start

1. **Load unpacked** in `chrome://extensions` or `brave://extensions` → select **this folder** (must contain `manifest.json`).
2. Open a watch page, click the extension icon, pick an `.srt` file.
3. Adjust delay with **`±0.1s` / `±1s`**, **Reset**, or keyboard **`[`** / **`]`** (0.1s steps).

## Files

| File | Role |
|------|------|
| `manifest.json` | MV3 manifest, permissions |
| `background.js` | Picks inject frame; runs all-frame debug; injects `inject.js` |
| `inject.js` | UI (draggable / collapsible), SRT → WebVTT blob `<track>`, delay, storage |

## Full documentation

See the repository **[README.md](../README.md)** for architecture, permissions, troubleshooting, and multi-extension index.
