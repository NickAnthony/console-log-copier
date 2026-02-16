// Content script - injects the console interceptor into the page context

(function() {
  // Listen for messages from the injected script (inject.js runs in MAIN world via manifest)
  window.addEventListener('__CONSOLE_LOG_COPIER__', (event) => {
    const data = event.detail;
    chrome.runtime.sendMessage({
      type: 'CONSOLE_LOG',
      level: data.level,
      timestamp: data.timestamp,
      args: data.args,
      stack: data.stack,
      filterCategory: data.filterCategory || null
    });
  });
})();
