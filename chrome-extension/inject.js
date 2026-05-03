// Injected script that intercepts console methods in the page context.

(function() {
  'use strict';

  const STATE_KEY = '__CONSOLE_LOG_COPIER_STATE__';
  const EVENT_NAME = '__CONSOLE_LOG_COPIER__';
  const STATUS_EVENT_NAME = '__CONSOLE_LOG_COPIER_STATUS__';
  const CONSOLE_LEVELS = ['log', 'warn', 'error', 'info', 'debug', 'table', 'dir', 'dirxml'];

  const previousState = window[STATE_KEY];
  if (previousState && typeof previousState.restore === 'function') {
    previousState.restore('reattach');
  }

  const attachId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  // Categorized patterns for framework noise detection
  const CATEGORIZED_FILTER_PATTERNS = {
    react: [
      /^Warning:/, /^Error: Minified React error/, /react-dom/i,
      /react\.development/i, /react\.production/i,
      /^The above error occurred in/, /^Consider adding an error boundary/,
      /^React does not recognize/, /^Invalid prop/, /^Failed prop type/,
      /^Each child in a list should have a unique/,
      /^Cannot update a component/, /^Can't perform a React state update/,
      /^findDOMNode is deprecated/, /^Legacy context API/,
      /^Unsafe lifecycle method/, /componentWillMount has been renamed/,
      /componentWillReceiveProps has been renamed/,
      /componentWillUpdate has been renamed/,
      /hydrat/i, /^Text content does not match/, /^Expected server HTML/,
      /^Hydration failed/, /^There was an error while hydrating/,
      /^An error occurred during hydration/,
    ],
    framework: [
      /^\[vite\]/i, /^\[nuxt\]/i, /^\[vue/i, /^Vue warn/i,
      /^\[Svelte/i, /^Angular is running/,
      /^node:/, /^internal\//, /DeprecationWarning/, /ExperimentalWarning/,
      /^Fast Refresh/, /^\[Fast Refresh\]/, /^next-dev\.js/,
      /^Compiled/, /^Compiling/, /^wait.*compiling/i, /^event.*compiled/i,
    ],
    bundler: [
      /^\[HMR\]/, /^\[webpack/, /^webpack:/, /^Hot Module Replacement/,
    ],
    devtools: [
      /^Download the React DevTools/, /^Download the Apollo DevTools/,
      /^Download the Redux DevTools/, /^%c/,
    ],
  };

  const CATEGORIZED_STACK_PATTERNS = {
    react: [/node_modules\/react/, /node_modules\/react-dom/],
    framework: [
      /node_modules\/next/, /node_modules\/vue/, /node_modules\/nuxt/,
      /node_modules\/@vue/, /node_modules\/@next/, /node_modules\/@nuxt/,
    ],
    bundler: [/node_modules\/webpack/],
  };

  const FILTER_ENTRIES = Object.entries(CATEGORIZED_FILTER_PATTERNS);
  const STACK_ENTRIES = Object.entries(CATEGORIZED_STACK_PATTERNS);

  const originalConsole = {};
  for (const level of CONSOLE_LEVELS) {
    originalConsole[level] = previousState?.originalConsole?.[level] || console[level].bind(console);
  }
  const originalFetch = previousState?.originalFetch || window.fetch;
  const originalXHROpen = previousState?.originalXHROpen || window.XMLHttpRequest?.prototype.open;
  const originalXHRSend = previousState?.originalXHRSend || window.XMLHttpRequest?.prototype.send;
  const OriginalEventSource = previousState?.OriginalEventSource || window.EventSource;

  // Publishes listener health so the popup can show status and trigger repair.
  function dispatchStatus(status, reason = null) {
    window.dispatchEvent(new CustomEvent(STATUS_EVENT_NAME, {
      detail: {
        status,
        reason,
        timestamp: new Date().toISOString(),
        sourceUrl: location.href,
        pageUrl: location.href,
        attachId
      }
    }));
  }

  // Strip ANSI escape codes and console format markers from captured strings.
  function stripAnsi(str) {
    if (typeof str !== 'string') return str;
    return str
      .replace(/\x1b\[[0-9;]*m/g, '')
      .replace(/\u001b\[[0-9;]*m/g, '')
      .replace(/\033\[[0-9;]*m/g, '')
      .replace(/\[\d+(?:;\d+)*m/g, '')
      .replace(/%[sdifoOc]/g, '')
      .trim();
  }

  // Deep-serializes console arguments while preserving useful object shape for copy output.
  function deepSerialize(obj, seen = new WeakSet(), depth = 0, maxDepth = 10) {
    if (depth > maxDepth) return '[Max Depth Reached]';
    if (obj === null) return null;
    if (obj === undefined) return undefined;
    if (typeof obj === 'string') return stripAnsi(obj);
    if (typeof obj === 'number') {
      if (Number.isNaN(obj)) return 'NaN';
      if (!Number.isFinite(obj)) return obj > 0 ? 'Infinity' : '-Infinity';
      return obj;
    }
    if (typeof obj === 'boolean') return obj;
    if (typeof obj === 'bigint') return obj.toString() + 'n';
    if (typeof obj === 'symbol') return obj.toString();
    if (typeof obj === 'function') return `[Function: ${obj.name || 'anonymous'}]`;
    if (obj instanceof Date) return obj.toISOString();
    if (obj instanceof RegExp) return obj.toString();
    if (obj instanceof Error) {
      return {
        __type__: 'Error',
        name: obj.name,
        message: obj.message,
        stack: obj.stack
      };
    }
    if (obj instanceof Map) {
      if (seen.has(obj)) return '[Circular Map]';
      seen.add(obj);
      const entries = {};
      for (const [key, value] of obj) {
        const keyStr = typeof key === 'object'
          ? JSON.stringify(deepSerialize(key, seen, depth + 1, maxDepth))
          : String(key);
        entries[keyStr] = deepSerialize(value, seen, depth + 1, maxDepth);
      }
      return { __type__: 'Map', entries };
    }
    if (obj instanceof Set) {
      if (seen.has(obj)) return '[Circular Set]';
      seen.add(obj);
      return {
        __type__: 'Set',
        values: Array.from(obj).map(v => deepSerialize(v, seen, depth + 1, maxDepth))
      };
    }
    if (obj instanceof WeakMap) return '[WeakMap]';
    if (obj instanceof WeakSet) return '[WeakSet]';
    if (ArrayBuffer.isView(obj)) {
      return {
        __type__: obj.constructor.name,
        data: Array.from(obj).slice(0, 100),
        truncated: obj.length > 100
      };
    }
    if (obj instanceof ArrayBuffer) {
      return { __type__: 'ArrayBuffer', byteLength: obj.byteLength };
    }
    if (typeof obj === 'object') {
      if (obj instanceof Element) {
        return `[${obj.tagName}${obj.id ? '#' + obj.id : ''}${obj.className ? '.' + obj.className.split(' ').join('.') : ''}]`;
      }
      if (obj instanceof Node) return `[${obj.nodeName}]`;
      if (typeof Window !== 'undefined' && obj instanceof Window) return '[Window]';
      if (typeof Document !== 'undefined' && obj instanceof Document) return '[Document]';
      if (seen.has(obj)) return '[Circular]';
      seen.add(obj);
    }
    if (Array.isArray(obj)) {
      return obj.map(item => deepSerialize(item, seen, depth + 1, maxDepth));
    }
    if (typeof obj === 'object') {
      const result = {};
      for (const key of Object.keys(obj)) {
        try {
          result[key] = deepSerialize(obj[key], seen, depth + 1, maxDepth);
        } catch (e) {
          result[key] = `[Error accessing property: ${e.message}]`;
        }
      }
      for (const sym of Object.getOwnPropertySymbols(obj)) {
        try {
          result[sym.toString()] = deepSerialize(obj[sym], seen, depth + 1, maxDepth);
        } catch (e) {
          result[sym.toString()] = `[Error accessing property: ${e.message}]`;
        }
      }
      if (obj.constructor && obj.constructor.name && obj.constructor.name !== 'Object') {
        result.__className__ = obj.constructor.name;
      }
      return result;
    }
    return String(obj);
  }

  // Classifies likely framework noise without dropping the log entirely.
  function getFilterCategory(args, stack) {
    if (!args || args.length === 0) return 'devtools';
    const firstArg = args[0];
    if (typeof firstArg === 'string') {
      for (const [category, patterns] of FILTER_ENTRIES) {
        for (const pattern of patterns) {
          if (pattern.test(firstArg)) return category;
        }
      }
    }
    if (stack) {
      for (const [category, patterns] of STACK_ENTRIES) {
        for (const pattern of patterns) {
          if (!pattern.test(stack)) continue;
          const stackLines = stack.split('\n');
          const firstStackLine = stackLines.find(line =>
            line.includes('at ') && !line.includes('deepSerialize') && !line.includes('interceptConsole')
          );
          if (firstStackLine && pattern.test(firstStackLine)) return category;
        }
      }
    }
    return null;
  }

  // Returns a caller stack with the capture implementation frames removed.
  function getCleanStack() {
    const stack = new Error().stack;
    if (!stack) return null;
    const lines = stack.split('\n');
    const cleanLines = lines.filter(line =>
      !line.includes('inject.js') &&
      !line.includes('deepSerialize') &&
      !line.includes('interceptConsole')
    );
    return cleanLines.slice(1).join('\n');
  }

  // Wraps one console method while preserving the page's original behavior first.
  function interceptConsole(level) {
    return function(...args) {
      originalConsole[level](...args);
      try {
        const stack = getCleanStack();
        const filterCategory = getFilterCategory(args, stack);
        const serializedArgs = args.map(arg => deepSerialize(arg));
        window.dispatchEvent(new CustomEvent(EVENT_NAME, {
          detail: {
            level,
            timestamp: new Date().toISOString(),
            args: serializedArgs,
            stack,
            filterCategory,
            sourceUrl: location.href,
            pageUrl: location.href,
            attachId
          }
        }));
      } catch {
        dispatchStatus('capture-error', 'console serialization failed');
      }
    };
  }

  for (const level of CONSOLE_LEVELS) {
    console[level] = interceptConsole(level);
  }

  // Emits failed network responses as log entries that travel through the same durable path.
  function dispatchNetworkError(details) {
    try {
      window.dispatchEvent(new CustomEvent(EVENT_NAME, {
        detail: {
          level: 'network',
          timestamp: new Date().toISOString(),
          args: [deepSerialize(details)],
          stack: null,
          sourceUrl: location.href,
          pageUrl: location.href,
          attachId
        }
      }));
    } catch {
      dispatchStatus('capture-error', 'network serialization failed');
    }
  }

  window.fetch = async function(...args) {
    const url = args[0] instanceof Request ? args[0].url : String(args[0]);
    const method = args[1]?.method || (args[0] instanceof Request ? args[0].method : 'GET');
    try {
      const response = await originalFetch.apply(this, args);
      if (!response.ok) {
        dispatchNetworkError({
          type: 'fetch',
          method: method.toUpperCase(),
          url,
          status: response.status,
          statusText: response.statusText
        });
      }
      return response;
    } catch (error) {
      dispatchNetworkError({
        type: 'fetch',
        method: method.toUpperCase(),
        url,
        error: error.message
      });
      throw error;
    }
  };

  if (window.XMLHttpRequest && originalXHROpen && originalXHRSend) {
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      this.__clc_method = method;
      this.__clc_url = url;
      return originalXHROpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function(...args) {
      this.addEventListener('loadend', function() {
        if (this.status >= 400 || this.status === 0) {
          dispatchNetworkError({
            type: 'xhr',
            method: (this.__clc_method || 'GET').toUpperCase(),
            url: this.__clc_url,
            status: this.status,
            statusText: this.statusText || (this.status === 0 ? 'Network Error' : '')
          });
        }
      });

      this.addEventListener('error', () => {
        dispatchNetworkError({
          type: 'xhr',
          method: (this.__clc_method || 'GET').toUpperCase(),
          url: this.__clc_url,
          error: 'Network request failed'
        });
      });

      return originalXHRSend.apply(this, args);
    };
  }

  if (OriginalEventSource) {
    window.EventSource = function(url, options) {
      const es = new OriginalEventSource(url, options);
      es.addEventListener('error', () => {
        dispatchNetworkError({
          type: 'eventsource',
          method: 'GET',
          url: typeof url === 'string' ? url : String(url),
          error: 'EventSource connection failed'
        });
      });
      return es;
    };
    window.EventSource.prototype = OriginalEventSource.prototype;
    Object.defineProperty(window.EventSource, 'CONNECTING', { value: 0 });
    Object.defineProperty(window.EventSource, 'OPEN', { value: 1 });
    Object.defineProperty(window.EventSource, 'CLOSED', { value: 2 });
  }

  const heartbeatTimer = setInterval(() => dispatchStatus('attached'), 5000);

  window[STATE_KEY] = {
    attachId,
    originalConsole,
    originalFetch,
    originalXHROpen,
    originalXHRSend,
    OriginalEventSource,
    // Restores page globals before a clean reinstall, preventing nested wrappers.
    restore(reason = 'restore') {
      clearInterval(heartbeatTimer);
      for (const level of CONSOLE_LEVELS) {
        if (originalConsole[level]) console[level] = originalConsole[level];
      }
      if (originalFetch) window.fetch = originalFetch;
      if (window.XMLHttpRequest && originalXHROpen) XMLHttpRequest.prototype.open = originalXHROpen;
      if (window.XMLHttpRequest && originalXHRSend) XMLHttpRequest.prototype.send = originalXHRSend;
      if (OriginalEventSource) window.EventSource = OriginalEventSource;
      window.dispatchEvent(new CustomEvent(STATUS_EVENT_NAME, {
        detail: {
          status: 'detached',
          reason,
          timestamp: new Date().toISOString(),
          sourceUrl: location.href,
          pageUrl: location.href,
          attachId
        }
      }));
    }
  };

  dispatchStatus('attached', previousState ? 'reattached' : 'installed');
})();
