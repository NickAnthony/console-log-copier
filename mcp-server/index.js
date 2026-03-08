import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import Database from 'better-sqlite3';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'console_logs.db');
const WS_PORT = parseInt(process.env.WS_PORT || '18462', 10);
const RETENTION_DAYS = 7;

// --- SQLite Setup ---

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tab_id INTEGER NOT NULL,
    url TEXT NOT NULL,
    title TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at TEXT,
    is_active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id),
    level TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    args TEXT NOT NULL,
    stack TEXT,
    filter_category TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_logs_session ON logs(session_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_url ON sessions(url);
  CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(is_active);
`);

// Prune old sessions on startup
db.prepare(`
  DELETE FROM logs WHERE session_id IN (
    SELECT id FROM sessions WHERE started_at < datetime('now', ?)
  )
`).run(`-${RETENTION_DAYS} days`);
db.prepare(`DELETE FROM sessions WHERE started_at < datetime('now', ?)`).run(`-${RETENTION_DAYS} days`);

// --- Prepared Statements ---

const stmts = {
  endActiveSessionsForTab: db.prepare(`
    UPDATE sessions SET is_active = 0, ended_at = datetime('now')
    WHERE tab_id = ? AND is_active = 1
  `),
  insertSession: db.prepare(`
    INSERT INTO sessions (tab_id, url, title) VALUES (?, ?, ?)
  `),
  insertLog: db.prepare(`
    INSERT INTO logs (session_id, level, timestamp, args, stack, filter_category)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  getActiveSessionForTab: db.prepare(`
    SELECT id FROM sessions WHERE tab_id = ? AND is_active = 1 ORDER BY id DESC LIMIT 1
  `),
  getLatestActiveSessionForUrl: db.prepare(`
    SELECT id, tab_id, url, title, started_at FROM sessions
    WHERE url LIKE '%' || ? || '%' AND is_active = 1
    ORDER BY id DESC LIMIT 1
  `),
  getLatestSessionForUrl: db.prepare(`
    SELECT id, tab_id, url, title, started_at, ended_at, is_active FROM sessions
    WHERE url LIKE '%' || ? || '%'
    ORDER BY id DESC LIMIT 1
  `),
  getLogsForSession: db.prepare(`
    SELECT id, level, timestamp, args, stack, filter_category FROM logs
    WHERE session_id = ? ORDER BY id ASC
  `),
  listActiveSessions: db.prepare(`
    SELECT s.id, s.tab_id, s.url, s.title, s.started_at,
           (SELECT COUNT(*) FROM logs WHERE session_id = s.id) as log_count
    FROM sessions s WHERE s.is_active = 1 ORDER BY s.id DESC
  `),
  getSessionHistory: db.prepare(`
    SELECT s.id, s.tab_id, s.url, s.title, s.started_at, s.ended_at, s.is_active,
           (SELECT COUNT(*) FROM logs WHERE session_id = s.id) as log_count
    FROM sessions s WHERE s.url LIKE '%' || ? || '%'
    ORDER BY s.id DESC LIMIT ?
  `),
  clearSessionsForUrl: db.prepare(`
    DELETE FROM logs WHERE session_id IN (
      SELECT id FROM sessions WHERE url LIKE '%' || ? || '%'
    )
  `),
  deleteSessionsForUrl: db.prepare(`
    DELETE FROM sessions WHERE url LIKE '%' || ? || '%'
  `),
  clearAllLogs: db.prepare(`DELETE FROM logs`),
  clearAllSessions: db.prepare(`DELETE FROM sessions`),
  getAllActiveTabIds: db.prepare(`
    SELECT DISTINCT tab_id FROM sessions WHERE is_active = 1
  `),
};

// --- Tab-to-Session mapping (in-memory cache for fast lookup) ---

const tabSessionMap = new Map(); // tabId -> sessionId

// Populate from DB on startup
for (const row of db.prepare(`SELECT tab_id, id FROM sessions WHERE is_active = 1`).all()) {
  tabSessionMap.set(row.tab_id, row.id);
}

// --- WebSocket Server ---

const wsClients = new Set();
const wss = new WebSocketServer({ port: WS_PORT });

wss.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // Another MCP server instance owns the WebSocket — this instance
    // still works for MCP tool queries against the shared SQLite DB.
    console.error(`WebSocket port ${WS_PORT} already in use, running in MCP-only mode`);
  } else {
    console.error('WebSocket server error:', err);
  }
});

function broadcastToExtension(message) {
  const data = JSON.stringify(message);
  for (const ws of wsClients) {
    if (ws.readyState === 1) { // OPEN
      ws.send(data);
    }
  }
}

wss.on('connection', (ws) => {
  wsClients.add(ws);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    handleExtensionMessage(msg);
  });

  ws.on('close', () => {
    wsClients.delete(ws);
  });
});

function handleExtensionMessage(msg) {
  switch (msg.type) {
    case 'NEW_SESSION': {
      const { tabId, url, title } = msg;
      stmts.endActiveSessionsForTab.run(tabId);
      const result = stmts.insertSession.run(tabId, url, title || null);
      tabSessionMap.set(tabId, result.lastInsertRowid);
      break;
    }

    case 'LOG': {
      const { tabId, log } = msg;
      let sessionId = tabSessionMap.get(tabId);
      if (!sessionId) {
        // No session yet for this tab — create one with unknown URL
        const result = stmts.insertSession.run(tabId, 'unknown', null);
        sessionId = result.lastInsertRowid;
        tabSessionMap.set(tabId, sessionId);
      }
      stmts.insertLog.run(
        sessionId,
        log.level,
        log.timestamp,
        JSON.stringify(log.args),
        log.stack || null,
        log.filterCategory || null
      );
      break;
    }

    case 'TAB_CLOSED': {
      const { tabId } = msg;
      stmts.endActiveSessionsForTab.run(tabId);
      tabSessionMap.delete(tabId);
      break;
    }

    case 'FULL_SYNC': {
      const { tabs } = msg;
      if (!tabs) break;

      const currentTabIds = new Set(Object.keys(tabs).map(Number));

      // End sessions for tabs no longer present
      for (const row of stmts.getAllActiveTabIds.all()) {
        if (!currentTabIds.has(row.tab_id)) {
          stmts.endActiveSessionsForTab.run(row.tab_id);
          tabSessionMap.delete(row.tab_id);
        }
      }

      // Sync each tab
      const syncTransaction = db.transaction(() => {
        for (const [tabIdStr, tabData] of Object.entries(tabs)) {
          const tabId = Number(tabIdStr);
          const existingSessionId = tabSessionMap.get(tabId);

          if (!existingSessionId) {
            // Create new session for this tab
            stmts.endActiveSessionsForTab.run(tabId);
            const result = stmts.insertSession.run(tabId, tabData.url || 'unknown', tabData.title || null);
            const newSessionId = result.lastInsertRowid;
            tabSessionMap.set(tabId, newSessionId);

            // Insert all logs
            if (tabData.logs && tabData.logs.length > 0) {
              for (const log of tabData.logs) {
                stmts.insertLog.run(
                  newSessionId,
                  log.level,
                  log.timestamp,
                  JSON.stringify(log.args),
                  log.stack || null,
                  log.filterCategory || null
                );
              }
            }
          }
          // If session already exists, skip — we already have these logs
        }
      });
      syncTransaction();
      break;
    }

    case 'LOGS_CLEARED': {
      const { tabId } = msg;
      const sessionId = tabSessionMap.get(tabId);
      if (sessionId) {
        db.prepare(`DELETE FROM logs WHERE session_id = ?`).run(sessionId);
        stmts.endActiveSessionsForTab.run(tabId);
        tabSessionMap.delete(tabId);
      }
      break;
    }
  }
}

// --- MCP Server ---

const server = new McpServer({
  name: 'console-log-server',
  version: '1.0.0',
});

server.tool(
  'get_console_logs',
  'Get console logs from the most recent page load session matching a URL. Use partial URLs like "localhost:2001".',
  {
    url: z.string().describe('URL or partial URL to match (e.g. "localhost:2001")'),
    level: z.string().optional().describe('Filter by log level: log, warn, error, info, debug, table, dir, dirxml, network'),
    search: z.string().optional().describe('Search string to filter log content'),
    limit: z.number().optional().default(200).describe('Max number of logs to return'),
  },
  ({ url, level, search, limit }) => {
    let session = stmts.getLatestActiveSessionForUrl.get(url);
    if (!session) {
      session = stmts.getLatestSessionForUrl.get(url);
    }

    if (!session) {
      return { content: [{ type: 'text', text: `No sessions found matching "${url}". Use list_active_pages to see available pages.` }] };
    }

    let logs = stmts.getLogsForSession.all(session.id);

    if (level) {
      logs = logs.filter(l => l.level === level);
    }
    if (search) {
      const lower = search.toLowerCase();
      logs = logs.filter(l => l.args.toLowerCase().includes(lower));
    }
    logs = logs.slice(0, limit);

    const formatted = logs.map(l => {
      const args = JSON.parse(l.args);
      const argsStr = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
      let line = `[${l.level.toUpperCase()}] ${l.timestamp} ${argsStr}`;
      if (l.stack) line += `\n  Stack: ${l.stack}`;
      return line;
    }).join('\n');

    const header = `Session: ${session.url} (started ${session.started_at})\nShowing ${logs.length} logs:\n`;
    return { content: [{ type: 'text', text: header + formatted }] };
  }
);

server.tool(
  'get_console_errors',
  'Get only error and network-level logs from the most recent page load session for a URL.',
  {
    url: z.string().describe('URL or partial URL to match'),
    limit: z.number().optional().default(50).describe('Max number of errors to return'),
  },
  ({ url, limit }) => {
    let session = stmts.getLatestActiveSessionForUrl.get(url);
    if (!session) {
      session = stmts.getLatestSessionForUrl.get(url);
    }

    if (!session) {
      return { content: [{ type: 'text', text: `No sessions found matching "${url}".` }] };
    }

    let logs = stmts.getLogsForSession.all(session.id);
    logs = logs.filter(l => l.level === 'error' || l.level === 'network');
    logs = logs.slice(0, limit);

    if (logs.length === 0) {
      return { content: [{ type: 'text', text: `No errors found for "${session.url}" (session started ${session.started_at}).` }] };
    }

    const formatted = logs.map(l => {
      const args = JSON.parse(l.args);
      const argsStr = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
      let line = `[${l.level.toUpperCase()}] ${l.timestamp} ${argsStr}`;
      if (l.stack) line += `\n  Stack: ${l.stack}`;
      return line;
    }).join('\n');

    const header = `Errors for: ${session.url} (started ${session.started_at})\n${logs.length} error(s):\n`;
    return { content: [{ type: 'text', text: header + formatted }] };
  }
);

server.tool(
  'list_active_pages',
  'List all pages with active sessions. Shows URL, title, log count, and session start time.',
  {},
  () => {
    const sessions = stmts.listActiveSessions.all();
    if (sessions.length === 0) {
      return { content: [{ type: 'text', text: 'No active pages. Make sure the Chrome extension is running and connected.' }] };
    }

    const lines = sessions.map(s =>
      `- ${s.url}${s.title ? ` "${s.title}"` : ''} — ${s.log_count} logs (since ${s.started_at})`
    );
    return { content: [{ type: 'text', text: `Active pages (${sessions.length}):\n${lines.join('\n')}` }] };
  }
);

server.tool(
  'get_session_history',
  'List recent page load sessions for a URL. Shows timestamps, log counts, and whether the session is still active.',
  {
    url: z.string().describe('URL or partial URL to match'),
    limit: z.number().optional().default(5).describe('Max number of sessions to return'),
  },
  ({ url, limit }) => {
    const sessions = stmts.getSessionHistory.all(url, limit);
    if (sessions.length === 0) {
      return { content: [{ type: 'text', text: `No sessions found matching "${url}".` }] };
    }

    const lines = sessions.map(s =>
      `- Session #${s.id}: ${s.url}${s.title ? ` "${s.title}"` : ''} — ${s.log_count} logs, started ${s.started_at}${s.ended_at ? `, ended ${s.ended_at}` : ' (active)'}${s.is_active ? ' [ACTIVE]' : ''}`
    );
    return { content: [{ type: 'text', text: `Session history for "${url}" (${sessions.length}):\n${lines.join('\n')}` }] };
  }
);

server.tool(
  'get_logs_by_session',
  'Get logs from a specific session ID (use get_session_history to find session IDs).',
  {
    session_id: z.number().describe('Session ID to get logs for'),
    level: z.string().optional().describe('Filter by log level'),
    search: z.string().optional().describe('Search string to filter log content'),
    limit: z.number().optional().default(200).describe('Max number of logs to return'),
  },
  ({ session_id, level, search, limit }) => {
    let logs = stmts.getLogsForSession.all(session_id);

    if (logs.length === 0) {
      return { content: [{ type: 'text', text: `No logs found for session #${session_id}.` }] };
    }

    if (level) {
      logs = logs.filter(l => l.level === level);
    }
    if (search) {
      const lower = search.toLowerCase();
      logs = logs.filter(l => l.args.toLowerCase().includes(lower));
    }
    logs = logs.slice(0, limit);

    const formatted = logs.map(l => {
      const args = JSON.parse(l.args);
      const argsStr = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
      let line = `[${l.level.toUpperCase()}] ${l.timestamp} ${argsStr}`;
      if (l.stack) line += `\n  Stack: ${l.stack}`;
      return line;
    }).join('\n');

    return { content: [{ type: 'text', text: `Session #${session_id} — ${logs.length} logs:\n${formatted}` }] };
  }
);

server.tool(
  'clear_logs',
  'Clear logs. If URL provided, clears sessions for that URL. Otherwise clears all. Also notifies the extension.',
  {
    url: z.string().optional().describe('URL to clear logs for. If omitted, clears all logs.'),
  },
  ({ url }) => {
    if (url) {
      const sessions = stmts.getSessionHistory.all(url, 100);
      const tabIds = [...new Set(sessions.map(s => s.tab_id))];

      stmts.clearSessionsForUrl.run(url);
      stmts.deleteSessionsForUrl.run(url);

      for (const tabId of tabIds) {
        tabSessionMap.delete(tabId);
        broadcastToExtension({ type: 'CLEAR_LOGS', tabId });
      }

      return { content: [{ type: 'text', text: `Cleared ${sessions.length} session(s) matching "${url}".` }] };
    } else {
      stmts.clearAllLogs.run();
      stmts.clearAllSessions.run();
      tabSessionMap.clear();
      broadcastToExtension({ type: 'CLEAR_ALL_LOGS' });
      return { content: [{ type: 'text', text: 'All logs cleared.' }] };
    }
  }
);

// --- Start ---

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`MCP Console Log Server running (WebSocket on port ${WS_PORT})`);
