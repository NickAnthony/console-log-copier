// Content script - injects the console interceptor into the page context

(function() {
  // Inject the script into the page context
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('inject.js');
  script.onload = function() {
    this.remove();
  };
  (document.head || document.documentElement).appendChild(script);

  // Listen for messages from the injected script
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
