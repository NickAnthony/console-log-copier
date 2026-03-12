// Background service worker for Console Log Copier
// Uses in-memory Map backed by chrome.storage.session so logs
// survive service worker restarts.

const tabLogs = new Map();
let dirtyTabs = new Set();
let flushTimer = null;

// Track current URL per tab for MCP session management
const tabUrls = new Map();

// Restore logs from session storage when the service worker wakes up
const ready = new Promise((resolve) => {
  chrome.storage.session.get(null, (result) => {
    for (const [key, value] of Object.entries(result || {})) {
      if (key.startsWith('logs_')) {
        const tabId = parseInt(key.slice(5));
        tabLogs.set(tabId, value);
      }
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

function wsSend(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  } else {
    // Queue messages while connecting — they'll flush on open
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

function handleNavigation(details) {
  // Only track main frame navigations (not iframes)
  if (details.frameId !== 0) return;
  // Ignore about:, chrome:, etc.
  if (!details.url || details.url.startsWith('chrome://') || details.url.startsWith('about:')) return;

  const tabId = details.tabId;
  const prevUrl = tabUrls.get(tabId);
  tabUrls.set(tabId, details.url);

  // Skip if URL hasn't actually changed (avoids duplicate sessions)
  if (prevUrl === details.url) return;

  // Get tab title (may not be available yet, but try)
  chrome.tabs.get(tabId, (tab) => {
    const title = chrome.runtime.lastError ? null : (tab?.title || null);
    wsSend({ type: 'NEW_SESSION', tabId, url: details.url, title });
  });
}

// Full page loads (navigation, reload)
chrome.webNavigation.onCommitted.addListener(handleNavigation);

// SPA navigations (pushState, replaceState)
chrome.webNavigation.onHistoryStateUpdated.addListener(handleNavigation);

// Clean up when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  tabLogs.delete(tabId);
  tabUrls.delete(tabId);
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

  if (message.type === 'GET_WS_STATUS') {
    sendResponse({ connected: ws !== null && ws.readyState === WebSocket.OPEN });
    return;
  }

  if (message.type === 'CLEAR_LOGS') {
    ready.then(() => {
      tabLogs.set(message.tabId, []);
      chrome.storage.session.set({ [`logs_${message.tabId}`]: [] }, () => {
        sendResponse({ success: true });
      });
      wsSend({ type: 'LOGS_CLEARED', tabId: message.tabId });
    });
    return true;
  }
});
