// Background service worker for Console Log Copier
// Uses in-memory Map backed by chrome.storage.session so logs
// survive service worker restarts.

const tabLogs = new Map();
const tabLogSizes = new Map();
let dirtyTabs = new Set();
let flushTimer = null;
const MAX_LOG_ENTRIES = 1000;
const MAX_STORED_LOG_BYTES = 5 * 1024 * 1024;
const MAX_SINGLE_LOG_BYTES = 256 * 1024;
const MAX_STACK_CHARS = 20000;
const MAX_PREVIEW_CHARS = 120;

// Measures stored payload size so session storage failures are prevented before Chrome drops writes.
function getStoredSize(value) {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return MAX_SINGLE_LOG_BYTES + 1;
  }
}

// Tracks approximate per-tab storage size without re-stringifying every log on each append.
function getTabLogSize(tabId) {
  if (!tabLogSizes.has(tabId)) {
    tabLogSizes.set(tabId, getStoredSize(tabLogs.get(tabId) || []));
  }
  return tabLogSizes.get(tabId);
}

// Keeps huge objects useful for copying while making each captured entry safe to persist and send.
function shrinkValue(value, maxChars) {
  if (typeof value === 'string') {
    return value.length > maxChars ? `${value.slice(0, maxChars)}\n[truncated]` : value;
  }

  try {
    const text = JSON.stringify(value);
    if (text.length <= maxChars) return value;
    return `${text.slice(0, maxChars)}\n[truncated]`;
  } catch {
    const text = String(value);
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n[truncated]` : text;
  }
}

// Precomputes the collapsed row text so opening the popup does not serialize every log again.
function createPreview(args) {
  const preview = args.map((arg) => {
    if (typeof arg === 'string') return arg;

    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  }).join(' ');

  return preview.length > MAX_PREVIEW_CHARS ? `${preview.slice(0, MAX_PREVIEW_CHARS)}...` : preview;
}

// Normalizes incoming logs once so all later popup and storage work has a bounded payload.
function createStoredLog(message) {
  const log = {
    level: message.level,
    timestamp: message.timestamp,
    args: Array.isArray(message.args) ? message.args : [],
    stack: typeof message.stack === 'string' ? shrinkValue(message.stack, MAX_STACK_CHARS) : message.stack,
    filterCategory: message.filterCategory || null
  };
  log.preview = createPreview(log.args);

  let size = getStoredSize(log);
  if (size <= MAX_SINGLE_LOG_BYTES) return log;

  const args = log.args.map((arg) => shrinkValue(arg, Math.max(2000, Math.floor(MAX_SINGLE_LOG_BYTES / Math.max(log.args.length, 1)))));
  const compactLog = { ...log, args };
  compactLog.preview = createPreview(compactLog.args);
  size = getStoredSize(compactLog);
  if (size <= MAX_SINGLE_LOG_BYTES) return compactLog;

  const truncatedArg = `${JSON.stringify(args).slice(0, MAX_SINGLE_LOG_BYTES)}\n[truncated]`;
  return {
    ...compactLog,
    args: [truncatedArg],
    preview: createPreview([truncatedArg])
  };
}

// Trims oldest entries until the tab payload fits Chrome's session storage budget.
function trimTabLogs(tabId) {
  const logs = tabLogs.get(tabId) || [];
  let size = getTabLogSize(tabId);

  while (logs.length > MAX_LOG_ENTRIES) {
    size -= getStoredSize(logs.shift()) + 1;
  }
  while (logs.length > 0 && size > MAX_STORED_LOG_BYTES) {
    size -= getStoredSize(logs.shift()) + 1;
  }

  tabLogSizes.set(tabId, Math.max(2, size));
}

// Track current URL per tab for MCP session management
const tabUrls = new Map();

// Restore logs from session storage when the service worker wakes up
const ready = new Promise((resolve) => {
  chrome.storage.session.get(null, (result) => {
    for (const [key, value] of Object.entries(result || {})) {
      if (key.startsWith('logs_')) {
        const tabId = parseInt(key.slice(5));
        tabLogs.set(tabId, value);
        tabLogSizes.set(tabId, getStoredSize(value));
      }
    }
    resolve();
  });
});

// Flush dirty tabs to session storage (batched for performance)
function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    const flushedTabs = Array.from(dirtyTabs);
    const updates = {};
    for (const tabId of flushedTabs) {
      trimTabLogs(tabId);
      updates[`logs_${tabId}`] = tabLogs.get(tabId) || [];
    }
    dirtyTabs.clear();
    flushTimer = null;
    chrome.storage.session.set(updates, () => {
      if (!chrome.runtime.lastError) return;

      for (const tabId of flushedTabs) {
        const logs = tabLogs.get(tabId) || [];
        let size = getTabLogSize(tabId);
        while (logs.length > 0 && size > MAX_STORED_LOG_BYTES / 2) {
          size -= getStoredSize(logs.shift()) + 1;
        }
        tabLogSizes.set(tabId, Math.max(2, size));
      }

      const retryUpdates = {};
      for (const tabId of flushedTabs) {
        retryUpdates[`logs_${tabId}`] = tabLogs.get(tabId) || [];
      }
      chrome.storage.session.set(retryUpdates);
    });
  }, 500);
}

// Initialize storage for a tab
function initTab(tabId) {
  if (!tabLogs.has(tabId)) {
    tabLogs.set(tabId, []);
    tabLogSizes.set(tabId, getStoredSize([]));
  }
}

// --- WebSocket Client (MCP Server Bridge) ---

const WS_URL = 'ws://127.0.0.1:18462';
let ws = null;
let wsReconnectDelay = 1000;
const WS_MAX_RECONNECT_DELAY = 30000;
let wsQueue = [];

function wsSend(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  } else {
    // Queue messages while connecting, then flush them on open.
    wsQueue.push(msg);
  }
}

function wsConnect() {
  try {
    ws = new WebSocket(WS_URL);
  } catch {
    scheduleWsReconnect();
    return;
  }

  ws.onopen = () => {
    wsReconnectDelay = 1000;
    // Flush any messages queued while connecting
    for (const queued of wsQueue) {
      ws.send(JSON.stringify(queued));
    }
    wsQueue = [];
    // Send full sync of all current tabs
    ready.then(() => {
      const tabs = {};
      for (const [tabId, logs] of tabLogs) {
        tabs[tabId] = {
          url: tabUrls.get(tabId) || 'unknown',
          title: null,
          logs,
        };
      }
      // Populate titles from chrome.tabs API
      chrome.tabs.query({}, (allTabs) => {
        for (const tab of allTabs) {
          if (tabs[tab.id]) {
            tabs[tab.id].url = tab.url || tabs[tab.id].url;
            tabs[tab.id].title = tab.title || null;
            tabUrls.set(tab.id, tab.url || 'unknown');
          }
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

  ws.onerror = () => {
    // onclose will fire after this
  };
}

function scheduleWsReconnect() {
  setTimeout(() => {
    wsReconnectDelay = Math.min(wsReconnectDelay * 2, WS_MAX_RECONNECT_DELAY);
    wsConnect();
  }, wsReconnectDelay);
}

function handleServerMessage(msg) {
  if (msg.type === 'CLEAR_LOGS' && msg.tabId) {
    ready.then(() => {
      tabLogs.set(msg.tabId, []);
      tabLogSizes.set(msg.tabId, getStoredSize([]));
      chrome.storage.session.set({ [`logs_${msg.tabId}`]: [] });
    });
  } else if (msg.type === 'CLEAR_ALL_LOGS') {
    ready.then(() => {
      for (const tabId of tabLogs.keys()) {
        tabLogs.set(tabId, []);
        tabLogSizes.set(tabId, getStoredSize([]));
      }
      const updates = {};
      for (const tabId of tabLogs.keys()) {
        updates[`logs_${tabId}`] = [];
      }
      chrome.storage.session.set(updates);
    });
  }
}

// Start WebSocket connection
wsConnect();

// --- Page Load Detection ---

chrome.webNavigation.onCommitted.addListener((details) => {
  // Only track main frame navigations (not iframes)
  if (details.frameId !== 0) return;
  // Ignore about:, chrome:, etc.
  if (!details.url || details.url.startsWith('chrome://') || details.url.startsWith('about:')) return;

  const tabId = details.tabId;
  tabUrls.set(tabId, details.url);

  // Get tab title (may not be available yet, but try)
  chrome.tabs.get(tabId, (tab) => {
    const title = chrome.runtime.lastError ? null : (tab?.title || null);
    wsSend({ type: 'NEW_SESSION', tabId, url: details.url, title });
  });
});

// Clean up when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  tabLogs.delete(tabId);
  tabUrls.delete(tabId);
  tabLogSizes.delete(tabId);
  chrome.storage.session.remove(`logs_${tabId}`);
  wsSend({ type: 'TAB_CLOSED', tabId });
});

// Note: we intentionally do NOT clear logs on tab navigation so that
// logs survive page refreshes.  Users can clear manually via the popup.

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  if (message.type === 'CONSOLE_LOG') {
    if (tabId) {
      ready.then(() => {
        initTab(tabId);
        const logs = tabLogs.get(tabId);
        const logEntry = createStoredLog(message);
        logs.push(logEntry);
        tabLogSizes.set(tabId, getTabLogSize(tabId) + getStoredSize(logEntry) + 1);
        trimTabLogs(tabId);
        dirtyTabs.add(tabId);
        scheduleFlush();

        // Forward to MCP server
        wsSend({ type: 'LOG', tabId, log: logEntry });
      });
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

  if (message.type === 'CLEAR_LOGS') {
    ready.then(() => {
      tabLogs.set(message.tabId, []);
      tabLogSizes.set(message.tabId, getStoredSize([]));
      chrome.storage.session.set({ [`logs_${message.tabId}`]: [] }, () => {
        sendResponse({ success: true });
      });
      wsSend({ type: 'LOGS_CLEARED', tabId: message.tabId });
    });
    return true;
  }
});
