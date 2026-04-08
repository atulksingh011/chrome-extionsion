function probeFrameForMedia() {
  const videos = Array.from(document.querySelectorAll("video, .jw-video"));
  const visible = videos.filter((v) => {
    const r = v.getBoundingClientRect();
    return r.width > 80 && r.height > 60;
  });
  const hasJw = typeof window.jwplayer === "function";
  const score = visible.length * 10 + videos.length * 3 + (hasJw ? 15 : 0);
  return {
    href: location.href,
    videoCount: videos.length,
    visibleCount: visible.length,
    hasJw,
    score
  };
}

/** Runs inside each frame; must stay self-contained (no closure). */
function probeFrameForFullDebug() {
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
          `Video #${v.videoIndex}: ${v.captionLikeShowingCount} subtitle/caption tracks are "showing" at once — lines stack. Keep only one.`
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
          `Video #${v.videoIndex}: stream/built-in subtitles active ("${bundled[0].label || bundled[0].kind}"). External SRT + extension should disable them while yours is showing.`
        );
      }
    }
    return { hints: msgs, perVideo };
  }

  function getJwInfo() {
    const info = { found: false, players: [] };
    if (typeof window.jwplayer !== "function") return info;
    info.found = true;
    const instances = window.jwplayer().getAllPlayers ? window.jwplayer().getAllPlayers() : [];
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

  const videoNodes = Array.from(document.querySelectorAll("video, .jw-video")).map((v, index) => {
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

  return {
    frameHref: location.href,
    iframeElementsOnPage: document.querySelectorAll("iframe").length,
    videoNodeCount: videoNodes.length,
    videoNodes,
    trackDiag: diagnoseDuplicateSubtitles(),
    jw: getJwInfo(),
    mediaScore:
      videoNodes.filter((v) => v.width > 80 && v.height > 60).length * 10 +
      videoNodes.length * 3 +
      (typeof window.jwplayer === "function" ? 15 : 0)
  };
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function buildFullTabDebugHtml(payload) {
  const { reason, tabUrl, timestamp, injectMeta, frames } = payload;

  const ranked = frames
    .map((f) => ({ ...f, score: f.result?.mediaScore ?? 0 }))
    .sort((a, b) => b.score - a.score);

  const best = ranked.find((f) => (f.result?.videoNodeCount || 0) > 0) || ranked[0];
  const anyVideo = frames.some((f) => (f.result?.videoNodeCount || 0) > 0);

  const whereAttach = anyVideo
    ? `The extension injects into one frame (highest media score). Best frame for debug: <strong>frameId ${best?.frameId}</strong> — <code>${escapeHtml(best?.result?.frameHref || "")}</code>. Subtitles attach on <code>&lt;video&gt;</code> in <strong>that</strong> document, not necessarily the tab’s top URL.`
    : `No <code>&lt;video&gt;</code> was found in <strong>any</strong> frame of this tab. Listing sites (e.g. <code>/home</code>) often have no player until you open a play page. Try the watch URL (e.g. <code>play.php?…</code>) with a video playing, then run Debug again.`;

  const body = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Subtitle Sync Debug Report (all frames)</title>
  <style>
    body { font-family: system-ui, sans-serif; padding: 16px; line-height: 1.45; max-width: 960px; margin: 0 auto; }
    pre { background: #111; color: #ddd; padding: 12px; border-radius: 8px; overflow: auto; font-size: 12px; }
    code { background: #f2f2f2; padding: 2px 6px; border-radius: 4px; }
    .callout { background: #fff8e6; border: 1px solid #e6d088; padding: 12px 14px; border-radius: 8px; margin: 12px 0; }
  </style>
</head>
<body>
  <h1>Subtitle Sync Debug Report</h1>
  <p><strong>Reason:</strong> ${escapeHtml(reason)}</p>
  <p><strong>Tab URL (top):</strong> <code>${escapeHtml(tabUrl || "")}</code></p>
  <p><strong>Timestamp:</strong> ${escapeHtml(timestamp)}</p>
  <div class="callout">
    <p><strong>Where subtitles attach:</strong> ${whereAttach}</p>
  </div>
  <h2>Inject-side metadata (frame that hosted the control panel)</h2>
  <pre>${escapeHtml(JSON.stringify(injectMeta || {}, null, 2))}</pre>
  <h2>Frames scanned (${frames.length})</h2>
  <p>Each entry is one document (top page or iframe). The extension picks a target frame when you click the icon; debug below shows every frame so you can see where the player lives.</p>
  <pre>${escapeHtml(JSON.stringify(frames, null, 2))}</pre>
</body>
</html>`;

  return body;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "subtitle-sync-full-debug") return;

  (async () => {
    let tabId = sender.tab?.id;
    let tabUrl = sender.tab?.url || "";
    if (!tabId) {
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const t = tabs[0];
      if (t?.id) {
        tabId = t.id;
        tabUrl = t.url || tabUrl;
      }
    }
    if (!tabId) {
      sendResponse({ error: "Could not resolve tab id for debug report" });
      return;
    }

    try {
      const raw = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: probeFrameForFullDebug
      });

      const frames = (raw || []).map((entry) => ({
        frameId: entry.frameId,
        result: entry.result || null
      }));

      const html = buildFullTabDebugHtml({
        reason: msg.reason || "debug",
        tabUrl,
        timestamp: new Date().toISOString(),
        injectMeta: msg.injectMeta || {},
        frames
      });
      sendResponse({ html });
    } catch (err) {
      sendResponse({ error: String(err?.message || err) });
    }
  })();

  return true;
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;

  let targetFrameId = 0;

  try {
    const probeResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: probeFrameForMedia
    });

    if (Array.isArray(probeResults) && probeResults.length) {
      const best = probeResults
        .filter((r) => r && r.result)
        .sort((a, b) => (b.result.score || 0) - (a.result.score || 0))[0];
      if (best && typeof best.frameId === "number") {
        targetFrameId = best.frameId;
      }
    }
  } catch (err) {
    console.warn("Subtitle Sync: frame probe failed, falling back to top frame.", err);
  }

  await chrome.scripting.executeScript({
    target: { tabId: tab.id, frameIds: [targetFrameId] },
    files: ["inject.js"]
  });
});
