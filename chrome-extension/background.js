// Background service worker for Console Log Copier
// Uses in-memory Map backed by chrome.storage.session so logs
// survive service worker restarts.

const tabLogs = new Map();
let dirtyTabs = new Set();
let flushTimer = null;

const STORAGE_KEYS = {
  wsQueue: 'ws_queue',
};

// Track current URL per tab for MCP session management
const tabUrls = new Map();

const wsState = {
  connected: false,
  queuedCount: 0,
  reconnectDelay: 1000,
  reconnectAttempts: 0,
  lastConnectedAt: null,
  lastDisconnectedAt: null,
  lastError: null,
  lastAckedAt: null,
};

function persistWsQueue() {
  wsState.queuedCount = wsQueue.length;
  chrome.storage.session.set({ [STORAGE_KEYS.wsQueue]: wsQueue });
}

// Restore logs and WS queue from session storage when the service worker wakes up
const ready = new Promise((resolve) => {
  chrome.storage.session.get(null, (result) => {
    for (const [key, value] of Object.entries(result || {})) {
      if (key.startsWith('logs_')) {
        const tabId = parseInt(key.slice(5), 10);
        tabLogs.set(tabId, value);
      }
    }

    if (Array.isArray(result?.[STORAGE_KEYS.wsQueue])) {
      wsQueue = result[STORAGE_KEYS.wsQueue];
      wsState.queuedCount = wsQueue.length;
    }

    resolve();
  });
});

// Flush dirty tabs to session storage (batched for performance)
function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    const updates = {};
    for (const tabId of dirtyTabs) {
      updates[`logs_${tabId}`] = tabLogs.get(tabId) || [];
    }
    dirtyTabs.clear();
    flushTimer = null;
    chrome.storage.session.set(updates);
  }, 500);
}

// Initialize storage for a tab
function initTab(tabId) {
  if (!tabLogs.has(tabId)) {
    tabLogs.set(tabId, []);
  }
}

// --- WebSocket Client (MCP Server Bridge) ---

const WS_URL = 'ws://127.0.0.1:18462';
let ws = null;
let wsReconnectDelay = 1000;
const WS_MAX_RECONNECT_DELAY = 30000;
let wsQueue = [];
let wsReconnectTimer = null;
let inFlightMessageIds = new Set();

function enqueueWsMessage(msg) {
  const envelope = {
    ...msg,
    messageId: crypto.randomUUID(),
  };

  wsQueue.push(envelope);
  persistWsQueue();
  flushWsQueue();
}

function sendQueuedMessage(msg) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(msg));
  inFlightMessageIds.add(msg.messageId);
}

function flushWsQueue() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  for (const queued of wsQueue) {
    if (!inFlightMessageIds.has(queued.messageId)) {
      sendQueuedMessage(queued);
    }
  }
}

function acknowledgeMessage(messageId) {
  const nextQueue = wsQueue.filter(msg => msg.messageId !== messageId);
  if (nextQueue.length === wsQueue.length) return;

  wsQueue = nextQueue;
  inFlightMessageIds.delete(messageId);
  wsState.lastAckedAt = new Date().toISOString();
  persistWsQueue();
}

function formatWsStatusTitle() {
  const parts = [
    wsState.connected ? 'MCP server connected' : 'MCP server disconnected',
    `Queued: ${wsState.queuedCount}`,
  ];

  if (wsState.lastConnectedAt) {
    parts.push(`Last connected: ${wsState.lastConnectedAt}`);
  }
  if (wsState.lastDisconnectedAt) {
    parts.push(`Last disconnected: ${wsState.lastDisconnectedAt}`);
  }
  if (wsState.lastAckedAt) {
    parts.push(`Last delivered: ${wsState.lastAckedAt}`);
  }
  if (wsState.lastError) {
    parts.push(`Last error: ${wsState.lastError}`);
  }

  return parts.join('\n');
}

function getWsStatus() {
  return {
    ...wsState,
    connected: ws !== null && ws.readyState === WebSocket.OPEN,
    reconnectDelay: wsReconnectDelay,
    title: formatWsStatusTitle(),
  };
}

function wsConnect() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    return;
  }

  try {
    ws = new WebSocket(WS_URL);
  } catch (error) {
    wsState.lastError = error?.message || 'Failed to construct WebSocket';
    scheduleWsReconnect();
    return;
  }

  ws.onopen = () => {
    if (wsReconnectTimer) {
      clearTimeout(wsReconnectTimer);
      wsReconnectTimer = null;
    }
    wsReconnectDelay = 1000;
    wsState.connected = true;
    wsState.reconnectAttempts = 0;
    wsState.lastConnectedAt = new Date().toISOString();
    wsState.lastError = null;
    inFlightMessageIds.clear();

    // Flush any messages queued while disconnected
    flushWsQueue();

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
        enqueueWsMessage({ type: 'FULL_SYNC', tabs });
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
    if (msg.type === 'ACK' && msg.messageId) {
      acknowledgeMessage(msg.messageId);
      return;
    }
    handleServerMessage(msg);
  };

  ws.onclose = () => {
    wsState.connected = false;
    wsState.lastDisconnectedAt = new Date().toISOString();
    ws = null;
    inFlightMessageIds.clear();
    scheduleWsReconnect();
  };

  ws.onerror = (event) => {
    wsState.lastError = event?.message || 'WebSocket error';
    // onclose will fire after this
  };
}

function scheduleWsReconnect() {
  if (wsReconnectTimer) return;

  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    wsState.reconnectAttempts += 1;
    wsReconnectDelay = Math.min(wsReconnectDelay * 2, WS_MAX_RECONNECT_DELAY);
    wsConnect();
  }, wsReconnectDelay);
}

function handleServerMessage(msg) {
  if (msg.type === 'CLEAR_LOGS' && msg.tabId) {
    ready.then(() => {
      tabLogs.set(msg.tabId, []);
      chrome.storage.session.set({ [`logs_${msg.tabId}`]: [] });
    });
  } else if (msg.type === 'CLEAR_ALL_LOGS') {
    ready.then(() => {
      for (const tabId of tabLogs.keys()) {
        tabLogs.set(tabId, []);
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

function isTrackableUrl(url) {
  return url && !url.startsWith('chrome://') && !url.startsWith('about:');
}

function sendNewSession(tabId, url) {
  chrome.tabs.get(tabId, (tab) => {
    const title = chrome.runtime.lastError ? null : (tab?.title || null);
    enqueueWsMessage({ type: 'NEW_SESSION', tabId, url, title });
  });
}

function handleCommittedNavigation(details) {
  // Only track main frame navigations (not iframes)
  if (details.frameId !== 0) return;
  // Ignore about:, chrome:, etc.
  if (!isTrackableUrl(details.url)) return;

  const tabId = details.tabId;
  tabUrls.set(tabId, details.url);
  sendNewSession(tabId, details.url);
}

function handleHistoryNavigation(details) {
  if (details.frameId !== 0) return;
  if (!isTrackableUrl(details.url)) return;

  const tabId = details.tabId;
  const prevUrl = tabUrls.get(tabId);
  tabUrls.set(tabId, details.url);

  if (prevUrl === details.url) return;
  sendNewSession(tabId, details.url);
}

// Full page loads (navigation, reload)
chrome.webNavigation.onCommitted.addListener(handleCommittedNavigation);

// SPA navigations (pushState, replaceState)
chrome.webNavigation.onHistoryStateUpdated.addListener(handleHistoryNavigation);

// Clean up when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  tabLogs.delete(tabId);
  tabUrls.delete(tabId);
  chrome.storage.session.remove(`logs_${tabId}`);
  enqueueWsMessage({ type: 'TAB_CLOSED', tabId });
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
        const logEntry = {
          level: message.level,
          timestamp: message.timestamp,
          args: message.args,
          stack: message.stack,
          filterCategory: message.filterCategory || null
        };
        logs.push(logEntry);
        // Keep only last 1000 logs per tab
        if (logs.length > 1000) {
          logs.shift();
        }
        dirtyTabs.add(tabId);
        scheduleFlush();

        // Forward to MCP server
        enqueueWsMessage({ type: 'LOG', tabId, log: logEntry });
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

  if (message.type === 'GET_WS_STATUS') {
    sendResponse(getWsStatus());
    return;
  }

  if (message.type === 'CLEAR_LOGS') {
    ready.then(() => {
      tabLogs.set(message.tabId, []);
      chrome.storage.session.set({ [`logs_${message.tabId}`]: [] }, () => {
        sendResponse({ success: true });
      });
      enqueueWsMessage({ type: 'LOGS_CLEARED', tabId: message.tabId });
    });
    return true;
  }
});
