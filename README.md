# Chrome / Brave extensions

This repository contains browser extensions built for Chromium-based browsers (Chrome, Brave, Edge, etc.).

| Extension | Folder | Description |
|-----------|--------|-------------|
| **Subtitle Sync Loader** | [`subtitle-sync-extension/`](subtitle-sync-extension/) | Load external `.srt` files onto page video (including JW Player), adjust timing, and debug multi-frame players. |

---

## Subtitle Sync Loader

**Manifest:** [Manifest V3](https://developer.chrome.com/docs/extensions/mv3/)  
**Current version:** see `subtitle-sync-extension/manifest.json`

### What it does

Lets you attach your own **SubRip (`.srt`)** subtitles to the video on the active tab. It targets the frame that actually contains the player (including **iframes** and **JW Player** style `.jw-video` elements), converts SRT to **WebVTT** in memory, and drives a single `<track src="blob:…">` so timing tweaks do not stack duplicate cue sets.

You can **shift all subtitle timings** in small steps (±0.1s, ±1s), **reset** delay, and **remember delay per hostname** in extension storage.

### How it works (technical)

1. **Toolbar click** — The service worker (`background.js`) scores every frame in the tab for video-like content and injects `inject.js` into the best-matching frame.
2. **Singleton + teardown** — Each new run tears down the previous instance (UI, listeners, clears conflicting text tracks on videos) so duplicate native tracks do not stack.
3. **SRT → cues** — The script parses SRT into normalized cue rows (start/end/text). Unsupported HTML-ish tags from SRT are normalized for **WebVTT** (only a small tag set like `<b>`, `<i>`, `<u>` is meaningful in native cues; `<font>` etc. are stripped or mapped).
4. **Rendering** — Cues are emitted as a **blob WebVTT** URL and assigned to one `<track>` on the `<video>`. On every delay change, the blob is **replaced** (JW Player often breaks `removeCue`/`addCue` loops, which used to duplicate subtitles).
5. **Built-in vs extension** — Other `TextTrack`s on the same video are set to `disabled` so stream/bundled captions do not draw on top; a short interval re-applies that if the player toggles tracks.
6. **Debug** — “Debug HTML” asks the background script to run a probe in **all frames** and opens an HTML report (useful when the top URL is a shell like `/home` but the player lives in an iframe on another host).

The on-page UI is **draggable**, can **collapse to a “CC” pill**, and tries to stay visible (high `z-index`, mount on `document.documentElement`, reparent on fullscreen when the fullscreen element is not a raw `<video>`).

### Install (developer / unpacked)

1. Clone this repo.
2. Open `chrome://extensions` (Chrome) or `brave://extensions` (Brave).
3. Enable **Developer mode**.
4. Click **Load unpacked** and choose the `subtitle-sync-extension` folder (the one that contains `manifest.json`).

Grant any prompts for **tabs** / site access the browser shows.

### Usage

1. Open a page with a playing or paused **HTML video** (e.g. a JW Player watch page).
2. Click the extension icon (**Load subtitles**).
3. Choose an `.srt` file when the file picker opens.
4. Use the floating **Subtitle sync** panel:
   - **Header** (“Subtitle sync”) — drag to move the panel.
   - **▾** — collapse to the round **CC** button; click **CC** (without dragging) to expand again; drag **CC** to move when collapsed.
   - **Delay** readout — shows the current offset in seconds (e.g. `Delay: -1.0s`).
   - **`−1s` / `−0.1s` / `+0.1s` / `+1s`** — nudge all cues earlier/later.
   - **Reset** — zero the delay (and cues rebaseline to the file, with offset 0).
   - **Retry Detect** — re-scan for the main `<video>` (e.g. after the player loads late).
   - **Debug HTML** — download/open a multi-frame diagnostic report.

**Keyboard (when the injected frame is focused and cues are loaded):**

- **`[`** — subtract **0.1s** from delay  
- **`]`** — add **0.1s** to delay  

Delay is persisted **per hostname** (the host of the injected frame, e.g. the play page host).

### Permissions (why they exist)

| Permission | Purpose |
|------------|---------|
| `activeTab` | Run when you invoke the extension on the current tab. |
| `scripting` | Inject `inject.js` into the chosen frame. |
| `storage` | Save subtitle delay per host. |
| `tabs` | Resolve the active tab when building the all-frames debug report if needed. |
| `<all_urls>` (host permission) | Probe and inject across frames and sites (e.g. parent `net22.cc` + iframe `net52.cc`). |

### Troubleshooting

- **No video / wrong frame** — Start playback once, use **Retry Detect**, or run **Debug HTML** and look for the frame that lists a `.jw-video` / `<video>` and use that URL for viewing.
- **Double subtitles** — Usually two caption tracks “showing”; the extension tries to disable non-extension tracks. Turn off CC in the player UI if it keeps re-enabling.
- **Raw `<font>` / HTML in text** — Native tracks are not HTML; fancy tags are normalized. Colors from `<font>` are not reproduced on built-in rendering.
- **Panel not visible** — Exit strict native **video-element fullscreen** if possible; use the player’s windowed/theatre mode. The UI reparents under the fullscreen **container** when it is not a bare `<video>`.

### Project layout

```text
extension/
├── README.md                 ← this file
├── .gitignore
└── subtitle-sync-extension/
    ├── manifest.json
    ├── background.js        # icon click, frame probe, inject target, debug aggregation
    └── inject.js            # UI, SRT parse, WebVTT blob track, delay, JW mitigations
```

### License

If you add a license file for redistribution, place it in the repo root and reference it here.
