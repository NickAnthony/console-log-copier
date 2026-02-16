// Background service worker for Console Log Copier
// Uses in-memory Map backed by chrome.storage.session so logs
// survive service worker restarts.

const tabLogs = new Map();
let dirtyTabs = new Set();
let flushTimer = null;

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

// Clean up when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  tabLogs.delete(tabId);
  chrome.storage.session.remove(`logs_${tabId}`);
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
        logs.push({
          level: message.level,
          timestamp: message.timestamp,
          args: message.args,
          stack: message.stack,
          filterCategory: message.filterCategory || null
        });
        // Keep only last 1000 logs per tab
        if (logs.length > 1000) {
          logs.shift();
        }
        dirtyTabs.add(tabId);
        scheduleFlush();
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
      chrome.storage.session.set({ [`logs_${message.tabId}`]: [] }, () => {
        sendResponse({ success: true });
      });
    });
    return true;
  }
});
