// Background service worker for Console Log Copier
// Stores logs per tab

const tabLogs = new Map();

// Initialize storage for a tab
function initTab(tabId) {
  if (!tabLogs.has(tabId)) {
    tabLogs.set(tabId, []);
  }
}

// Clean up when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  tabLogs.delete(tabId);
});

// Clean up when tab navigates
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    tabLogs.set(tabId, []);
  }
});

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  if (message.type === 'CONSOLE_LOG') {
    if (tabId) {
      initTab(tabId);
      const logs = tabLogs.get(tabId);
      logs.push({
        level: message.level,
        timestamp: message.timestamp,
        args: message.args,
        stack: message.stack
      });
      // Keep only last 1000 logs per tab
      if (logs.length > 1000) {
        logs.shift();
      }
    }
    sendResponse({ success: true });
  }

  if (message.type === 'GET_LOGS') {
    const requestTabId = message.tabId;
    const logs = tabLogs.get(requestTabId) || [];
    sendResponse({ logs });
  }

  if (message.type === 'CLEAR_LOGS') {
    const requestTabId = message.tabId;
    tabLogs.set(requestTabId, []);
    sendResponse({ success: true });
  }

  return true; // Keep message channel open for async response
});
