// Popup script for Console Log Copier

let currentLogs = [];
let currentFormat = 'pretty';

// Get current tab ID
async function getCurrentTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

// Fetch logs from background script
async function fetchLogs() {
  const tabId = await getCurrentTabId();
  if (!tabId) return [];

  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'GET_LOGS', tabId }, (response) => {
      resolve(response?.logs || []);
    });
  });
}

// Clear logs
async function clearLogs() {
  const tabId = await getCurrentTabId();
  if (!tabId) return;

  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'CLEAR_LOGS', tabId }, (response) => {
      resolve(response?.success);
    });
  });
}

// Format a single argument for display
function formatArg(arg, format = 'pretty') {
  if (arg === null) return 'null';
  if (arg === undefined) return 'undefined';
  if (typeof arg === 'string') return arg;

  try {
    if (format === 'pretty') {
      return JSON.stringify(arg, null, 2);
    } else if (format === 'compact') {
      return JSON.stringify(arg);
    } else {
      // Plain text format
      return JSON.stringify(arg, null, 2);
    }
  } catch (e) {
    return String(arg);
  }
}

// Format all arguments of a log entry
function formatLogArgs(args, format = 'pretty') {
  return args.map(arg => formatArg(arg, format)).join(' ');
}

// Get preview text (first line, truncated)
function getPreview(args) {
  const text = args.map(arg => {
    if (typeof arg === 'string') return arg;
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  }).join(' ');

  return text.length > 60 ? text.substring(0, 60) + '...' : text;
}

// Format timestamp
function formatTimestamp(isoString) {
  const date = new Date(isoString);
  return date.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3
  });
}

// Syntax highlight JSON
function highlightJSON(json) {
  return json
    .replace(/"([^"]+)":/g, '<span class="json-key">"$1"</span>:')
    .replace(/: "([^"]*)"/g, ': <span class="json-string">"$1"</span>')
    .replace(/: (\d+\.?\d*)/g, ': <span class="json-number">$1</span>')
    .replace(/: (true|false)/g, ': <span class="json-boolean">$1</span>')
    .replace(/: (null)/g, ': <span class="json-null">$1</span>');
}

// Render logs to the container
function renderLogs(logs) {
  const container = document.getElementById('logContainer');
  const filters = getActiveFilters();

  const filteredLogs = logs.filter(log => filters.includes(log.level));

  if (filteredLogs.length === 0) {
    container.innerHTML = '<div class="empty-state">No logs captured yet</div>';
    document.getElementById('logCount').textContent = '0 logs';
    return;
  }

  container.innerHTML = filteredLogs.map((log, index) => {
    const formattedContent = formatLogArgs(log.args, currentFormat);
    const highlighted = currentFormat !== 'text' ? highlightJSON(formattedContent) : escapeHtml(formattedContent);

    return `
      <div class="log-entry" data-index="${index}">
        <div class="log-header" onclick="toggleLog(${index})">
          <span class="log-level ${log.level}">${log.level}</span>
          <span class="log-preview">${escapeHtml(getPreview(log.args))}</span>
          <span class="log-timestamp">${formatTimestamp(log.timestamp)}</span>
          <button class="copy-single" onclick="copySingleLog(event, ${index})" title="Copy this log">Copy</button>
        </div>
        <div class="log-body collapsed" id="log-body-${index}">
          ${highlighted}
          ${log.stack && log.level === 'error' ? `<div class="log-stack">${escapeHtml(log.stack)}</div>` : ''}
        </div>
      </div>
    `;
  }).join('');

  document.getElementById('logCount').textContent = `${filteredLogs.length} log${filteredLogs.length !== 1 ? 's' : ''}`;
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Get active filter levels
function getActiveFilters() {
  const filters = [];
  if (document.getElementById('filterLog').checked) filters.push('log');
  if (document.getElementById('filterInfo').checked) filters.push('info');
  if (document.getElementById('filterWarn').checked) filters.push('warn');
  if (document.getElementById('filterError').checked) filters.push('error');
  if (document.getElementById('filterDebug').checked) filters.push('debug');
  // Also include table, dir, dirxml under their base types
  filters.push('table', 'dir', 'dirxml');
  return filters;
}

// Toggle log body visibility
window.toggleLog = function(index) {
  const body = document.getElementById(`log-body-${index}`);
  if (body) {
    body.classList.toggle('collapsed');
  }
};

// Copy a single log entry
window.copySingleLog = async function(event, index) {
  event.stopPropagation();

  const filters = getActiveFilters();
  const filteredLogs = currentLogs.filter(log => filters.includes(log.level));
  const log = filteredLogs[index];

  if (!log) return;

  const text = formatLogForCopy(log);
  await copyToClipboard(text);
  showCopyStatus('Copied!');
};

// Format a log entry for copying
function formatLogForCopy(log) {
  const timestamp = formatTimestamp(log.timestamp);
  const level = log.level.toUpperCase().padEnd(5);
  const content = formatLogArgs(log.args, currentFormat);

  let result = `[${timestamp}] ${level} ${content}`;
  if (log.stack && log.level === 'error') {
    result += `\n${log.stack}`;
  }
  return result;
}

// Copy all logs to clipboard
async function copyAllLogs() {
  const filters = getActiveFilters();
  const filteredLogs = currentLogs.filter(log => filters.includes(log.level));

  if (filteredLogs.length === 0) {
    showCopyStatus('No logs to copy');
    return;
  }

  const text = filteredLogs.map(formatLogForCopy).join('\n\n');
  await copyToClipboard(text);
  showCopyStatus('Copied all logs!');
}

// Copy text to clipboard
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    // Fallback for older browsers
    const textarea = document.createElement('textarea');
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  }
}

// Show copy status message
function showCopyStatus(message) {
  const status = document.getElementById('copyStatus');
  status.textContent = message;
  setTimeout(() => {
    status.textContent = '';
  }, 2000);
}

// Refresh and render logs (only if changed)
async function refreshLogs() {
  const newLogs = await fetchLogs();

  // Only re-render if logs have changed
  if (JSON.stringify(newLogs) !== JSON.stringify(currentLogs)) {
    currentLogs = newLogs;
    renderLogs(currentLogs);
  }
}

// Initialize popup
async function init() {
  // Set up event listeners
  document.getElementById('copyBtn').addEventListener('click', copyAllLogs);
  document.getElementById('clearBtn').addEventListener('click', async () => {
    await clearLogs();
    currentLogs = [];
    renderLogs([]);
    showCopyStatus('Cleared!');
  });
  document.getElementById('refreshBtn').addEventListener('click', refreshLogs);

  // Filter checkboxes
  ['filterLog', 'filterInfo', 'filterWarn', 'filterError', 'filterDebug'].forEach(id => {
    document.getElementById(id).addEventListener('change', () => renderLogs(currentLogs));
  });

  // Format selector
  document.getElementById('formatSelect').addEventListener('change', (e) => {
    currentFormat = e.target.value;
    renderLogs(currentLogs);
  });

  // Initial load
  await refreshLogs();

  // Auto-refresh every 2 seconds
  setInterval(refreshLogs, 2000);
}

// Start
init();
