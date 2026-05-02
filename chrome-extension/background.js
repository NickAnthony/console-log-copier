// Background service worker for Console Log Copier.
// Keeps a fast in-memory cache backed by chrome.storage.session.

const MAX_LOGS_PER_TAB = 1000;
const MAX_STRING_LENGTH = 20000;
const MAX_ARRAY_ITEMS = 100;
const MAX_OBJECT_KEYS = 100;
const MAX_STORAGE_BYTES_PER_TAB = 4 * 1024 * 1024;
const MAX_WS_QUEUE = 1000;

const tabLogs = new Map();
const tabLogBytes = new Map();
const tabLogEntryBytes = new Map();
const dirtyTabs = new Set();
const tabUrls = new Map();
const listenerStatus = new Map();

let flushTimer = null;
let ws = null;
let wsReconnectDelay = 1000;
let wsQueue = [];

const WS_URL = 'ws://127.0.0.1:18462';
const WS_MAX_RECONNECT_DELAY = 30000;

// Computes a stable enough byte estimate for bounding session-storage payloads.
function getJsonByteSize(value) {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return MAX_STRING_LENGTH;
  }
}

// Truncates oversized captured values before they can stall popup loading or storage writes.
function boundValue(value, depth = 0) {
  if (typeof value === 'string') {
    if (value.length <= MAX_STRING_LENGTH) return value;
    return `${value.slice(0, MAX_STRING_LENGTH)}... [truncated ${value.length - MAX_STRING_LENGTH} chars]`;
  }
  if (!value || typeof value !== 'object') return value;
  if (depth >= 6) return '[Max Storage Depth Reached]';
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map(item => boundValue(item, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) {
      items.push(`[truncated ${value.length - MAX_ARRAY_ITEMS} items]`);
    }
    return items;
  }
  const result = {};
  const entries = Object.entries(value);
  for (const [key, child] of entries.slice(0, MAX_OBJECT_KEYS)) {
    result[key] = boundValue(child, depth + 1);
  }
  if (entries.length > MAX_OBJECT_KEYS) {
    result.__truncatedKeys__ = entries.length - MAX_OBJECT_KEYS;
  }
  return result;
}

// Builds the short row preview once so the popup does not reserialize every log on open.
function buildPreview(args) {
  const text = (args || []).map(arg => {
    if (typeof arg === 'string') return arg;
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  }).join(' ');
  return text.length > 120 ? `${text.slice(0, 120)}...` : text;
}

// Creates a compact tab signature so the popup can poll cheaply before fetching logs.
function getTabSignature(tabId) {
  const logs = tabLogs.get(tabId) || [];
  if (logs.length === 0) return '0';
  const last = logs[logs.length - 1];
  return [
    logs.length,
    last.timestamp || '',
    last.level || '',
    last.preview || '',
    last.attachId || ''
  ].join('|');
}

// Normalizes one incoming console message into the durable log shape used by UI and MCP.
function buildLogEntry(message, sender) {
  const args = Array.isArray(message.args) ? message.args.map(arg => boundValue(arg)) : [];
  const sourceUrl = message.sourceUrl || sender.url || sender.tab?.url || 'unknown';
  return {
    level: message.level,
    timestamp: message.timestamp || new Date().toISOString(),
    args,
    stack: typeof message.stack === 'string' ? boundValue(message.stack) : null,
    filterCategory: message.filterCategory || null,
    preview: buildPreview(args),
    sourceUrl,
    pageUrl: sender.tab?.url || message.pageUrl || sourceUrl,
    frameId: sender.frameId ?? message.frameId ?? null,
    documentId: sender.documentId || message.documentId || null,
    attachId: message.attachId || null
  };
}

// Restores cached logs from session storage when the service worker wakes up.
const ready = new Promise((resolve) => {
  chrome.storage.session.get(null, (result) => {
    for (const [key, value] of Object.entries(result || {})) {
      if (!key.startsWith('logs_')) continue;
      const tabId = Number(key.slice(5));
      if (!Number.isFinite(tabId)) continue;
      const logs = Array.isArray(value) ? value : [];
      const entrySizes = logs.map(log => getJsonByteSize(log) + 1);
      let bytes = entrySizes.reduce((sum, size) => sum + size, 2);
      while ((logs.length > MAX_LOGS_PER_TAB || bytes > MAX_STORAGE_BYTES_PER_TAB) && logs.length > 0) {
        logs.shift();
        bytes -= entrySizes.shift();
      }
      tabLogs.set(tabId, logs);
      tabLogEntryBytes.set(tabId, entrySizes);
      tabLogBytes.set(tabId, bytes);
    }
    resolve();
  });
});

// Schedules batched storage writes so hot logging does not block each console call.
function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    const updates = {};
    for (const tabId of dirtyTabs) {
      updates[`logs_${tabId}`] = tabLogs.get(tabId) || [];
    }
    dirtyTabs.clear();
    flushTimer = null;
    if (Object.keys(updates).length > 0) {
      chrome.storage.session.set(updates, () => {
        void chrome.runtime.lastError;
      });
    }
  }, 250);
}

// Ensures a tab has an initialized log buffer and byte counter.
function initTab(tabId) {
  if (!tabLogs.has(tabId)) tabLogs.set(tabId, []);
  if (!tabLogEntryBytes.has(tabId)) {
    const entrySizes = tabLogs.get(tabId).map(log => getJsonByteSize(log) + 1);
    tabLogEntryBytes.set(tabId, entrySizes);
    tabLogBytes.set(tabId, entrySizes.reduce((sum, size) => sum + size, 2));
  }
}

// Appends a log while enforcing count and storage-size bounds for popup responsiveness.
function appendLog(tabId, logEntry) {
  initTab(tabId);
  const logs = tabLogs.get(tabId);
  const entrySizes = tabLogEntryBytes.get(tabId);
  let bytes = tabLogBytes.get(tabId) || 2;
  const entryBytes = getJsonByteSize(logEntry) + 1;
  logs.push(logEntry);
  entrySizes.push(entryBytes);
  bytes += entryBytes;
  while ((logs.length > MAX_LOGS_PER_TAB || bytes > MAX_STORAGE_BYTES_PER_TAB) && logs.length > 0) {
    logs.shift();
    bytes -= entrySizes.shift() || 0;
  }
  tabLogBytes.set(tabId, bytes);
  dirtyTabs.add(tabId);
  scheduleFlush();
}

// Queues or sends one MCP bridge message without letting an offline server grow memory forever.
function wsSend(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
    return;
  }
  wsQueue.push(msg);
  if (wsQueue.length > MAX_WS_QUEUE) {
    wsQueue = wsQueue.slice(-MAX_WS_QUEUE);
  }
}

// Opens the MCP WebSocket bridge and resyncs in-memory logs after reconnects.
function wsConnect() {
  try {
    ws = new WebSocket(WS_URL);
  } catch {
    scheduleWsReconnect();
    return;
  }

  ws.onopen = () => {
    wsReconnectDelay = 1000;
    const queued = wsQueue;
    wsQueue = [];
    for (const message of queued) ws.send(JSON.stringify(message));
    ready.then(() => {
      const tabs = {};
      for (const [tabId, logs] of tabLogs) {
        tabs[tabId] = {
          url: tabUrls.get(tabId) || 'unknown',
          title: null,
          logs,
        };
      }
      chrome.tabs.query({}, (allTabs) => {
        for (const tab of allTabs || []) {
          if (!tabs[tab.id]) continue;
          tabs[tab.id].url = tab.url || tabs[tab.id].url;
          tabs[tab.id].title = tab.title || null;
          tabUrls.set(tab.id, tab.url || 'unknown');
        }
        wsSend({ type: 'FULL_SYNC', tabs });
      });
    });
  };

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    handleServerMessage(msg);
  };
  ws.onclose = () => {
    ws = null;
    scheduleWsReconnect();
  };
  ws.onerror = () => {};
}

// Backs off MCP bridge reconnects so an absent server does not burn the worker.
function scheduleWsReconnect() {
  setTimeout(() => {
    wsReconnectDelay = Math.min(wsReconnectDelay * 2, WS_MAX_RECONNECT_DELAY);
    wsConnect();
  }, wsReconnectDelay);
}

// Applies clear commands coming from the MCP server to the extension cache.
function handleServerMessage(msg) {
  if (msg.type === 'CLEAR_LOGS' && msg.tabId) {
    ready.then(() => {
      tabLogs.set(msg.tabId, []);
      tabLogEntryBytes.set(msg.tabId, []);
      tabLogBytes.set(msg.tabId, 2);
      chrome.storage.session.set({ [`logs_${msg.tabId}`]: [] });
    });
  } else if (msg.type === 'CLEAR_ALL_LOGS') {
    ready.then(() => {
      const updates = {};
      for (const tabId of tabLogs.keys()) {
        tabLogs.set(tabId, []);
        tabLogEntryBytes.set(tabId, []);
        tabLogBytes.set(tabId, 2);
        updates[`logs_${tabId}`] = [];
      }
      chrome.storage.session.set(updates);
    });
  }
}

wsConnect();

// Checks whether an URL is safe for this extension to inject into.
function isInjectableUrl(url) {
  return Boolean(url && (
    url.startsWith('http://localhost/') ||
    url.startsWith('http://127.0.0.1/') ||
    /^http:\/\/localhost:\d+\//.test(url) ||
    /^http:\/\/127\.0\.0\.1:\d+\//.test(url)
  ));
}

// Reads frame IDs that match host permissions so repair injection avoids forbidden frames.
function getInjectableFrameIds(tabId) {
  return new Promise((resolve) => {
    chrome.webNavigation.getAllFrames({ tabId }, (frames) => {
      if (chrome.runtime.lastError || !Array.isArray(frames)) {
        resolve([0]);
        return;
      }
      const frameIds = frames
        .filter(frame => isInjectableUrl(frame.url))
        .map(frame => frame.frameId);
      resolve(frameIds.length > 0 ? frameIds : [0]);
    });
  });
}

// Executes one extension file across injectable frames as part of listener repair.
function executeScriptFile(tabId, frameIds, file, world) {
  return new Promise((resolve) => {
    chrome.scripting.executeScript({
      target: { tabId, frameIds },
      files: [file],
      world
    }, (results) => {
      resolve({
        ok: !chrome.runtime.lastError,
        error: chrome.runtime.lastError?.message || null,
        results: results || []
      });
    });
  });
}

// Reinstalls both bridge halves so a popup repair click can recover stale page state.
async function reattachListener(tabId) {
  const frameIds = await getInjectableFrameIds(tabId);
  const contentResult = await executeScriptFile(tabId, frameIds, 'content.js', 'ISOLATED');
  const injectResult = await executeScriptFile(tabId, frameIds, 'inject.js', 'MAIN');
  const ok = contentResult.ok && injectResult.ok;
  if (!ok) {
    listenerStatus.set(tabId, {
      status: 'repair-failed',
      reason: contentResult.error || injectResult.error,
      timestamp: new Date().toISOString(),
      attachId: null
    });
  }
  return {
    success: ok,
    frameIds,
    error: contentResult.error || injectResult.error || null
  };
}

// Records status heartbeats sent by the page-world listener.
function updateListenerStatus(tabId, message) {
  listenerStatus.set(tabId, {
    status: message.status || 'unknown',
    reason: message.reason || null,
    timestamp: message.timestamp || new Date().toISOString(),
    sourceUrl: message.sourceUrl || tabUrls.get(tabId) || null,
    pageUrl: message.pageUrl || tabUrls.get(tabId) || null,
    attachId: message.attachId || null
  });
}

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  if (!isInjectableUrl(details.url)) return;
  const tabId = details.tabId;
  tabUrls.set(tabId, details.url);
  chrome.tabs.get(tabId, (tab) => {
    const title = chrome.runtime.lastError ? null : (tab?.title || null);
    wsSend({ type: 'NEW_SESSION', tabId, url: details.url, title });
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabLogs.delete(tabId);
  tabLogBytes.delete(tabId);
  tabLogEntryBytes.delete(tabId);
  tabUrls.delete(tabId);
  listenerStatus.delete(tabId);
  chrome.storage.session.remove(`logs_${tabId}`);
  wsSend({ type: 'TAB_CLOSED', tabId });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const senderTabId = sender.tab?.id;

  if (message.type === 'CONSOLE_LOG') {
    if (Number.isInteger(senderTabId)) {
      ready.then(() => {
        const logEntry = buildLogEntry(message, sender);
        tabUrls.set(senderTabId, logEntry.pageUrl || logEntry.sourceUrl);
        appendLog(senderTabId, logEntry);
        wsSend({ type: 'LOG', tabId: senderTabId, log: logEntry });
      });
    }
    sendResponse({ success: true });
    return;
  }

  if (message.type === 'LISTENER_STATUS') {
    if (Number.isInteger(senderTabId)) {
      updateListenerStatus(senderTabId, message);
    }
    sendResponse({ success: true });
    return;
  }

  if (message.type === 'GET_LOGS') {
    ready.then(() => {
      sendResponse({ logs: tabLogs.get(message.tabId) || [] });
    });
    return true;
  }

  if (message.type === 'GET_LISTENER_STATUS') {
    ready.then(() => {
      sendResponse({
        status: listenerStatus.get(message.tabId) || null,
        logCount: (tabLogs.get(message.tabId) || []).length,
        storageBytes: tabLogBytes.get(message.tabId) || 0,
        signature: getTabSignature(message.tabId)
      });
    });
    return true;
  }

  if (message.type === 'REATTACH_LISTENER') {
    reattachListener(message.tabId).then((result) => {
      sendResponse(result);
    });
    return true;
  }

  if (message.type === 'CLEAR_LOGS') {
    ready.then(() => {
      tabLogs.set(message.tabId, []);
      tabLogEntryBytes.set(message.tabId, []);
      tabLogBytes.set(message.tabId, 2);
      chrome.storage.session.set({ [`logs_${message.tabId}`]: [] }, () => {
        sendResponse({ success: !chrome.runtime.lastError });
      });
      wsSend({ type: 'LOGS_CLEARED', tabId: message.tabId });
    });
    return true;
  }
});
