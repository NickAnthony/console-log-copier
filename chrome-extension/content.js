// Content script - bridges page-world console events into the extension worker.

(function() {
  const STATE_KEY = '__CONSOLE_LOG_COPIER_CONTENT_STATE__';
  const previousState = window[STATE_KEY];

  if (previousState?.logHandler) {
    window.removeEventListener('__CONSOLE_LOG_COPIER__', previousState.logHandler);
  }
  if (previousState?.statusHandler) {
    window.removeEventListener('__CONSOLE_LOG_COPIER_STATUS__', previousState.statusHandler);
  }

  function sendRuntimeMessage(message) {
    chrome.runtime.sendMessage(message, () => {
      void chrome.runtime.lastError;
    });
  }

  const logHandler = (event) => {
    const data = event.detail;
    sendRuntimeMessage({
      type: 'CONSOLE_LOG',
      level: data.level,
      timestamp: data.timestamp,
      args: data.args,
      stack: data.stack,
      filterCategory: data.filterCategory || null,
      source: data.source || null
    });
  };

  const statusHandler = (event) => {
    sendRuntimeMessage({
      type: 'LISTENER_STATUS',
      status: event.detail || null
    });
  };

  window.addEventListener('__CONSOLE_LOG_COPIER__', logHandler);
  window.addEventListener('__CONSOLE_LOG_COPIER_STATUS__', statusHandler);
  window[STATE_KEY] = {
    logHandler,
    statusHandler,
    attachedAt: new Date().toISOString()
  };
})();
