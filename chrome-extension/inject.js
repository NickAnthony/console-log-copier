// Injected script that intercepts console methods
// This runs in the page context to capture all console output

(function() {
  'use strict';

  // Patterns to filter out React/Node/framework noise
  const FILTER_PATTERNS = [
    // React warnings and errors
    /^Warning:/,
    /^Error: Minified React error/,
    /react-dom/i,
    /react\.development/i,
    /react\.production/i,
    /^The above error occurred in/,
    /^Consider adding an error boundary/,
    /^React does not recognize/,
    /^Invalid prop/,
    /^Failed prop type/,
    /^Each child in a list should have a unique/,
    /^Cannot update a component/,
    /^Can't perform a React state update/,
    /^findDOMNode is deprecated/,
    /^Legacy context API/,
    /^Unsafe lifecycle method/,
    /componentWillMount has been renamed/,
    /componentWillReceiveProps has been renamed/,
    /componentWillUpdate has been renamed/,

    // Hydration errors
    /hydrat/i,
    /^Text content does not match/,
    /^Expected server HTML/,
    /^Hydration failed/,
    /^There was an error while hydrating/,
    /^An error occurred during hydration/,

    // Next.js specific
    /^Fast Refresh/,
    /^\[Fast Refresh\]/,
    /^next-dev\.js/,
    /^\[HMR\]/,
    /^Compiled/,
    /^Compiling/,
    /^wait.*compiling/i,
    /^event.*compiled/i,

    // Webpack/bundler noise
    /^\[webpack/,
    /^webpack:/,
    /^\[HMR\]/,
    /^Hot Module Replacement/,

    // Node.js specific
    /^node:/,
    /^internal\//,
    /DeprecationWarning/,
    /ExperimentalWarning/,

    // Browser DevTools noise
    /^Download the React DevTools/,
    /^Download the Apollo DevTools/,
    /^Download the Redux DevTools/,
    /^%c/,  // Styled console messages (usually from frameworks)

    // Common framework debug messages
    /^\[vite\]/i,
    /^\[nuxt\]/i,
    /^\[vue/i,
    /^Vue warn/i,
    /^\[Svelte/i,
    /^Angular is running/,
  ];

  // Stack trace patterns that indicate framework internals
  const FRAMEWORK_STACK_PATTERNS = [
    /node_modules\/react/,
    /node_modules\/react-dom/,
    /node_modules\/next/,
    /node_modules\/webpack/,
    /node_modules\/vue/,
    /node_modules\/nuxt/,
    /node_modules\/@vue/,
    /node_modules\/@next/,
    /node_modules\/@nuxt/,
  ];

  // Deep serialize an object with circular reference handling
  function deepSerialize(obj, seen = new WeakSet(), depth = 0, maxDepth = 10) {
    // Prevent infinite recursion
    if (depth > maxDepth) {
      return '[Max Depth Reached]';
    }

    // Handle primitives
    if (obj === null) return null;
    if (obj === undefined) return undefined;
    if (typeof obj === 'string') return obj;
    if (typeof obj === 'number') {
      if (Number.isNaN(obj)) return 'NaN';
      if (!Number.isFinite(obj)) return obj > 0 ? 'Infinity' : '-Infinity';
      return obj;
    }
    if (typeof obj === 'boolean') return obj;
    if (typeof obj === 'bigint') return obj.toString() + 'n';
    if (typeof obj === 'symbol') return obj.toString();
    if (typeof obj === 'function') {
      return `[Function: ${obj.name || 'anonymous'}]`;
    }

    // Handle special objects
    if (obj instanceof Date) {
      return obj.toISOString();
    }
    if (obj instanceof RegExp) {
      return obj.toString();
    }
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
        const keyStr = typeof key === 'object' ? JSON.stringify(deepSerialize(key, seen, depth + 1, maxDepth)) : String(key);
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
    if (obj instanceof WeakMap) {
      return '[WeakMap]';
    }
    if (obj instanceof WeakSet) {
      return '[WeakSet]';
    }
    if (ArrayBuffer.isView(obj)) {
      return {
        __type__: obj.constructor.name,
        data: Array.from(obj).slice(0, 100),
        truncated: obj.length > 100
      };
    }
    if (obj instanceof ArrayBuffer) {
      return {
        __type__: 'ArrayBuffer',
        byteLength: obj.byteLength
      };
    }
    if (typeof obj === 'object' && obj.constructor === Object.prototype.constructor === false && obj.constructor?.name) {
      // Handle DOM elements
      if (obj instanceof Element) {
        return `[${obj.tagName}${obj.id ? '#' + obj.id : ''}${obj.className ? '.' + obj.className.split(' ').join('.') : ''}]`;
      }
      if (obj instanceof Node) {
        return `[${obj.nodeName}]`;
      }
      if (typeof Window !== 'undefined' && obj instanceof Window) {
        return '[Window]';
      }
      if (typeof Document !== 'undefined' && obj instanceof Document) {
        return '[Document]';
      }
    }

    // Handle circular references
    if (typeof obj === 'object') {
      if (seen.has(obj)) {
        return '[Circular]';
      }
      seen.add(obj);
    }

    // Handle arrays
    if (Array.isArray(obj)) {
      return obj.map(item => deepSerialize(item, seen, depth + 1, maxDepth));
    }

    // Handle plain objects
    if (typeof obj === 'object') {
      const result = {};
      const keys = Object.keys(obj);

      // Also get symbol keys
      const symbolKeys = Object.getOwnPropertySymbols(obj);

      for (const key of keys) {
        try {
          result[key] = deepSerialize(obj[key], seen, depth + 1, maxDepth);
        } catch (e) {
          result[key] = `[Error accessing property: ${e.message}]`;
        }
      }

      for (const sym of symbolKeys) {
        try {
          result[sym.toString()] = deepSerialize(obj[sym], seen, depth + 1, maxDepth);
        } catch (e) {
          result[sym.toString()] = `[Error accessing property: ${e.message}]`;
        }
      }

      // Add constructor name if it's a custom class
      if (obj.constructor && obj.constructor.name && obj.constructor.name !== 'Object') {
        result.__className__ = obj.constructor.name;
      }

      return result;
    }

    return String(obj);
  }

  // Check if a log should be filtered out
  function shouldFilter(args, stack) {
    if (!args || args.length === 0) return true;

    const firstArg = args[0];

    // Check if first argument matches filter patterns
    if (typeof firstArg === 'string') {
      for (const pattern of FILTER_PATTERNS) {
        if (pattern.test(firstArg)) {
          return true;
        }
      }
    }

    // Check stack trace for framework internals
    if (stack) {
      for (const pattern of FRAMEWORK_STACK_PATTERNS) {
        if (pattern.test(stack)) {
          // Only filter if it looks like an internal framework log
          // User code that happens to be in a callback from framework code should still be captured
          const stackLines = stack.split('\n');
          // If the first non-error line is from a framework, filter it
          const firstStackLine = stackLines.find(line =>
            line.includes('at ') && !line.includes('deepSerialize') && !line.includes('interceptConsole')
          );
          if (firstStackLine && pattern.test(firstStackLine)) {
            return true;
          }
        }
      }
    }

    return false;
  }

  // Get clean stack trace
  function getCleanStack() {
    const stack = new Error().stack;
    if (!stack) return null;

    // Remove the first few lines that are from this script
    const lines = stack.split('\n');
    const cleanLines = lines.filter(line => {
      return !line.includes('inject.js') &&
             !line.includes('deepSerialize') &&
             !line.includes('interceptConsole');
    });

    return cleanLines.slice(1).join('\n'); // Remove "Error" line
  }

  // Store original console methods
  const originalConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    info: console.info.bind(console),
    debug: console.debug.bind(console),
    table: console.table.bind(console),
    dir: console.dir.bind(console),
    dirxml: console.dirxml.bind(console),
  };

  // Intercept console methods
  function interceptConsole(level) {
    return function(...args) {
      // Always call the original
      originalConsole[level](...args);

      try {
        const stack = getCleanStack();

        // Check if this should be filtered
        if (shouldFilter(args, stack)) {
          return;
        }

        // Deep serialize all arguments
        const serializedArgs = args.map(arg => deepSerialize(arg));

        // Dispatch custom event to content script
        window.dispatchEvent(new CustomEvent('__CONSOLE_LOG_COPIER__', {
          detail: {
            level,
            timestamp: new Date().toISOString(),
            args: serializedArgs,
            stack: stack
          }
        }));
      } catch (e) {
        // Silently fail - don't break the page's console
      }
    };
  }

  // Override console methods
  console.log = interceptConsole('log');
  console.warn = interceptConsole('warn');
  console.error = interceptConsole('error');
  console.info = interceptConsole('info');
  console.debug = interceptConsole('debug');
  console.table = interceptConsole('table');
  console.dir = interceptConsole('dir');
  console.dirxml = interceptConsole('dirxml');

  // Mark that we've initialized
  window.__CONSOLE_LOG_COPIER_INITIALIZED__ = true;
})();
