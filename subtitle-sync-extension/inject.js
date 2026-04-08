(() => {
  const INSTANCE_KEY = "__subtitleSyncExtensionV1__";
  const prevInstance = window[INSTANCE_KEY];
  if (prevInstance?.teardown) {
    try {
      prevInstance.teardown();
    } catch (_err) {}
  }

  const STATE_KEY = "subtitle-sync-offsets-v1";
  const DEBUG_REPORT_NAME = "subtitle-sync-debug-report.html";
  let selectedVideo = null;
  /** Our <track> element (blob WebVTT src). Replaced per offset change — removeCue fails on JW so we never stack VTTCues. */
  let subtitleTrackEl = null;
  let lastVttBlobUrl = null;
  let subtitleLabel = "Subtitle Sync";
  /** @type {{ start: number; end: number; text: string }[]} */
  let baseCueData = [];
  let offset = 0;
  let keyboardBound = false;
  let detectRetryTimer = null;
  let mutationObserver = null;
  const host = location.hostname || "unknown-host";

  function getVideoCandidates() {
    const all = Array.from(document.querySelectorAll("video, .jw-video"));
    return all.filter((v) => {
      const rect = v.getBoundingClientRect();
      return rect.width > 80 && rect.height > 60;
    });
  }

  function choosePrimaryVideo() {
    const candidates = getVideoCandidates();
    if (!candidates.length) return null;
    if (candidates.length === 1) return candidates[0];

    // Prefer JW player video element when present.
    const jwNode = candidates.find((v) => v.classList.contains("jw-video"));
    if (jwNode) return jwNode;

    const playing = candidates.find((v) => v.readyState >= 2 && !v.paused);
    if (playing) return playing;

    // Prefer the largest rendered video.
    candidates.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return br.width * br.height - ar.width * ar.height;
    });
    return candidates[0];
  }

  function collectTextTrackDiagnostics() {
    const videos = Array.from(document.querySelectorAll("video"));
    return videos.map((video, videoIndex) => {
      const rect = video.getBoundingClientRect();
      const textTracks = [];
      for (let i = 0; i < video.textTracks.length; i++) {
        const t = video.textTracks[i];
        let cueCount = 0;
        try {
          cueCount = t.cues ? t.cues.length : 0;
        } catch (_e) {
          cueCount = -1;
        }
        textTracks.push({
          index: i,
          kind: t.kind,
          label: t.label || "",
          language: t.language || "",
          id: t.id || "",
          mode: t.mode,
          cueCount
        });
      }
      const trackElements = Array.from(video.querySelectorAll("track")).map((el, i) => ({
        index: i,
        kind: el.kind,
        label: el.label || "",
        srclang: el.srclang || "",
        srcSnippet: (el.src || "").slice(0, 160)
      }));
      const showingCount = textTracks.filter((x) => x.mode === "showing").length;
      const captionLike = textTracks.filter(
        (x) => x.kind === "subtitles" || x.kind === "captions"
      );
      const captionLikeShowingCount = captionLike.filter((x) => x.mode === "showing").length;
      return {
        videoIndex,
        className: video.className || "",
        approxWidth: Math.round(rect.width),
        approxHeight: Math.round(rect.height),
        textTrackCount: textTracks.length,
        textTracksInShowingMode: showingCount,
        captionLikeTrackCount: captionLike.length,
        captionLikeShowingCount,
        textTracks,
        trackElements
      };
    });
  }

  function diagnoseDuplicateSubtitles() {
    const perVideo = collectTextTrackDiagnostics();
    const msgs = [];
    for (const v of perVideo) {
      if (v.captionLikeShowingCount > 1) {
        msgs.push(
          `Video #${v.videoIndex}: ${v.captionLikeShowingCount} subtitle/caption tracks are "showing" at once — lines stack. Keep only one (extension mutes others when your SRT is active).`
        );
      }
      const bundled = v.textTracks.filter(
        (t) =>
          (t.kind === "subtitles" || t.kind === "captions") &&
          t.cueCount > 0 &&
          t.mode === "showing"
      );
      if (bundled.length === 1 && v.captionLikeShowingCount === 1) {
        msgs.push(
          `Video #${v.videoIndex}: built-in/stream subtitles look active ("${bundled[0].label || bundled[0].kind}"). Loading an external SRT disables other tracks so only yours should display.`
        );
      }
    }
    return { hints: msgs, perVideo };
  }

  function getJwInfo() {
    const info = { found: false, players: [] };
    if (typeof window.jwplayer !== "function") return info;
    info.found = true;
    const instances = window.jwplayer().getAllPlayers
      ? window.jwplayer().getAllPlayers()
      : [];
    info.players = instances.map((p) => {
      try {
        const container = p.getContainer ? p.getContainer() : null;
        const video = container ? container.querySelector("video, .jw-video") : null;
        return {
          id: p.id || "unknown",
          state: p.getState ? p.getState() : "unknown",
          hasContainer: !!container,
          hasVideoNode: !!video
        };
      } catch (_err) {
        return { id: "unknown", state: "error", hasContainer: false, hasVideoNode: false };
      }
    });
    return info;
  }

  function openDebugReportLocalFallback(reason) {
    const videos = Array.from(document.querySelectorAll("video, .jw-video")).map((v, index) => {
      const r = v.getBoundingClientRect();
      return {
        index,
        className: v.className || "",
        currentSrc: v.currentSrc || "",
        readyState: Number(v.readyState || 0),
        paused: typeof v.paused === "boolean" ? v.paused : null,
        width: Math.round(r.width),
        height: Math.round(r.height)
      };
    });
    const jw = getJwInfo();
    const trackDiag = diagnoseDuplicateSubtitles();
    const extMeta = {
      instanceKey: INSTANCE_KEY,
      hadPreviousExtensionRunBeforeThisInject: Boolean(prevInstance),
      scopeNote:
        "This report is only for the current frame. If Duplicate diagnosis is empty, the player is probably in an iframe or on another route — use Debug HTML again after reloading the extension (v1.5+) for an all-frames report.",
      note: "Subtitles use a <track src=blob: WebVTT> on <video>. Delay changes replace that blob so cues are not stacked."
    };
    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Subtitle Sync Debug Report (single frame)</title>
  <style>
    body { font-family: system-ui, sans-serif; padding: 16px; line-height: 1.45; }
    pre { background: #111; color: #ddd; padding: 12px; border-radius: 8px; overflow: auto; }
    code { background: #f2f2f2; padding: 2px 6px; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>Subtitle Sync Debug Report (single frame only)</h1>
  <p><strong>Reason:</strong> ${escapeHtml(reason)}</p>
  <p><strong>This frame URL:</strong> ${escapeHtml(location.href)}</p>
  <p><strong>Timestamp:</strong> ${new Date().toISOString()}</p>
  <h2>Extension inject metadata</h2>
  <pre>${escapeHtml(JSON.stringify(extMeta, null, 2))}</pre>
  <h2>Duplicate subtitle diagnosis</h2>
  <pre>${escapeHtml(JSON.stringify(trackDiag, null, 2))}</pre>
  <h2>Detected Video/JW Nodes</h2>
  <pre>${escapeHtml(JSON.stringify(videos, null, 2))}</pre>
  <h2>JW Player Info</h2>
  <pre>${escapeHtml(JSON.stringify(jw, null, 2))}</pre>
</body>
</html>`;

    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = DEBUG_REPORT_NAME;
    a.click();
    window.open(url, "_blank", "noopener,noreferrer");
  }

  function openDebugReport(reason) {
    const injectMeta = {
      instanceKey: INSTANCE_KEY,
      hadPreviousExtensionRunBeforeThisInject: Boolean(prevInstance),
      panelFrameHref: location.href
    };

    const doneWithHtml = (html) => {
      const blob = new Blob([html], { type: "text/html" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = DEBUG_REPORT_NAME;
      a.click();
      window.open(url, "_blank", "noopener,noreferrer");
    };

    try {
      if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage(
          {
            type: "subtitle-sync-full-debug",
            reason: String(reason || "manual debug"),
            injectMeta
          },
          (res) => {
            const err = chrome.runtime.lastError;
            if (err || !res || !res.html) {
              openDebugReportLocalFallback(reason);
              return;
            }
            doneWithHtml(res.html);
          }
        );
        return;
      }
    } catch (_e) {}

    openDebugReportLocalFallback(reason);
  }

  function escapeHtml(input) {
    return String(input)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }

  function parseSrtTimePart(part) {
    const s = String(part).trim().replace(",", ".");
    const m = s.match(/^(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/);
    if (!m) return NaN;
    return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000;
  }

  function formatVttTimestamp(sec) {
    if (!Number.isFinite(sec)) sec = 0;
    const msRounded = Math.round(sec * 1000);
    const ms = Math.max(0, msRounded);
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const mm = ms % 1000;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(mm).padStart(3, "0")}`;
  }

  /** Build a WebVTT string from parsed SRT (offset shifts all timestamps). */
  /**
   * WebVTT cue payload is not HTML. Browsers only treat a small tag set as markup (<b>, <i>, <u>).
   * SRT often has <font>, <span>, etc. — those show as raw text unless we strip or map them.
   */
  function normalizeCueTextForWebVtt(raw) {
    let s = String(raw).replace(/\r/g, "");
    s = s.replace(/&nbsp;/gi, " ");
    s = s.replace(/<br\s*\/?>/gi, "\n");
    s = s.replace(/<\s*font[^>]*>/gi, "");
    s = s.replace(/<\s*\/\s*font\s*>/gi, "");
    s = s.replace(/<\s*strong\b[^>]*>/gi, "<b>");
    s = s.replace(/<\s*\/\s*strong\s*>/gi, "</b>");
    s = s.replace(/<\s*em\b[^>]*>/gi, "<i>");
    s = s.replace(/<\s*\/\s*em\s*>/gi, "</i>");
    s = s.replace(/<\s*\/?\s*(span|div|p)\b[^>]*>/gi, "");
    s = s.replace(/<(\/?)\s*([a-z][a-z0-9]*)\b[^>]*>/gi, (_m, slash, name) => {
      const n = String(name).toLowerCase();
      const sl = slash ? "/" : "";
      if (n === "b" || n === "i" || n === "u") return `<${sl}${n}>`;
      return "";
    });
    s = s.replace(/&/g, (match, offset, full) => {
      const rest = full.slice(offset);
      if (/^&(amp|lt|gt|quot|nbsp|#[0-9]{1,6}|#x[0-9a-f]{1,6});/i.test(rest)) return match;
      return "&amp;";
    });
    s = s.replace(/-->/g, "--\\>");
    return s.trim();
  }

  function buildWebVttFromBaseCueData(cues, offsetSec) {
    let out = "WEBVTT\n\n";
    let n = 0;
    for (const row of cues) {
      let start = row.start + offsetSec;
      let end = row.end + offsetSec;
      if (end <= 0) continue;
      start = Math.max(0, start);
      const text = normalizeCueTextForWebVtt(row.text);
      out += `${++n}\n`;
      out += `${formatVttTimestamp(start)} --> ${formatVttTimestamp(end)}\n`;
      out += `${text}\n\n`;
    }
    return out;
  }

  /** Parse SRT into base cue timings (seconds). Offset is applied by regenerating WebVTT blob on each change (JW-safe). */
  function parseSrtToCueData(srtText) {
    const text = String(srtText).replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
    if (!text) return [];
    const blocks = text.split(/\n\s*\n/);
    const out = [];
    for (const block of blocks) {
      const lines = block.split("\n").map((l) => l.trimEnd());
      if (!lines.length || !lines[0]) continue;
      let idx = 0;
      if (/^\d+$/.test(lines[0].trim())) idx = 1;
      if (idx >= lines.length) continue;
      const timeLine = lines[idx];
      const tm = timeLine.match(
        /(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/
      );
      if (!tm) continue;
      const start = parseSrtTimePart(tm[1]);
      const end = parseSrtTimePart(tm[2]);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      const cueText = lines.slice(idx + 1).join("\n").trim();
      out.push({ start, end, text: cueText });
    }
    return out;
  }

  /** Before attaching our SRT: drop &lt;track&gt; tags and hide all native TextTracks without removing cues (avoids fighting JW / stream subtitles with thousands of cues). */
  function prepareVideoForOurSubtitles(video) {
    if (!video) return;
    video.querySelectorAll("track").forEach((el) => el.remove());
    try {
      const n = video.textTracks.length;
      for (let i = 0; i < n; i++) {
        const t = video.textTracks[i];
        try {
          t.mode = "disabled";
        } catch (_e) {}
      }
    } catch (_e) {}
  }

  /** Remove HTML track elements, disable every TextTrack, and drop all cues (teardown / extension uninstall from page). */
  function resetAllTextTracksOnVideo(video) {
    if (!video) return;
    video.querySelectorAll("track").forEach((el) => el.remove());
    try {
      const n = video.textTracks.length;
      for (let i = 0; i < n; i++) {
        const t = video.textTracks[i];
        try {
          t.mode = "disabled";
        } catch (_e) {}
        let cues;
        try {
          cues = t.cues ? Array.from(t.cues) : [];
        } catch (_e) {
          cues = [];
        }
        for (let j = cues.length - 1; j >= 0; j--) {
          try {
            t.removeCue(cues[j]);
          } catch (_e2) {}
        }
      }
    } catch (_e) {}
  }

  /** Only our extension track should paint native cues; JW / prior runs leave extra tracks in "showing". */
  function muteOtherTextTracks(ourTrack) {
    if (!selectedVideo || !ourTrack) return;
    try {
      for (let i = 0; i < selectedVideo.textTracks.length; i++) {
        const t = selectedVideo.textTracks[i];
        if (t !== ourTrack) {
          try {
            t.mode = "disabled";
          } catch (_e) {}
        }
      }
    } catch (_e) {}
  }

  /** @type {ReturnType<typeof setTimeout> | null} */
  let offsetApplyTimer = null;
  let vttApplyGeneration = 0;

  function applySubtitleOffsetNow(offsetSec) {
    if (!selectedVideo || !baseCueData.length) return;

    const myGen = ++vttApplyGeneration;
    const vtt = buildWebVttFromBaseCueData(baseCueData, offsetSec);
    const blob = new Blob([vtt], { type: "text/vtt" });
    const newUrl = URL.createObjectURL(blob);
    const prevUrl = lastVttBlobUrl;

    let finished = false;
    const afterLoad = () => {
      if (myGen !== vttApplyGeneration) {
        URL.revokeObjectURL(newUrl);
        return;
      }
      if (finished) return;
      finished = true;
      if (prevUrl) URL.revokeObjectURL(prevUrl);
      lastVttBlobUrl = newUrl;
      const tt = subtitleTrackEl?.track;
      if (tt) {
        muteOtherTextTracks(tt);
        tt.mode = "showing";
      }
    };

    if (!subtitleTrackEl) {
      subtitleTrackEl = document.createElement("track");
      subtitleTrackEl.kind = "subtitles";
      subtitleTrackEl.label = subtitleLabel;
      subtitleTrackEl.srclang = "en";
      subtitleTrackEl.dataset.subtitleSync = "1";
      subtitleTrackEl.default = true;
      subtitleTrackEl.addEventListener("load", afterLoad);
      subtitleTrackEl.src = newUrl;
      selectedVideo.appendChild(subtitleTrackEl);
      setTimeout(afterLoad, 400);
      return;
    }

    subtitleTrackEl.addEventListener("load", afterLoad, { once: true });
    subtitleTrackEl.src = newUrl;
    setTimeout(afterLoad, 400);
  }

  function queueApplySubtitleOffset(offsetSec) {
    if (offsetApplyTimer) clearTimeout(offsetApplyTimer);
    offsetApplyTimer = setTimeout(() => {
      offsetApplyTimer = null;
      applySubtitleOffsetNow(offsetSec);
    }, 90);
  }

  let delayReadoutEl = null;

  function formatDelayReadout() {
    const sign = offset >= 0 ? "+" : "";
    return `Delay: ${sign}${offset.toFixed(1)}s`;
  }

  function refreshDelayReadout() {
    if (delayReadoutEl) delayReadoutEl.textContent = formatDelayReadout();
  }

  let subtitlePanelCollapsed = false;

  function clampPanelPosition(shell) {
    if (!shell?.isConnected) return;
    const w = shell.offsetWidth || 48;
    const h = shell.offsetHeight || 48;
    let x = parseFloat(shell.style.left) || 0;
    let y = parseFloat(shell.style.top) || 0;
    const maxX = Math.max(8, window.innerWidth - w - 8);
    const maxY = Math.max(8, window.innerHeight - h - 8);
    x = Math.min(Math.max(8, x), maxX);
    y = Math.min(Math.max(8, y), maxY);
    shell.style.left = `${x}px`;
    shell.style.top = `${y}px`;
    shell.style.right = "auto";
    shell.style.bottom = "auto";
  }

  function startDragPanelShell(shell, cursorEl, e) {
    if (e.button !== 0) return;
    const rect = shell.getBoundingClientRect();
    const grabX = e.clientX - rect.left;
    const grabY = e.clientY - rect.top;
    cursorEl.style.cursor = "grabbing";

    const onMove = (ev) => {
      let nx = ev.clientX - grabX;
      let ny = ev.clientY - grabY;
      const w = shell.offsetWidth;
      const h = shell.offsetHeight;
      nx = Math.max(8, Math.min(nx, window.innerWidth - w - 8));
      ny = Math.max(8, Math.min(ny, window.innerHeight - h - 8));
      shell.style.left = `${nx}px`;
      shell.style.top = `${ny}px`;
      shell.style.right = "auto";
      shell.style.bottom = "auto";
    };

    const onUp = () => {
      cursorEl.style.cursor = "grab";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  function addControlPanel({ onStep, onReset, onRetry, onDebug }) {
    const existing = document.getElementById("subtitle-sync-controls");
    if (existing) existing.remove();

    const shell = document.createElement("div");
    shell.id = "subtitle-sync-controls";
    shell.style.position = "fixed";
    shell.style.setProperty("z-index", "2147483647", "important");
    shell.style.isolation = "isolate";
    shell.style.pointerEvents = "auto";
    shell.style.visibility = "visible";
    shell.style.opacity = "1";
    shell.style.fontFamily = "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto";
    shell.style.maxWidth = "min(420px, calc(100vw - 24px))";

    const approxW = 320;
    const approxH = 200;
    shell.style.left = `${Math.max(8, window.innerWidth - approxW - 16)}px`;
    shell.style.top = `${Math.max(8, window.innerHeight - approxH - 16)}px`;

    const expanded = document.createElement("div");
    expanded.style.display = "flex";
    expanded.style.flexDirection = "column";
    expanded.style.gap = "10px";

    const headerBar = document.createElement("div");
    headerBar.style.display = "flex";
    headerBar.style.alignItems = "center";
    headerBar.style.justifyContent = "space-between";
    headerBar.style.gap = "8px";
    headerBar.style.cursor = "grab";
    headerBar.style.userSelect = "none";
    headerBar.style.margin = "-2px 0 0";
    headerBar.title = "Drag to move";

    const headerTitle = document.createElement("span");
    headerTitle.textContent = "Subtitle sync";
    headerTitle.style.fontSize = "12px";
    headerTitle.style.color = "#aaa";
    headerTitle.style.fontWeight = "600";

    const collapseBtn = document.createElement("button");
    collapseBtn.type = "button";
    collapseBtn.textContent = "▾";
    collapseBtn.title = "Collapse to small button";
    collapseBtn.setAttribute("aria-label", "Collapse panel");
    collapseBtn.style.flexShrink = "0";
    collapseBtn.style.background = "#3a3a3a";
    collapseBtn.style.color = "#fff";
    collapseBtn.style.border = "1px solid #666";
    collapseBtn.style.borderRadius = "6px";
    collapseBtn.style.padding = "2px 8px";
    collapseBtn.style.cursor = "pointer";
    collapseBtn.style.fontSize = "14px";
    collapseBtn.style.lineHeight = "1.2";

    headerBar.appendChild(headerTitle);
    headerBar.appendChild(collapseBtn);

    headerBar.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      if (e.target instanceof HTMLElement && e.target.closest("button")) return;
      e.preventDefault();
      startDragPanelShell(shell, headerBar, e);
    });

    delayReadoutEl = document.createElement("div");
    delayReadoutEl.setAttribute("aria-live", "polite");
    delayReadoutEl.style.color = "#f0f0f0";
    delayReadoutEl.style.fontSize = "14px";
    delayReadoutEl.style.fontWeight = "600";
    delayReadoutEl.style.fontVariantNumeric = "tabular-nums";
    delayReadoutEl.style.letterSpacing = "0.02em";
    delayReadoutEl.textContent = formatDelayReadout();

    const btnRow = document.createElement("div");
    btnRow.style.display = "flex";
    btnRow.style.flexWrap = "wrap";
    btnRow.style.gap = "8px";
    btnRow.style.alignItems = "center";

    const mkBtn = (text, title, onClick) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = text;
      btn.title = title;
      btn.style.background = "#2a2a2a";
      btn.style.color = "#fff";
      btn.style.border = "1px solid #666";
      btn.style.borderRadius = "8px";
      btn.style.padding = "8px 10px";
      btn.style.cursor = "pointer";
      btn.style.whiteSpace = "nowrap";
      btn.addEventListener("click", onClick);
      return btn;
    };

    btnRow.appendChild(mkBtn("-1s", "Shift subtitles earlier by 1s", () => onStep(-1)));
    btnRow.appendChild(mkBtn("-0.1s", "Shift subtitles earlier by 0.1s", () => onStep(-0.1)));
    btnRow.appendChild(mkBtn("+0.1s", "Shift subtitles later by 0.1s", () => onStep(0.1)));
    btnRow.appendChild(mkBtn("+1s", "Shift subtitles later by 1s", () => onStep(1)));
    btnRow.appendChild(mkBtn("Reset", "Reset subtitle delay to 0", onReset));
    btnRow.appendChild(mkBtn("Retry Detect", "Try finding active video again", onRetry));
    btnRow.appendChild(mkBtn("Debug HTML", "Download/open debug report", onDebug));

    expanded.appendChild(headerBar);
    expanded.appendChild(delayReadoutEl);
    expanded.appendChild(btnRow);

    const fab = document.createElement("button");
    fab.type = "button";
    fab.textContent = "CC";
    fab.title = "Subtitle sync — click to expand, drag to move";
    fab.setAttribute("aria-label", "Expand subtitle controls");
    fab.style.display = "none";
    fab.style.alignItems = "center";
    fab.style.justifyContent = "center";
    fab.style.width = "46px";
    fab.style.height = "46px";
    fab.style.borderRadius = "50%";
    fab.style.background = "rgba(22, 22, 22, 0.94)";
    fab.style.color = "#fff";
    fab.style.border = "2px solid #666";
    fab.style.boxShadow = "0 4px 16px rgba(0,0,0,.45)";
    fab.style.cursor = "grab";
    fab.style.fontSize = "13px";
    fab.style.fontWeight = "700";
    fab.style.padding = "0";
    fab.style.fontFamily = "inherit";

    function applyShellLayout() {
      if (subtitlePanelCollapsed) {
        expanded.style.display = "none";
        fab.style.display = "flex";
        shell.style.background = "transparent";
        shell.style.border = "none";
        shell.style.boxShadow = "none";
        shell.style.padding = "0";
        shell.style.borderRadius = "0";
        shell.style.maxWidth = "none";
        shell.style.minWidth = "";
      } else {
        expanded.style.display = "flex";
        fab.style.display = "none";
        shell.style.background = "rgba(22, 22, 22, 0.92)";
        shell.style.border = "1px solid #444";
        shell.style.borderRadius = "10px";
        shell.style.padding = "10px 12px";
        shell.style.boxShadow = "0 4px 24px rgba(0,0,0,.35)";
        shell.style.maxWidth = "min(420px, calc(100vw - 24px))";
        shell.style.minWidth = "260px";
      }
      requestAnimationFrame(() => clampPanelPosition(shell));
    }

    collapseBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      subtitlePanelCollapsed = true;
      applyShellLayout();
    });

    shell.appendChild(expanded);
    shell.appendChild(fab);

    function getPanelMountRoot() {
      const fs =
        document.fullscreenElement ||
        (/** @type {Document & { webkitFullscreenElement?: Element | null }} */ (document)
          .webkitFullscreenElement ??
          null);
      if (fs instanceof HTMLElement && fs.tagName !== "VIDEO") return fs;
      return document.documentElement;
    }

    getPanelMountRoot().appendChild(shell);

    subtitlePanelCollapsed = false;
    applyShellLayout();

    const onResize = () => {
      if (!shell.isConnected) {
        window.removeEventListener("resize", onResize);
        return;
      }
      clampPanelPosition(shell);
    };
    window.addEventListener("resize", onResize);

    const onFullscreenReparent = () => {
      if (!document.getElementById("subtitle-sync-controls")) return;
      getPanelMountRoot().appendChild(shell);
      clampPanelPosition(shell);
    };
    document.addEventListener("fullscreenchange", onFullscreenReparent);
    document.addEventListener("webkitfullscreenchange", onFullscreenReparent);

    /** @type {HTMLElement & { _subtitleSyncCleanup?: () => void }} */
    const shellWithCleanup = shell;
    shellWithCleanup._subtitleSyncCleanup = () => {
      document.removeEventListener("fullscreenchange", onFullscreenReparent);
      document.removeEventListener("webkitfullscreenchange", onFullscreenReparent);
      window.removeEventListener("resize", onResize);
    };

    fab.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      const rect = shell.getBoundingClientRect();
      const grabX = e.clientX - rect.left;
      const grabY = e.clientY - rect.top;
      let moved = false;
      fab.style.cursor = "grabbing";

      const onMove = (ev) => {
        if (Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) > 6) moved = true;
        let nx = ev.clientX - grabX;
        let ny = ev.clientY - grabY;
        const w = shell.offsetWidth;
        const h = shell.offsetHeight;
        nx = Math.max(8, Math.min(nx, window.innerWidth - w - 8));
        ny = Math.max(8, Math.min(ny, window.innerHeight - h - 8));
        shell.style.left = `${nx}px`;
        shell.style.top = `${ny}px`;
        shell.style.right = "auto";
        shell.style.bottom = "auto";
      };

      const onUp = () => {
        fab.style.cursor = "grab";
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        if (!moved) {
          subtitlePanelCollapsed = false;
          applyShellLayout();
        }
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  async function loadSavedOffset(host) {
    return new Promise((resolve) => {
      chrome.storage.local.get([STATE_KEY], (result) => {
        const state = result[STATE_KEY] || {};
        resolve(Number(state[host] || 0));
      });
    });
  }

  async function saveOffset(host, offset) {
    return new Promise((resolve) => {
      chrome.storage.local.get([STATE_KEY], (result) => {
        const state = result[STATE_KEY] || {};
        state[host] = Number(offset.toFixed(1));
        chrome.storage.local.set({ [STATE_KEY]: state }, resolve);
      });
    });
  }

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".srt";
  fileInput.style.display = "none";
  document.body.appendChild(fileInput);

  let keyDownHandler = null;
  let docClickHandler = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  let bundledSubsGuardTimer = null;

  function teardownInstance() {
    if (bundledSubsGuardTimer) {
      clearInterval(bundledSubsGuardTimer);
      bundledSubsGuardTimer = null;
    }
    if (detectRetryTimer) {
      clearTimeout(detectRetryTimer);
      detectRetryTimer = null;
    }
    if (mutationObserver) {
      mutationObserver.disconnect();
      mutationObserver = null;
    }
    if (keyDownHandler) {
      document.removeEventListener("keydown", keyDownHandler);
      keyDownHandler = null;
    }
    if (docClickHandler) {
      document.removeEventListener("click", docClickHandler, true);
      docClickHandler = null;
    }
    const uiShell = document.getElementById("subtitle-sync-controls");
    if (uiShell) {
      const c = /** @type {HTMLElement & { _subtitleSyncCleanup?: () => void }} */ (uiShell)
        ._subtitleSyncCleanup;
      if (typeof c === "function") c();
      uiShell.remove();
    }
    if (fileInput.parentNode) fileInput.remove();
    if (offsetApplyTimer) {
      clearTimeout(offsetApplyTimer);
      offsetApplyTimer = null;
    }
    if (lastVttBlobUrl) {
      URL.revokeObjectURL(lastVttBlobUrl);
      lastVttBlobUrl = null;
    }
    if (subtitleTrackEl?.parentNode) subtitleTrackEl.remove();
    subtitleTrackEl = null;
    document.querySelectorAll("video").forEach((v) => resetAllTextTracksOnVideo(v));
    baseCueData = [];
    keyboardBound = false;
    subtitlePanelCollapsed = false;
  }

  const setOffset = async (nextOffset) => {
    const next = Number(Number(nextOffset).toFixed(1));
    if (Math.abs(next - offset) < 1e-6) {
      refreshDelayReadout();
      return;
    }

    if (!baseCueData.length) {
      offset = next;
      await saveOffset(host, offset);
      refreshDelayReadout();
      return;
    }

    queueApplySubtitleOffset(next);
    offset = next;
    await saveOffset(host, offset);
    refreshDelayReadout();
    console.log(`Subtitle offset: ${offset.toFixed(1)}s`);
  };

  const stepBy = async (delta) => setOffset(offset + delta);
  const reset = async () => setOffset(0);

  const retryDetection = (reason = "manual retry") => {
    selectedVideo = window.videoEl || choosePrimaryVideo();
    if (selectedVideo) {
      console.log("Subtitle Sync: video detected.", selectedVideo);
      return true;
    }
    console.log(`Subtitle Sync: no video detected (${reason}).`);
    return false;
  };

  addControlPanel({
    onStep: stepBy,
    onReset: reset,
    onRetry: () => retryDetection("retry button"),
    onDebug: () => openDebugReport("manual debug")
  });

  const bindKeyboard = () => {
    if (keyboardBound) return;
    keyboardBound = true;

    keyDownHandler = async (e) => {
      if (!baseCueData.length) return;
      if (e.key === "[") await stepBy(-0.1);
      if (e.key === "]") await stepBy(0.1);
    };
    document.addEventListener("keydown", keyDownHandler);
  };

  // Try to detect video after play/pause clicks from JW UI or custom players.
  docClickHandler = () => {
    if (detectRetryTimer) clearTimeout(detectRetryTimer);
    detectRetryTimer = setTimeout(() => {
      retryDetection("post click");
    }, 120);
  };
  document.addEventListener("click", docClickHandler, true);

  // Watch for late-created video elements.
  mutationObserver = new MutationObserver(() => {
    if (!selectedVideo) retryDetection("mutation observer");
  });
  mutationObserver.observe(document.documentElement, { childList: true, subtree: true });

  fileInput.onchange = () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async () => {
      const srt = String(reader.result || "");

      if (!selectedVideo && !retryDetection("before track attach")) {
        alert("Video not detected yet. Click play/pause once, then click extension again.");
        openDebugReport("video not found before subtitle attach");
        return;
      }

      if (lastVttBlobUrl) {
        URL.revokeObjectURL(lastVttBlobUrl);
        lastVttBlobUrl = null;
      }
      if (subtitleTrackEl?.parentNode) subtitleTrackEl.remove();
      subtitleTrackEl = null;

      prepareVideoForOurSubtitles(selectedVideo);
      baseCueData = parseSrtToCueData(srt);

      if (!baseCueData.length) {
        alert("Could not parse any subtitles from this SRT file.");
        return;
      }

      subtitleLabel = file.name.replace(/\.srt$/i, "") || "Subtitle Sync";

      bindKeyboard();

      const saved = await loadSavedOffset(host);
      offset = Number(saved.toFixed(1));
      applySubtitleOffsetNow(offset);
      refreshDelayReadout();

      if (bundledSubsGuardTimer) clearInterval(bundledSubsGuardTimer);
      bundledSubsGuardTimer = setInterval(() => {
        const tt = subtitleTrackEl?.track;
        if (tt && selectedVideo) muteOtherTextTracks(tt);
      }, 1200);

      console.log(
        `Subtitles loaded. ${baseCueData.length} cues. Delay: ${offset.toFixed(1)}s (WebVTT blob track; delay changes replace src, no cue stack).`
      );
    };
    reader.readAsText(file);
  };

  window[INSTANCE_KEY] = {
    teardown: teardownInstance,
    openDebugReport,
    hadPreviousRun: Boolean(prevInstance)
  };

  // Initial detection attempt; if missing, keep UI available and still allow manual retry/debug.
  retryDetection("initial");
  fileInput.click();
})();
