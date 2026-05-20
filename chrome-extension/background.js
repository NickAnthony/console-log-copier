// Background service worker for Console Log Copier.
// Uses in-memory Map backed by chrome.storage.session so logs
// survive service worker restarts.

const tabLogs = new Map();
let dirtyTabs = new Set();
let flushTimer = null;

const listenerStatusByTab = new Map();

// Restore logs from session storage when the service worker wakes up.
const ready = new Promise((resolve) => {
  chrome.storage.session.get(null, (result) => {
    for (const [key, value] of Object.entries(result || {})) {
      if (key.startsWith('logs_')) {
        const tabId = parseInt(key.slice(5), 10);
        tabLogs.set(tabId, value);
      }
    }

    resolve();
  });
});

// Flush dirty tabs to session storage in one batch to avoid writing on every console call.
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

// Initialize storage for a tab the first time it emits a captured log.
function initTab(tabId) {
  if (!tabLogs.has(tabId)) {
    tabLogs.set(tabId, []);
  }
}

// Normalizes sender and page metadata so logs stay tied to the tab session that emitted them.
function buildLogEntry(message, sender) {
  const source = message.source || {};
  const frameId = typeof sender.frameId === 'number' ? sender.frameId : 0;
  const pageUrl = sender.tab?.url || source.url || sender.url || 'unknown';
  const sourceUrl = source.url || sender.url || pageUrl;

  return {
    level: message.level,
    timestamp: message.timestamp,
    args: message.args,
    stack: message.stack,
    filterCategory: message.filterCategory || null,
    pageUrl,
    sourceUrl,
    sourceFrame: source.frame || (frameId === 0 ? 'main' : 'frame'),
    frameId,
    documentId: sender.documentId || null,
    attachId: source.attachId || null
  };
}

// Reinjects both bridge worlds so the popup can repair a stale or missing listener in-place.
async function reattachListener(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab?.url || !isInjectableUrl(tab.url)) {
    throw new Error('Current tab cannot be attached');
  }

  await executeScriptInFrames(tabId, 'content.js');
  await executeScriptInFrames(tabId, 'inject.js', 'MAIN');

  return { attached: true, tabId, url: tab.url };
}

// Keeps a compact per-tab listener heartbeat for popup status and debugging.
function updateListenerStatus(message, sender) {
  const tabId = sender.tab?.id;
  if (!tabId) return;

  const frameId = typeof sender.frameId === 'number' ? sender.frameId : 0;
  const existing = listenerStatusByTab.get(tabId) || { frames: {} };
  existing.frames[frameId] = {
    ...(message.status || {}),
    frameId,
    pageUrl: sender.tab?.url || message.status?.source?.url || sender.url || 'unknown',
    sourceUrl: message.status?.source?.url || sender.url || 'unknown',
    seenAt: new Date().toISOString()
  };
  existing.lastSeenAt = existing.frames[frameId].seenAt;
  listenerStatusByTab.set(tabId, existing);
}

function getListenerStatus(tabId) {
  return listenerStatusByTab.get(tabId) || null;
}

// Restricts manual reinjection to browser pages that can run extension content scripts.
function isInjectableUrl(url) {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:', 'file:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

// Executes one extension script across frames Chrome allows for the active tab.
async function executeScriptInFrames(tabId, file, world) {
  const options = {
    files: [file],
    ...(world ? { world } : {}),
    injectImmediately: true
  };

  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      ...options
    });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      ...options
    });
  }
}

// Clean up when tab is closed.
chrome.tabs.onRemoved.addListener((tabId) => {
  tabLogs.delete(tabId);
  listenerStatusByTab.delete(tabId);
  chrome.storage.session.remove(`logs_${tabId}`);
});

// Note: we intentionally do NOT clear logs on tab navigation so that
// logs survive page refreshes. Users can clear manually via the popup.

// Listen for messages from content scripts and the popup.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  if (message.type === 'CONSOLE_LOG') {
    if (tabId) {
      ready.then(() => {
        initTab(tabId);
        const logs = tabLogs.get(tabId);
        const logEntry = buildLogEntry(message, sender);
        logs.push(logEntry);
        // Keep only last 1000 logs per tab.
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

  if (message.type === 'LISTENER_STATUS') {
    updateListenerStatus(message, sender);
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
    sendResponse({ status: getListenerStatus(message.tabId) });
    return;
  }

  if (message.type === 'REATTACH_LISTENER') {
    reattachListener(message.tabId)
      .then((status) => sendResponse({ success: true, status }))
      .catch((error) => sendResponse({ success: false, error: error?.message || 'Reattach failed' }));
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
