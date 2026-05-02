// Content script bridge between the page-world console hook and the extension worker.

(function() {
  'use strict';

  const LISTENER_KEY = '__CONSOLE_LOG_COPIER_BRIDGE_LISTENER__';

  if (globalThis[LISTENER_KEY]) {
    window.removeEventListener('__CONSOLE_LOG_COPIER__', globalThis[LISTENER_KEY]);
  }

  // Replaces stale bridge listeners so reinjection can repair invalidated extension contexts.
  function forwardConsoleCapture(event) {
    const data = event.detail || {};
    chrome.runtime.sendMessage({
      type: 'CONSOLE_LOG',
      level: data.level,
      timestamp: data.timestamp,
      args: data.args,
      stack: data.stack,
      filterCategory: data.filterCategory || null,
      sourceUrl: data.sourceUrl || location.href,
      pageUrl: data.pageUrl || location.href,
      frameId: data.frameId ?? null,
      documentId: data.documentId || null,
      attachId: data.attachId || null
    }, () => {
      // If the extension was reloaded, Chrome can invalidate this context.
      // Swallowing lastError keeps the host page stable until reattach reinstalls the bridge.
      void chrome.runtime.lastError;
    });
  }

  // Sends listener health events to the background worker for popup status and repair decisions.
  function forwardListenerStatus(event) {
    const data = event.detail || {};
    chrome.runtime.sendMessage({
      type: 'LISTENER_STATUS',
      status: data.status || 'unknown',
      reason: data.reason || null,
      timestamp: data.timestamp || new Date().toISOString(),
      sourceUrl: data.sourceUrl || location.href,
      pageUrl: data.pageUrl || location.href,
      attachId: data.attachId || null
    }, () => {
      void chrome.runtime.lastError;
    });
  }

  globalThis[LISTENER_KEY] = forwardConsoleCapture;
  window.addEventListener('__CONSOLE_LOG_COPIER__', forwardConsoleCapture);

  const STATUS_LISTENER_KEY = '__CONSOLE_LOG_COPIER_STATUS_LISTENER__';
  if (globalThis[STATUS_LISTENER_KEY]) {
    window.removeEventListener('__CONSOLE_LOG_COPIER_STATUS__', globalThis[STATUS_LISTENER_KEY]);
  }
  globalThis[STATUS_LISTENER_KEY] = forwardListenerStatus;
  window.addEventListener('__CONSOLE_LOG_COPIER_STATUS__', forwardListenerStatus);
})();
