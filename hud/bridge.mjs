#!/usr/bin/env node
/**
 * Local read-only NDJSON bridge for the native macOS Context HUD.
 *
 * Directly imports the unmodified upstream `analyzer.mjs` engine so future
 * `git merge upstream/main` updates automatically flow into the HUD.
 *
 * Protocol:
 * - stdout: one JSON object per line whenever the active snapshot or recent
 *   session list changes.
 * - stdin:  optional NDJSON commands:
 *     {"cmd":"auto"}
 *     {"cmd":"select","id":"<conversation-uuid>"}
 *     {"cmd":"refresh"}
 *   Exits cleanly when stdin closes.
 */

import { openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import {
  ID_RE,
  analyzeConversation,
  listRecentConversations,
  statOf,
} from '../sidecars/context_panel/analyzer.mjs';

const POLL_MS = 1500;
const RECENT_LIMIT = 10;

let pinnedId = null;
let lastSig = '';
let busy = false;
let pendingForce = false;
let shuttingDown = false;

const titleCache = new Map(); // convId -> { fp, title }
const snapCache = new Map(); // convId -> { fp, data }
const summariesCache = new Map(); // appData -> { fp, map: Map<convId, { title, isSubagent, workspaceUris }> }

function loadConversationSummaries(appData) {
  const dbPath = join(appData, 'conversation_summaries.db');
  const st = statOf(dbPath);
  if (!st.isFile || st.size <= 0) return new Map();

  const walSt = statOf(`${dbPath}-wal`);
  const fp = `${st.mtime}:${st.size}|${walSt.mtime}:${walSt.size}`;
  const hit = summariesCache.get(appData);
  if (hit && hit.fp === fp) return hit.map;

  const map = new Map();
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db
      .prepare(
        'SELECT conversation_id, title, parent_conversation_id, nesting_depth, workspace_uris FROM conversation_summaries'
      )
      .all();
    for (const r of rows) {
      if (!r?.conversation_id) continue;
      let workspaceUris = [];
      if (typeof r.workspace_uris === 'string' && r.workspace_uris.startsWith('[')) {
        try {
          const parsed = JSON.parse(r.workspace_uris);
          if (Array.isArray(parsed)) workspaceUris = parsed.filter((u) => typeof u === 'string' && u);
        } catch {}
      }
      map.set(r.conversation_id, {
        title: typeof r.title === 'string' ? r.title.trim() : '',
        isSubagent: Boolean(r.parent_conversation_id) || Number(r.nesting_depth || 0) > 0,
        workspaceUris,
      });
    }
  } catch {
    // Gracefully fall back to transcript scanning if DB is unavailable
  } finally {
    try {
      db?.close();
    } catch {}
  }

  summariesCache.set(appData, { fp, map });
  return map;
}

function conversationFingerprint(appData, convId) {
  const db = statOf(join(appData, 'conversations', `${convId}.db`));
  const wal = statOf(join(appData, 'conversations', `${convId}.db-wal`));
  const logsDir = join(appData, 'brain', convId, '.system_generated', 'logs');
  const full = statOf(join(logsDir, 'transcript_full.jsonl'));
  const compact = statOf(join(logsDir, 'transcript.jsonl'));
  return `${db.mtime}:${db.size}|${wal.mtime}:${wal.size}|${full.mtime}:${full.size}|${compact.mtime}:${compact.size}`;
}

function readConversationTitle(appData, convId, summaries) {
  const summaryTitle = summaries?.get(convId)?.title;
  if (summaryTitle) return summaryTitle;

  const logPath = join(appData, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
  const st = statOf(logPath);
  if (!st.isFile || st.size <= 0) return convId.slice(0, 8);

  const fp = `${st.mtime}:${st.size}`;
  const hit = titleCache.get(convId);
  if (hit && hit.fp === fp) return hit.title;

  let title = convId.slice(0, 8);
  let fd;
  try {
    // Only read the first 16KB to find the opening USER_INPUT step quickly.
    const cap = Math.min(st.size, 16384);
    const buf = Buffer.allocUnsafe(cap);
    fd = openSync(logPath, 'r');
    const bytesRead = readSync(fd, buf, 0, cap, 0);
    const text = buf.subarray(0, bytesRead).toString('utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (obj?.type === 'USER_INPUT' && typeof obj.content === 'string') {
        const cleaned = obj.content
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (cleaned) {
          title = cleaned.length > 44 ? `${cleaned.slice(0, 44)}…` : cleaned;
          break;
        }
      }
    }
  } catch {
    // Keep short ID fallback
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
  }

  if (titleCache.size > 100) titleCache.clear();
  titleCache.set(convId, { fp, title });
  return title;
}

async function buildPayload() {
  // Fetch extra candidates so filtering out subagents still leaves RECENT_LIMIT real conversations.
  const allRaw = listRecentConversations(RECENT_LIMIT * 3);
  const summaryByAppData = new Map();
  const getSummaries = (appData) => {
    if (!summaryByAppData.has(appData)) {
      summaryByAppData.set(appData, loadConversationSummaries(appData));
    }
    return summaryByAppData.get(appData);
  };

  const recentRaw = allRaw
    .filter((item) => !getSummaries(item.appData).get(item.id)?.isSubagent)
    .slice(0, RECENT_LIMIT);

  const recent = recentRaw.map((item) => ({
    id: item.id,
    title: readConversationTitle(item.appData, item.id, getSummaries(item.appData)),
    mtime: Math.round(item.mtime),
  }));

  let target = null;
  if (pinnedId && ID_RE.test(pinnedId)) {
    target = recentRaw.find((r) => r.id === pinnedId) || allRaw.find((r) => r.id === pinnedId) || null;
  }
  if (!target) {
    target = recentRaw[0] || allRaw[0] || null;
  }

  if (!target) {
    return {
      found: false,
      mode: pinnedId ? 'pinned' : 'auto',
      pinnedId,
      recent,
      updatedAt: Date.now(),
    };
  }

  const targetSummary = getSummaries(target.appData).get(target.id);
  const workspaceUris = targetSummary?.workspaceUris || [];
  const fp = `${conversationFingerprint(target.appData, target.id)}|${workspaceUris.join(',')}`;
  let snap;
  const cachedSnap = snapCache.get(target.id);
  if (cachedSnap && cachedSnap.fp === fp) {
    snap = cachedSnap.data;
  } else {
    snap = await analyzeConversation(target.appData, target.id, { workspaceUris });
    if (snap.found) {
      if (snapCache.size > 20) snapCache.clear();
      snapCache.set(target.id, { fp, data: snap });
    }
  }
  if (!snap.found) {
    return {
      found: false,
      mode: pinnedId ? 'pinned' : 'auto',
      pinnedId,
      recent,
      updatedAt: Date.now(),
    };
  }

  const contextLimit = snap.contextLimit || 512000;
  const usedTokens = snap.usedTokens || 0;
  const freeSpace = Math.max(0, contextLimit - usedTokens);
  const percent = contextLimit > 0 ? Math.min(100, (usedTokens / contextLimit) * 100) : 0;

  const cats = snap.categories || {};
  const breakdown = [
    { key: 'toolCalls', label: 'Tool Calls', tokens: cats.toolCalls || 0, color: '#38bdf8' },
    { key: 'system', label: 'System & Tools', tokens: (cats.systemPrompt || 0) + (cats.systemTools || 0) + (cats.systemMessages || 0), color: '#a78bfa' },
    { key: 'agent', label: 'Agent & Thinking', tokens: cats.agentResponses || 0, color: '#34d399' },
    { key: 'messages', label: 'User Messages', tokens: cats.messages || 0, color: '#fbbf24' },
    { key: 'mcp', label: 'MCP Tools', tokens: (cats.mcpTools || 0) + (cats.mcpInstructions || 0), color: '#f472b6' },
    { key: 'skillsRules', label: 'Skills & Rules', tokens: (cats.skills || 0) + (cats.rulesFiles || 0) + (cats.customAgents || 0), color: '#fb923c' },
  ].filter((c) => c.tokens > 0);

  return {
    found: true,
    mode: pinnedId ? 'pinned' : 'auto',
    pinnedId,
    conversationId: target.id,
    title: readConversationTitle(target.appData, target.id, getSummaries(target.appData)),
    modelId: snap.model?.id || '',
    modelLabel: snap.model?.label || 'Unknown Model',
    usedTokens,
    contextLimit,
    freeSpace,
    percent: Number(percent.toFixed(1)),
    limitSource: snap.limitSource || 'antigravity',
    cacheHitRatio: Number((snap.cache?.cacheHitRatio || 0).toFixed(1)),
    sessionCacheHitRatio: Number((snap.cache?.sessionCacheHitRatio || 0).toFixed(1)),
    compactionCount: snap.compaction?.count || 0,
    totalSavedTokens: snap.compaction?.totalSavedTokens || 0,
    stepCount: snap.stepCount || 0,
    breakdown,
    recent,
    updatedAt: Date.now(),
  };
}

function signatureOf(payload) {
  return JSON.stringify({
    found: payload.found,
    mode: payload.mode,
    id: payload.conversationId,
    model: payload.modelLabel,
    used: payload.usedTokens,
    limit: payload.contextLimit,
    cache: payload.cacheHitRatio,
    scache: payload.sessionCacheHitRatio,
    comp: payload.compactionCount,
    steps: payload.stepCount,
    recent: payload.recent?.map((r) => `${r.id}:${r.mtime}`),
  });
}

async function tick(force = false) {
  if (busy) {
    if (force) pendingForce = true;
    return;
  }
  busy = true;
  try {
    const payload = await buildPayload();
    const sig = signatureOf(payload);
    if (force || sig !== lastSig) {
      lastSig = sig;
      process.stdout.write(`${JSON.stringify(payload)}\n`);
    }
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ found: false, error: String(err?.message || err) })}\n`);
  } finally {
    busy = false;
    if (shuttingDown) {
      process.exit(0);
    }
    if (pendingForce) {
      pendingForce = false;
      setImmediate(() => tick(true));
    }
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const msg = JSON.parse(trimmed);
    if (msg.cmd === 'auto') {
      pinnedId = null;
      tick(true);
    } else if (msg.cmd === 'select' && typeof msg.id === 'string' && ID_RE.test(msg.id)) {
      pinnedId = msg.id;
      tick(true);
    } else if (msg.cmd === 'refresh') {
      tick(true);
    }
  } catch {
    // ignore malformed command
  }
});
rl.on('close', () => {
  shuttingDown = true;
  if (!busy) process.exit(0);
});

tick(true);
setInterval(() => tick(false), POLL_MS);
