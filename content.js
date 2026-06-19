(() => {
if (globalThis.__homoPartyContentLoaded) {
  console.info("[Homo Party] Content script is already running.", location.href);
  return;
}
globalThis.__homoPartyContentLoaded = true;

let session = null;
let video = null;
let suppressUntil = 0;
let lastRevision = 0;
let pollTimer = null;
let videoObserver = null;
let scanCount = 0;
let lastScan = null;
let advancingQueue = false;
const sourceId = crypto.randomUUID();
const SYNC_INTERVAL_MS = 3000;
const QUEUE_ADVANCE_SETTLE_MS = 12_000;
const QUEUE_ADVANCE_STORAGE_KEY = "queueAdvancePending";

function log(message, details) {
  if (details === undefined) console.info(`[Homo Party] ${message}`);
  else console.info(`[Homo Party] ${message}`, details);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function mediaKeyForUrl(value) {
  try {
    const url = new URL(value);
    if (url.hostname === "youtu.be") return `youtube:${url.pathname.slice(1) || url.pathname}`;
    if (url.hostname.includes("youtube.com")) return `youtube:${url.searchParams.get("v") || url.pathname}`;
    if (url.hostname.includes("nicovideo.jp")) return `nicovideo:${url.pathname}`;
    if (url.hostname.includes("amazon.") || url.hostname.includes("primevideo.com")) return `primevideo:${url.pathname}`;
    return "";
  } catch {
    return "";
  }
}

function pageUrl() {
  if (window !== window.top && mediaKeyForUrl(document.referrer) === mediaKeyForUrl(location.href)) {
    return document.referrer;
  }
  return location.href;
}

function mediaKey() {
  return mediaKeyForUrl(pageUrl());
}

function localState(options = {}) {
  return {
    mediaKey: mediaKey(),
    title: document.title.slice(0, 500),
    url: pageUrl().slice(0, 2000),
    currentTime: video?.currentTime || 0,
    paused: video?.paused ?? true,
    playbackRate: video?.playbackRate || 1,
    sourceId,
    ...(options.activateSource ? { activateSource: true } : {}),
  };
}

function diagnostics() {
  return {
    contentScriptLoaded: true,
    href: location.href,
    pageUrl: pageUrl(),
    hostname: location.hostname,
    readyState: document.readyState,
    mediaKey: mediaKey(),
    isTopFrame: window === window.top,
    scanCount,
    lastScan,
    selectedVideo: video ? {
      currentTime: video.currentTime,
      paused: video.paused,
      readyState: video.readyState,
      networkState: video.networkState,
      width: video.offsetWidth,
      height: video.offsetHeight,
      currentSrc: video.currentSrc?.slice(0, 300) || "",
    } : null,
  };
}

async function send(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    log(`Background message failed: ${message.type}`, errorMessage(error));
    return null;
  }
}

async function queueAdvancePending() {
  const stored = await chrome.storage.local.get(QUEUE_ADVANCE_STORAGE_KEY).catch(() => ({}));
  const pending = stored[QUEUE_ADVANCE_STORAGE_KEY];
  if (!pending || pending.roomId !== session?.roomId || pending.until <= Date.now()) {
    if (pending) await chrome.storage.local.remove(QUEUE_ADVANCE_STORAGE_KEY).catch(() => null);
    return null;
  }
  return pending;
}

async function reportState() {
  if (!session?.isHost || !video || Date.now() < suppressUntil) return;
  const pending = await queueAdvancePending();
  if (pending) {
    if (pending.mediaKey !== mediaKey() || video.readyState < HTMLMediaElement.HAVE_METADATA) return;
    if (Date.now() < pending.until && video.paused) return;
    await chrome.storage.local.remove(QUEUE_ADVANCE_STORAGE_KEY).catch(() => null);
    return send({ type: "UPDATE_STATE", state: localState({ activateSource: true }) });
  }
  return send({ type: "UPDATE_STATE", state: localState() });
}

function timestampMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function isNiconico() {
  return location.hostname.includes("nicovideo.jp");
}

function notifyNiconicoPlayerTime() {
  if (!video || !isNiconico()) return;
  video.dispatchEvent(new Event("timeupdate"));
}

function waitForSeeked(targetVideo) {
  return new Promise((resolve) => {
    let timeoutId;
    const finish = () => {
      clearTimeout(timeoutId);
      targetVideo.removeEventListener("seeked", finish);
      resolve();
    };
    targetVideo.addEventListener("seeked", finish, { once: true });
    timeoutId = setTimeout(finish, 1500);
  });
}

async function seekVideo(time) {
  if (!video) return;
  if (!isNiconico()) {
    video.currentTime = time;
    return;
  }

  // NicoNico's controls and comments keep their own playback clock. Waiting
  // for the native seek completion makes them reset that clock on every seek.
  const soughtVideo = video;
  if (!soughtVideo.paused) soughtVideo.pause();
  const seeked = waitForSeeked(soughtVideo);
  soughtVideo.currentTime = time;
  await seeked;
  if (video === soughtVideo) notifyNiconicoPlayerTime();
}

function followHostVideo(state) {
  const targetUrl = state.videoUrl || state.url;
  if (!targetUrl || mediaKeyForUrl(targetUrl) !== state.mediaKey) return false;
  location.assign(targetUrl);
  return true;
}

async function applyState(state, serverNow = Date.now()) {
  if (state.revision <= lastRevision) return;
  if (state.mediaKey !== mediaKey()) {
    followHostVideo(state);
    return;
  }
  findVideo();
  if (!video) return;
  lastRevision = state.revision;
  suppressUntil = Date.now() + 1200;

  const elapsedSeconds = Math.max(0, (serverNow - timestampMs(state.updatedAt)) / 1000);
  const projectedTime = state.paused
    ? state.currentTime
    : state.currentTime + elapsedSeconds * state.playbackRate;
  if (Math.abs(video.currentTime - projectedTime) > 1.2) await seekVideo(projectedTime);
  else notifyNiconicoPlayerTime();
  if (Math.abs(video.playbackRate - state.playbackRate) > 0.01) video.playbackRate = state.playbackRate;

  if (state.paused && !video.paused) video.pause();
  if (!state.paused && video.paused) {
    try {
      await video.play();
    } catch {
      // Browsers may require one user gesture before programmatic playback.
    }
  }
}

async function poll() {
  if (!session || session.isHost || !video) return;
  const result = await send({ type: "POLL" });
  if (result?.state) applyState(result.state, result.serverNow);
}

async function sync() {
  findVideo();
  if (!session || !video) return;
  if (session.isHost) await reportState();
  else await poll();
}

async function playNextQueuedVideo() {
  if (!session?.isHost || advancingQueue) return;
  advancingQueue = true;
  suppressUntil = Date.now() + 3000;
  try {
    const result = await send({ type: "ADVANCE_QUEUE" });
    if (result?.state?.videoUrl) {
      suppressUntil = Date.now() + QUEUE_ADVANCE_SETTLE_MS;
      await chrome.storage.local.set({
        [QUEUE_ADVANCE_STORAGE_KEY]: {
          roomId: session.roomId,
          mediaKey: result.state.mediaKey,
          videoUrl: result.state.videoUrl,
          until: Date.now() + QUEUE_ADVANCE_SETTLE_MS,
        },
      }).catch(() => null);
      followHostVideo(result.state);
    }
  } finally {
    setTimeout(() => {
      advancingQueue = false;
    }, QUEUE_ADVANCE_SETTLE_MS);
  }
}

function bindVideo(nextVideo) {
  if (video === nextVideo) return;
  if (video) video.removeEventListener("ended", playNextQueuedVideo);
  video = nextVideo;
  if (video) video.addEventListener("ended", playNextQueuedVideo);
  log(video ? "Video element selected." : "Video element not found.", diagnostics());
}

function findVideo() {
  const videos = [];
  let shadowRootCount = 0;
  const visit = (root) => {
    try {
      videos.push(...root.querySelectorAll("video"));
      root.querySelectorAll("*").forEach((element) => {
        let shadowRoot = null;
        try {
          shadowRoot = element.shadowRoot;
        } catch {
          return;
        }
        if (!shadowRoot) return;
        shadowRootCount += 1;
        visit(shadowRoot);
      });
    } catch (error) {
      log("Skipping inaccessible video scan root.", errorMessage(error));
    }
  };
  try {
    visit(document);
  } catch (error) {
    log("Video scan failed.", errorMessage(error));
  }
  scanCount += 1;
  lastScan = {
    at: new Date().toISOString(),
    videoCount: videos.length,
    iframeCount: document.querySelectorAll("iframe").length,
    iframeSources: [...document.querySelectorAll("iframe")].slice(0, 10)
      .map((iframe) => iframe.src?.slice(0, 300) || ""),
    shadowRootCount,
    candidates: videos.slice(0, 10).map((item) => ({
      width: item.offsetWidth,
      height: item.offsetHeight,
      readyState: item.readyState,
      networkState: item.networkState,
      currentSrc: item.currentSrc?.slice(0, 300) || "",
    })),
  };
  const candidate = videos.find((item) => item.offsetWidth > 300) || videos[0] || null;
  bindVideo(candidate);
  return candidate;
}

function start() {
  findVideo();
  videoObserver ??= new MutationObserver(findVideo);
  videoObserver.observe(document.documentElement, { childList: true, subtree: true });
  clearInterval(pollTimer);
  pollTimer = setInterval(sync, SYNC_INTERVAL_MS);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "SESSION_CHANGED") {
    session = message.session;
    lastRevision = 0;
  }
  if (message.type === "ROOM_UPDATED" && message.state && !session?.isHost) {
    applyState(message.state, message.serverNow);
  }
  if (message.type === "GET_LOCAL_STATE") {
    findVideo();
    sendResponse({ state: localState(), supported: Boolean(video), diagnostics: diagnostics() });
  }
  if (message.type === "GET_DIAGNOSTICS") {
    findVideo();
    sendResponse({ diagnostics: diagnostics() });
  }
});

send({ type: "GET_SESSION" }).then((result) => {
  session = result?.session || null;
  start();
  log("Content script started.", diagnostics());
});
})();
