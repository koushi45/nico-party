const $ = (selector) => document.querySelector(selector);
let localState = null;
let session = null;
let roomDetails = null;
let syncTab = null;
let activeTabId = null;
let activeTabUrl = "";
const diagnosticEntries = [];

function diagnostic(step, details) {
  diagnosticEntries.push({
    at: new Date().toISOString(),
    step,
    details: details instanceof Error ? details.message : details,
  });
  console.info(`[Homo Party] ${step}`, details ?? "");
  $("#diagnosticLog").textContent = JSON.stringify(diagnosticEntries, null, 2);
}

function isBlockedError(error) {
  return String(error?.message || error).toLowerCase().includes("blocked");
}

function requiredOrigin(urlValue) {
  try {
    const url = new URL(urlValue);
    if (url.hostname.endsWith("nicovideo.jp")) return "https://*.nicovideo.jp/*";
    return `${url.origin}/*`;
  } catch {
    return "";
  }
}

function isNiconicoUrl(urlValue) {
  try {
    return new URL(urlValue).hostname.endsWith("nicovideo.jp");
  } catch {
    return false;
  }
}

async function message(payload) {
  const result = await chrome.runtime.sendMessage(payload);
  if (result?.error) {
    const error = new Error(result.error);
    error.status = result.status;
    throw error;
  }
  return result;
}

function setStatus(text = "") {
  $("#status").textContent = text;
}

function compareVersions(current, latest) {
  const currentParts = String(current || "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const latestParts = String(latest || "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(currentParts.length, latestParts.length);
  for (let index = 0; index < length; index += 1) {
    const currentPart = currentParts[index] || 0;
    const latestPart = latestParts[index] || 0;
    if (currentPart < latestPart) return -1;
    if (currentPart > latestPart) return 1;
  }
  return 0;
}

async function renderVersionFooter() {
  const currentVersion = chrome.runtime.getManifest().version;
  $("#extensionVersion").textContent = `Homo Party v${currentVersion}`;
  try {
    const { latestVersion } = await message({ type: "GET_VERSION" });
    if (latestVersion && compareVersions(currentVersion, latestVersion) < 0) {
      $("#versionNotice").textContent = `バージョンが古いです（最新版 v${latestVersion}）`;
      $("#versionNotice").hidden = false;
    } else {
      $("#versionNotice").hidden = true;
    }
  } catch (error) {
    diagnostic("バージョン情報の取得に失敗", error);
  }
}

function showTab(name) {
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === name));
  $("#roomsPanel").hidden = name !== "rooms";
  $("#currentPanel").hidden = name !== "current";
  $("#queuePanel").hidden = name !== "queue";
}

function videoUrl(room) {
  const value = room?.url || room?.videoUrl || "";
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
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

function queueVideoFromUrl(value) {
  const url = String(value || "").trim();
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    return { videoUrl: parsed.href, url: parsed.href, mediaKey: mediaKeyForUrl(parsed.href), title: parsed.href };
  } catch {
    return null;
  }
}

function queueVideoFromState(state) {
  const url = state?.url || state?.videoUrl;
  if (!url) return null;
  return {
    videoUrl: url,
    url,
    mediaKey: state.mediaKey || mediaKeyForUrl(url),
    title: state.title || url,
  };
}

function renderRooms(rooms) {
  $("#noRooms").hidden = rooms.length > 0;
  $("#rooms").replaceChildren(...rooms.map((room) => {
    const item = document.createElement("article");
    item.className = `room${room.id === session?.roomId ? " current" : ""}`;
    const info = document.createElement("div");
    const id = document.createElement("strong");
    id.className = "room-id";
    id.textContent = room.id;
    const title = document.createElement("p");
    title.className = "video-title";
    title.title = room.title || "動画タイトルなし";
    title.textContent = room.title || "動画タイトルなし";
    info.append(id, title);
    const join = document.createElement("button");
    join.textContent = room.id === session?.roomId ? "接続中" : "接続";
    join.disabled = room.id === session?.roomId;
    join.addEventListener("click", () => joinRoom(room.id));
    item.append(info, join);
    return item;
  }));
}

function renderQueue(room) {
  const queue = room?.queue || [];
  $("#queueRoomCard").hidden = !room;
  $("#queueNotConnected").hidden = Boolean(room);
  $("#emptyQueue").hidden = queue.length > 0;
  $("#queue").replaceChildren(...queue.map((item, index) => {
    const row = document.createElement("div");
    row.className = "queue-item";

    const main = document.createElement("div");
    main.className = "queue-main";
    const title = document.createElement("div");
    title.className = "queue-title";
    title.textContent = item.title || item.videoUrl || "動画タイトルなし";
    title.title = title.textContent;
    const meta = document.createElement("div");
    meta.className = "queue-meta";
    meta.textContent = `追加: ${item.addedBy?.accountName || "不明"}`;
    main.append(title, meta);

    const controls = document.createElement("div");
    controls.className = "queue-controls";
    if (room.isHost) {
      const up = document.createElement("button");
      up.textContent = "↑";
      up.title = "上へ";
      up.disabled = index === 0;
      up.addEventListener("click", () => moveQueueItem(index, -1));
      const down = document.createElement("button");
      down.textContent = "↓";
      down.title = "下へ";
      down.disabled = index === queue.length - 1;
      down.addEventListener("click", () => moveQueueItem(index, 1));
      controls.append(up, down);
    }
    if (item.canDelete) {
      const remove = document.createElement("button");
      remove.className = "danger-small";
      remove.textContent = "×";
      remove.title = "削除";
      remove.addEventListener("click", () => deleteQueueItem(item.id));
      controls.append(remove);
    }

    row.append(main, controls);
    return row;
  }));
}

function renderSyncTab() {
  const current = activeTabId && syncTab?.id === activeTabId;
  $("#syncTabInfo").textContent = syncTab
    ? `${syncTab.title || "タイトルなし"}${current ? "（現在のタブ）" : ""}`
    : "同期タブが設定されていません。";
  $("#syncTabInfo").title = syncTab?.url || "";
  $("#syncThisTab").disabled = !activeTabId || current;
}

function renderCurrent(room) {
  roomDetails = room;
  const connected = Boolean(room);
  $("#connectedDot").textContent = connected ? " " : "";
  $("#notConnected").hidden = connected;
  $("#currentRoomCard").hidden = !connected;
  if (!room) {
    renderQueue(null);
    renderSyncTab();
    return;
  }

  $("#currentRoom").textContent = room.id;
  $("#currentTitle").textContent = room.title || "動画タイトルなし";
  $("#currentTitle").title = room.title || "";
  const url = videoUrl(room);
  $("#currentUrl").hidden = !url;
  $("#currentUrl").textContent = url;
  $("#currentUrl").title = url;
  $("#currentUrl").href = url || "#";
  $("#deleteRoom").hidden = !room.isHost;
  renderQueue(room);
  renderSyncTab();
  $("#participants").replaceChildren(...room.participants.map((participant) => {
    const item = document.createElement("div");
    item.className = "participant";
    const name = document.createElement("span");
    name.className = "participant-name";
    name.textContent = participant.accountName;
    if (participant.isHost) {
      const badge = document.createElement("span");
      badge.className = "host-badge";
      badge.textContent = "ホスト";
      name.append(badge);
    }
    item.append(name);
    if (room.isHost && !participant.isHost) {
      const transfer = document.createElement("button");
      transfer.className = "transfer";
      transfer.textContent = "ホスト交代";
      transfer.addEventListener("click", () => transferHost(participant.userId));
      item.append(transfer);
    }
    return item;
  }));
}

async function refresh() {
  try {
    const result = await message({ type: "LIST_ROOMS" });
    session = result.session;
    syncTab = result.syncTab || null;
    $("#loginRequired").hidden = true;
    $("#app").hidden = false;
    $("#account").textContent = result.user.accountName;
    renderRooms(result.rooms);
    renderCurrent(result.currentRoom);
  } catch (error) {
    if (error.status === 401) {
      $("#loginRequired").hidden = false;
      $("#app").hidden = true;
      return;
    }
    setStatus(error.message);
  }
}

async function joinRoom(roomId) {
  try {
    setStatus("接続中...");
    const syncTabId = localState?.mediaKey ? activeTabId : null;
    const result = await message({ type: "JOIN_ROOM", roomId, syncTabId });
    session = result.session;
    syncTab = syncTabId ? { id: syncTabId, title: localState?.title || activeTabUrl, url: activeTabUrl } : null;
    renderCurrent(result.room);
    showTab("current");
    setStatus(result.state.mediaKey === localState?.mediaKey
      ? "同期を開始しました。"
      : "接続しました。同じ動画を開くと同期します。");
    await refresh();
  } catch (error) {
    setStatus(error.message);
  }
}

async function transferHost(userId) {
  try {
    renderCurrent((await message({ type: "TRANSFER_HOST", userId })).room);
    setStatus("ホストを交代しました。");
  } catch (error) {
    setStatus(error.message);
  }
}

async function syncThisTab() {
  try {
    if (!activeTabId) return;
    const page = await getActivePage(activeTabId);
    if (!page?.supported) {
      setStatus("このタブでは動画を検出できません。");
      return;
    }
    localState = page.state;
    const result = await message({ type: "SET_SYNC_TAB", tabId: activeTabId });
    session = result.session;
    syncTab = result.syncTab || { id: activeTabId, title: localState?.title || activeTabUrl, url: activeTabUrl };
    renderCurrent(roomDetails);
    setStatus("このタブを同期対象にしました。");
  } catch (error) {
    setStatus(error.message || String(error));
  }
}

async function addQueueItem(item) {
  if (!item) {
    setStatus("追加できる動画URLではありません。");
    return;
  }
  try {
    setStatus("キューに追加しています...");
    const result = await message({ type: "ADD_QUEUE_ITEM", item });
    renderCurrent(result.room);
    setStatus("キューに追加しました。");
  } catch (error) {
    setStatus(error.message);
  }
}

async function addCurrentToQueue() {
  try {
    if (activeTabId) {
      const page = await getActivePage(activeTabId);
      if (page?.supported) localState = page.state;
    }
    await addQueueItem(queueVideoFromState(localState));
  } catch (error) {
    setStatus(error.message || String(error));
  }
}

async function addUrlToQueue() {
  const input = $("#queueUrl");
  const item = queueVideoFromUrl(input.value);
  await addQueueItem(item);
  if (item) input.value = "";
}

async function deleteQueueItem(itemId) {
  try {
    setStatus("キューから削除しています...");
    const result = await message({ type: "DELETE_QUEUE_ITEM", itemId });
    renderCurrent(result.room);
    setStatus("キューから削除しました。");
  } catch (error) {
    setStatus(error.message);
  }
}

async function moveQueueItem(index, delta) {
  if (!roomDetails?.isHost) return;
  const queue = [...(roomDetails.queue || [])];
  const nextIndex = index + delta;
  if (nextIndex < 0 || nextIndex >= queue.length) return;
  [queue[index], queue[nextIndex]] = [queue[nextIndex], queue[index]];
  try {
    const result = await message({ type: "REORDER_QUEUE", queueIds: queue.map((item) => item.id) });
    renderCurrent(result.room);
    setStatus("キューを並び替えました。");
  } catch (error) {
    setStatus(error.message);
  }
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function requestLocalState(tabId, attempts = 6, frameId = 0) {
  let page;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    page = await chrome.tabs.sendMessage(
      tabId,
      { type: "GET_LOCAL_STATE" },
      { frameId },
    );
    if (page?.supported) return page;
    if (attempt < attempts) await wait(350);
  }
  diagnostic(`動画を検出できませんでした（${attempts}回スキャン）`, page?.diagnostics);
  return page;
}

async function findVideoFrame(tabId) {
  const frames = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => {
      const videos = [];
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
            if (shadowRoot) visit(shadowRoot);
          });
        } catch {
          // Some YouTube internals expose transient or inaccessible roots.
        }
      };
      visit(document);
      return {
        href: location.href,
        referrer: document.referrer,
        videoCount: videos.length,
        largestVideoWidth: Math.max(0, ...videos.map((item) => item.offsetWidth)),
      };
    },
  });
  diagnostic("全フレームの動画診断", frames);
  return frames
    .filter((frame) => frame.result?.videoCount > 0)
    .sort((left, right) => right.result.largestVideoWidth - left.result.largestVideoWidth)[0];
}

async function getActivePage(tabId) {
  if (!tabId) throw new Error("アクティブなタブIDを取得できませんでした。");
  try {
    let page = await requestLocalState(tabId);
    diagnostic("既存コンテンツスクリプトとの通信に成功", page?.diagnostics);
    if (!page?.supported) {
      const videoFrame = await findVideoFrame(tabId);
      if (videoFrame) {
        page = await requestLocalState(tabId, 6, videoFrame.frameId);
        diagnostic(`動画フレームとの通信に成功（frameId: ${videoFrame.frameId}）`, page?.diagnostics);
      }
    }
    return page;
  } catch (error) {
    diagnostic("既存コンテンツスクリプトとの通信に失敗", error);
    try {
      const injection = await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      diagnostic("コンテンツスクリプトを再注入", injection);
    } catch (injectionError) {
      diagnostic("コンテンツスクリプトの再注入に失敗", injectionError);
      throw injectionError;
    }
    let page = await requestLocalState(tabId);
    if (!page?.supported) {
      const videoFrame = await findVideoFrame(tabId);
      if (videoFrame) {
        if (videoFrame.frameId !== 0) {
          await chrome.scripting.executeScript({
            target: { tabId, frameIds: [videoFrame.frameId] },
            files: ["content.js"],
          });
        }
        page = await requestLocalState(tabId, 6, videoFrame.frameId);
      }
    }
    diagnostic("再注入後の通信に成功", page?.diagnostics);
    return page;
  }
}

async function init() {
  await renderVersionFooter();
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  activeTabId = tab?.id || null;
  activeTabUrl = tab?.url || "";
  const origin = requiredOrigin(activeTabUrl);
  const hasAccess = origin
    ? await chrome.permissions.contains({ origins: [origin] }).catch(() => false)
    : false;
  $("#grantAccess").hidden = !isNiconicoUrl(activeTabUrl) || hasAccess;
  diagnostic("アクティブタブを取得", {
    id: tab?.id,
    url: tab?.url,
    status: tab?.status,
    requiredOrigin: origin,
    hasAccess,
  });
  try {
    const page = await getActivePage(tab?.id);
    localState = page.state;
    $("#site").textContent = page.supported ? page.state.title : "このページでは動画を検出できません。";
    $("#create").disabled = !page.supported;
  } catch (error) {
    diagnostic("動画ページの初期化に失敗", error);
    $("#diagnostics").open = true;
    if (isBlockedError(error)) {
      $("#site").textContent = "ブラウザがニコニコ動画へのアクセスをブロックしています。";
      $("#grantAccess").hidden = false;
    } else {
      $("#site").textContent = "対応動画ページを開いてください。";
    }
    $("#create").disabled = true;
  }
  await refresh();
}

document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => showTab(tab.dataset.tab)));
$("#refresh").addEventListener("click", refresh);
$("#syncThisTab").addEventListener("click", syncThisTab);
$("#addCurrentToQueue").addEventListener("click", addCurrentToQueue);
$("#addUrlToQueue").addEventListener("click", addUrlToQueue);
$("#queueUrl").addEventListener("keydown", (event) => {
  if (event.key === "Enter") addUrlToQueue();
});
$("#grantAccess").addEventListener("click", async () => {
  const origin = requiredOrigin(activeTabUrl);
  if (!origin || !activeTabId) return;
  try {
    diagnostic("サイトアクセス権限を要求", origin);
    const granted = await chrome.permissions.request({ origins: [origin] });
    diagnostic("サイトアクセス権限の要求結果", { origin, granted });
    if (!granted) {
      setStatus("ニコニコ動画へのアクセスが許可されませんでした。");
      return;
    }
    $("#grantAccess").hidden = true;
    setStatus("アクセスを許可しました。動画を再検出しています...");
    const page = await getActivePage(activeTabId);
    localState = page.state;
    $("#site").textContent = page.supported ? page.state.title : "このページでは動画を検出できません。";
    $("#create").disabled = !page.supported;
    setStatus(page.supported ? "ニコニコ動画を認識しました。" : "アクセス許可後も動画を検出できませんでした。");
  } catch (error) {
    diagnostic("サイトアクセス許可後の再検出に失敗", error);
    setStatus(error.message || String(error));
  }
});
$("#currentUrl").addEventListener("click", async (event) => {
  event.preventDefault();
  const url = videoUrl(roomDetails);
  if (!activeTabId || !url) return;
  await chrome.tabs.update(activeTabId, { url });
  window.close();
});
$("#openLogin").addEventListener("click", async () => {
  try {
    const pairing = await message({ type: "START_PAIRING" });
    $("#pairingCode").textContent = pairing.pairingCode;
    $("#checkPairing").hidden = false;
    $("#openLogin").textContent = "新しい連携コードを発行";
    await chrome.tabs.create({ url: `https://rimworld-inm.duckdns.org/homo-party?code=${pairing.pairingCode}` });
  } catch (error) {
    setStatus(error.message);
  }
});
$("#checkPairing").addEventListener("click", refresh);
$("#create").addEventListener("click", async () => {
  try {
    setStatus("ルームを作成中...");
    const result = await message({ type: "CREATE_ROOM", state: localState, syncTabId: activeTabId });
    session = result.session;
    syncTab = activeTabId ? { id: activeTabId, title: localState?.title || activeTabUrl, url: activeTabUrl } : null;
    renderCurrent(result.room);
    showTab("current");
    setStatus("ルームを作成しました。");
    await refresh();
  } catch (error) {
    setStatus(error.message);
  }
});
$("#leave").addEventListener("click", async () => {
  try {
    await message({ type: "LEAVE_ROOM" });
    session = null;
    syncTab = null;
    renderCurrent(null);
    setStatus("ルームから退出しました。");
    await refresh();
  } catch (error) {
    setStatus(error.message);
  }
});
$("#deleteRoom").addEventListener("click", async () => {
  if (!roomDetails || !confirm("このルームを削除しますか？")) return;
  try {
    await message({ type: "DELETE_ROOM" });
    session = null;
    syncTab = null;
    renderCurrent(null);
    showTab("rooms");
    setStatus("ルームを削除しました。");
    await refresh();
  } catch (error) {
    setStatus(error.message);
  }
});

init();
