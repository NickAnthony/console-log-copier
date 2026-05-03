// Popup script for Console Log Copier.

let currentLogs = [];
let currentVisibleLogs = [];
let currentFormat = 'pretty';
let currentSearch = '';
let currentSignature = '';

// Sends extension messages with lastError handling so closed workers do not strand the popup.
function sendRuntimeMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || {});
    });
  });
}

// Gets the active tab for all popup actions.
async function getCurrentTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

// Fetches captured logs for the active tab from the background cache.
async function fetchLogs() {
  const tabId = await getCurrentTabId();
  if (!tabId) return [];
  const response = await sendRuntimeMessage({ type: 'GET_LOGS', tabId });
  return Array.isArray(response.logs) ? response.logs : [];
}

// Fetches listener health and current count without pulling the full log payload.
async function fetchListenerStatus() {
  const tabId = await getCurrentTabId();
  if (!tabId) return null;
  return sendRuntimeMessage({ type: 'GET_LISTENER_STATUS', tabId });
}

// Requests a clean listener reinstall in the active tab.
async function reattachListener() {
  const tabId = await getCurrentTabId();
  if (!tabId) return { success: false, error: 'No active tab' };
  return sendRuntimeMessage({ type: 'REATTACH_LISTENER', tabId });
}

// Clears active-tab logs in the background worker and MCP bridge.
async function clearLogs() {
  const tabId = await getCurrentTabId();
  if (!tabId) return false;
  const response = await sendRuntimeMessage({ type: 'CLEAR_LOGS', tabId });
  return Boolean(response.success);
}

// Creates a cheap change signature so refreshes do not stringify every log.
function getLogsSignature(logs) {
  if (logs.length === 0) return '0';
  const last = logs[logs.length - 1];
  return [
    logs.length,
    last.timestamp || '',
    last.level || '',
    last.preview || '',
    last.attachId || ''
  ].join('|');
}

// Formats one console argument for expanded display or copy output.
function formatArg(arg, format = 'pretty') {
  if (arg === null) return 'null';
  if (arg === undefined) return 'undefined';
  if (typeof arg === 'string') return arg;
  try {
    if (format === 'compact') return JSON.stringify(arg);
    return JSON.stringify(arg, null, 2);
  } catch {
    return String(arg);
  }
}

// Formats a log's arguments only when the user expands or copies it.
function formatLogArgs(args, format = 'pretty') {
  return (args || []).map(arg => formatArg(arg, format)).join(' ');
}

// Gets the stored preview or computes a fallback for older captured entries.
function getPreview(log) {
  if (log.preview) return log.preview;
  const text = (log.args || []).map(arg => {
    if (typeof arg === 'string') return arg;
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  }).join(' ');
  return text.length > 120 ? `${text.substring(0, 120)}...` : text;
}

// Formats timestamps compactly for row headers.
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

// Highlights JSON-like expanded bodies without touching escaped row headers.
function highlightJSON(json) {
  return escapeHtml(json)
    .replace(/"([^"]+)":/g, '<span class="json-key">"$1"</span>:')
    .replace(/: "([^"]*)"/g, ': <span class="json-string">"$1"</span>')
    .replace(/: (\d+\.?\d*)/g, ': <span class="json-number">$1</span>')
    .replace(/: (true|false)/g, ': <span class="json-boolean">$1</span>')
    .replace(/: (null)/g, ': <span class="json-null">$1</span>');
}

// Escapes text for safe HTML injection.
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = String(text);
  return div.innerHTML;
}

// Gets the enabled level filters from the toolbar.
function getActiveFilters() {
  const filters = [];
  if (document.getElementById('filterLog').checked) filters.push('log');
  if (document.getElementById('filterInfo').checked) filters.push('info');
  if (document.getElementById('filterWarn').checked) filters.push('warn');
  if (document.getElementById('filterError').checked) filters.push('error');
  if (document.getElementById('filterDebug').checked) filters.push('debug');
  if (document.getElementById('filterNetwork').checked) filters.push('network');
  filters.push('table', 'dir', 'dirxml');
  return filters;
}

const categoryIds = ['categoryReact', 'categoryFramework', 'categoryBundler', 'categoryDevtools'];
const categoryAllId = 'categoryAll';
const categoryMap = {
  categoryReact: 'react',
  categoryFramework: 'framework',
  categoryBundler: 'bundler',
  categoryDevtools: 'devtools',
};

// Gets the enabled noise-source filters from the toolbar.
function getActiveCategories() {
  const active = [];
  for (const id of categoryIds) {
    if (document.getElementById(id).checked) active.push(categoryMap[id]);
  }
  return active;
}

// Checks visible fields for the popup search box.
function matchesSearch(log, query) {
  if (!query) return true;
  const lower = query.toLowerCase();
  if ((log.level || '').toLowerCase().includes(lower)) return true;
  if ((log.preview || '').toLowerCase().includes(lower)) return true;
  if ((log.sourceUrl || '').toLowerCase().includes(lower)) return true;
  for (const arg of log.args || []) {
    const text = typeof arg === 'string' ? arg : String(JSON.stringify(arg));
    if (text.toLowerCase().includes(lower)) return true;
  }
  return false;
}

// Applies level, category, and search filters to the current log cache.
function getVisibleLogs() {
  const filters = getActiveFilters();
  const activeCategories = getActiveCategories();
  return currentLogs.filter(log => {
    if (!filters.includes(log.level)) return false;
    if (log.filterCategory && !activeCategories.includes(log.filterCategory)) return false;
    return matchesSearch(log, currentSearch);
  });
}

// Renders lightweight row shells immediately and defers heavy bodies until expansion.
function renderLogs() {
  const container = document.getElementById('logContainer');
  currentVisibleLogs = getVisibleLogs();

  if (currentVisibleLogs.length === 0) {
    container.innerHTML = '<div class="empty-state">No logs captured yet</div>';
    updateLogCount(0);
    return;
  }

  container.innerHTML = currentVisibleLogs.map((log, index) => {
    const categoryBadge = log.filterCategory
      ? `<span class="log-category ${escapeHtml(log.filterCategory)}">${escapeHtml(log.filterCategory)}</span>`
      : '';
    const sourceTitle = log.sourceUrl ? ` title="${escapeHtml(log.sourceUrl)}"` : '';
    return `
      <div class="log-entry" data-index="${index}">
        <div class="log-header" onclick="toggleLog(${index})"${sourceTitle}>
          <span class="log-level ${escapeHtml(log.level)}">${escapeHtml(log.level)}</span>
          ${categoryBadge}
          <span class="log-preview">${escapeHtml(getPreview(log))}</span>
          <span class="log-timestamp">${escapeHtml(formatTimestamp(log.timestamp))}</span>
          <button class="copy-single" onclick="copySingleLog(event, ${index})" title="Copy this log">Copy</button>
        </div>
        <div class="log-body collapsed" id="log-body-${index}" data-rendered="false"></div>
      </div>
    `;
  }).join('');

  updateLogCount(currentVisibleLogs.length);
}

// Renders an expanded row body only once per format mode.
function renderLogBody(index) {
  const body = document.getElementById(`log-body-${index}`);
  const log = currentVisibleLogs[index];
  if (!body || !log) return;
  if (body.dataset.rendered === currentFormat) return;
  const formattedContent = formatLogArgs(log.args, currentFormat);
  const content = currentFormat !== 'text' ? highlightJSON(formattedContent) : escapeHtml(formattedContent);
  const stack = log.stack && log.level === 'error'
    ? `<div class="log-stack">${escapeHtml(log.stack)}</div>`
    : '';
  const source = log.sourceUrl
    ? `<div class="log-stack">Source: ${escapeHtml(log.sourceUrl)}</div>`
    : '';
  body.innerHTML = `${content}${stack}${source}`;
  body.dataset.rendered = currentFormat;
}

// Updates the footer count independently from full row rendering.
function updateLogCount(count) {
  document.getElementById('logCount').textContent = `${count} log${count !== 1 ? 's' : ''}`;
}

window.toggleLog = function(index) {
  const body = document.getElementById(`log-body-${index}`);
  if (!body) return;
  renderLogBody(index);
  body.classList.toggle('collapsed');
};

window.copySingleLog = async function(event, index) {
  event.stopPropagation();
  const log = currentVisibleLogs[index];
  if (!log) return;
  await copyToClipboard(formatLogForCopy(log));
  showCopyStatus('Copied!');
};

// Formats one log for clipboard copy.
function formatLogForCopy(log) {
  const timestamp = formatTimestamp(log.timestamp);
  const level = log.level.toUpperCase().padEnd(5);
  const content = formatLogArgs(log.args, currentFormat);
  let result = `[${timestamp}] ${level} ${content}`;
  if (log.stack && log.level === 'error') result += `\n${log.stack}`;
  if (log.sourceUrl) result += `\nSource: ${log.sourceUrl}`;
  return result;
}

// Copies the currently visible logs.
async function copyAllLogs() {
  if (currentVisibleLogs.length === 0) {
    showCopyStatus('No logs to copy');
    return;
  }
  const text = currentVisibleLogs.map(formatLogForCopy).join('\n');
  await copyToClipboard(text);
  showCopyStatus('Copied all logs!');
}

// Writes text to the clipboard with a DOM fallback.
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  }
}

// Shows short action feedback in the popup footer.
function showCopyStatus(message) {
  const status = document.getElementById('copyStatus');
  status.textContent = message;
  setTimeout(() => {
    status.textContent = '';
  }, 2000);
}

// Updates listener health UI from the background worker heartbeat state.
async function refreshListenerStatus() {
  const response = await fetchListenerStatus();
  const statusEl = document.getElementById('listenerStatus');
  if (!response || response.error) {
    statusEl.textContent = 'listener unknown';
    statusEl.dataset.state = 'unknown';
    return response;
  }
  if (Number.isFinite(response.logCount)) {
    updateLogCount(response.logCount);
  }
  const status = response.status;
  if (!status) {
    statusEl.textContent = 'listener not seen';
    statusEl.dataset.state = 'unknown';
    return response;
  }
  const ageMs = Date.now() - Date.parse(status.timestamp || 0);
  const stale = !Number.isFinite(ageMs) || ageMs > 15000;
  statusEl.textContent = stale ? 'listener stale' : `listener ${status.status}`;
  statusEl.dataset.state = stale ? 'stale' : status.status;
  return response;
}

// Refreshes logs using a cheap signature so large batches do not freeze every popup open.
async function refreshLogs() {
  const newLogs = await fetchLogs();
  const nextSignature = getLogsSignature(newLogs);
  if (nextSignature !== currentSignature) {
    currentLogs = newLogs;
    currentSignature = nextSignature;
    renderLogs();
  } else {
    updateLogCount(getVisibleLogs().length);
  }
}

// Polls cheap metadata first and pulls full logs only when new data exists.
async function refreshIfChanged() {
  const response = await refreshListenerStatus();
  if (!response || response.error) return;
  if (response.signature !== currentSignature) {
    await refreshLogs();
  }
}

// Wires popup controls and loads initial state.
async function init() {
  document.getElementById('copyBtn').addEventListener('click', copyAllLogs);
  document.getElementById('clearBtn').addEventListener('click', async () => {
    await clearLogs();
    currentLogs = [];
    currentVisibleLogs = [];
    currentSignature = '';
    renderLogs();
    showCopyStatus('Cleared!');
  });
  document.getElementById('refreshBtn').addEventListener('click', async () => {
    await refreshLogs();
    await refreshListenerStatus();
  });
  document.getElementById('reattachBtn').addEventListener('click', async () => {
    const button = document.getElementById('reattachBtn');
    button.disabled = true;
    button.classList.add('is-busy');
    const result = await reattachListener();
    await refreshListenerStatus();
    button.disabled = false;
    button.classList.remove('is-busy');
    showCopyStatus(result.success ? 'Listener repaired' : `Repair failed: ${result.error || 'unknown'}`);
  });

  const searchInput = document.getElementById('searchInput');
  const searchClear = document.getElementById('searchClear');
  let searchTimeout;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      currentSearch = searchInput.value;
      searchClear.classList.toggle('visible', currentSearch.length > 0);
      renderLogs();
    }, 150);
  });
  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    currentSearch = '';
    searchClear.classList.remove('visible');
    renderLogs();
    searchInput.focus();
  });

  const filterIds = ['filterLog', 'filterInfo', 'filterWarn', 'filterError', 'filterDebug', 'filterNetwork'];
  filterIds.forEach(id => {
    document.getElementById(id).addEventListener('change', () => {
      const filters = {};
      filterIds.forEach(fid => {
        filters[fid] = document.getElementById(fid).checked;
      });
      chrome.storage.local.set({ filters });
      renderLogs();
    });
  });

  function saveCategoryFilters() {
    const catFilters = {};
    categoryIds.forEach(id => {
      catFilters[id] = document.getElementById(id).checked;
    });
    chrome.storage.local.set({ categoryFilters: catFilters });
  }

  function updateCategoryAllState() {
    const allEl = document.getElementById(categoryAllId);
    const states = categoryIds.map(id => document.getElementById(id).checked);
    const allChecked = states.every(Boolean);
    const someChecked = states.some(Boolean);
    allEl.checked = allChecked;
    allEl.indeterminate = !allChecked && someChecked;
  }

  categoryIds.forEach(id => {
    document.getElementById(id).addEventListener('change', () => {
      updateCategoryAllState();
      saveCategoryFilters();
      renderLogs();
    });
  });

  document.getElementById(categoryAllId).addEventListener('change', () => {
    const checked = document.getElementById(categoryAllId).checked;
    categoryIds.forEach(id => {
      document.getElementById(id).checked = checked;
    });
    document.getElementById(categoryAllId).indeterminate = false;
    saveCategoryFilters();
    renderLogs();
  });

  document.getElementById('formatSelect').addEventListener('change', (event) => {
    currentFormat = event.target.value;
    chrome.storage.local.set({ format: currentFormat });
    document.querySelectorAll('.log-body').forEach(body => {
      body.dataset.rendered = 'false';
      if (!body.classList.contains('collapsed')) {
        renderLogBody(Number(body.id.replace('log-body-', '')));
      }
    });
  });

  const stored = await chrome.storage.local.get(['format', 'filters', 'categoryFilters']);
  if (stored.format) {
    currentFormat = stored.format;
    document.getElementById('formatSelect').value = currentFormat;
  }
  if (stored.filters) {
    Object.entries(stored.filters).forEach(([id, checked]) => {
      const el = document.getElementById(id);
      if (el) el.checked = checked;
    });
  }
  if (stored.categoryFilters) {
    Object.entries(stored.categoryFilters).forEach(([id, checked]) => {
      const el = document.getElementById(id);
      if (el) el.checked = checked;
    });
  } else {
    categoryIds.forEach(id => {
      document.getElementById(id).checked = false;
    });
  }
  updateCategoryAllState();

  await refreshIfChanged();
  setInterval(refreshIfChanged, 1000);
}

document.addEventListener('DOMContentLoaded', init);
