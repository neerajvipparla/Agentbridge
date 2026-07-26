// src/sync/sync.js
//
// Phase 2: bidirectional sync between Claude Code and OpenCode.
//
// Given a known session pair (Claude id ↔ OpenCode id) recorded in the ledger,
// this module reads the current state of both tools, compares each to the last
// synced state stored in the ledger, and merges only the new turns. The default
// strategy is "timestamp": new turns from both sides are appended and sorted
// by time. The "abort" strategy refuses when both sides have new turns.

import fs from "node:fs";
import path from "node:path";
import { convertToOpenCode } from "../converters/claude-to-opencode.js";
import { convertToClaude } from "../converters/opencode-to-claude.js";
import { parseSessionFile, toConversation, claudeProjectsDir, encodeProjectPath } from "../readers/claude-reader.js";
import { exportSession } from "../readers/opencode-reader.js";
import { writeClaudeSession } from "../writers/claude-writer.js";
import { importIntoOpenCode } from "../writers/opencode-import.js";
import { findMapping, readLedgerPair, commitFork } from "../ledger/git-ledger.js";

function toEpochMs(isoOrMs) {
  if (typeof isoOrMs === "number") return isoOrMs;
  const t = isoOrMs ? Date.parse(isoOrMs) : NaN;
  return Number.isFinite(t) ? t : 0;
}

function claudeTurnKey(entry) {
  // Use the entry uuid when available; fall back to a stable content hash for
  // matching the same logical turn across re-imports.
  return entry.uuid || `${entry.type}:${entry.timestamp}:${JSON.stringify(entry.message?.content)}`;
}

function opencodeTurnKey(msg) {
  return msg.info?.id || `${msg.info?.role}:${msg.info?.time?.created}:${JSON.stringify(msg.parts)}`;
}

function isNewTurn(currentList, lastKeys, keyFn) {
  return currentList.filter((item) => !lastKeys.has(keyFn(item)));
}

function normalizeCurrent(last) {
  return {
    claude: last.claudeEntries || last.claude || [],
    opencode: last.opencodeMessages || last.opencode?.messages || last.opencode || [],
  };
}

/**
 * Compute the new turns on each side since the last sync.
 *
 * @param {object} current - { claudeEntries, opencodeMessages }
 * @param {object} last - { claudeEntries, opencodeMessages } or { claude, opencode }
 * @returns {{ claudeNew: object[], opencodeNew: object[] }}
 */
export function diffSync(current, last) {
  const cur = normalizeCurrent(current);
  const lst = normalizeCurrent(last);

  const lastClaudeKeys = new Set(lst.claude.map(claudeTurnKey));
  const lastOpenCodeKeys = new Set(lst.opencode.map(opencodeTurnKey));

  return {
    claudeNew: isNewTurn(cur.claude, lastClaudeKeys, claudeTurnKey),
    opencodeNew: isNewTurn(cur.opencode, lastOpenCodeKeys, opencodeTurnKey),
  };
}

/**
 * Merge new turns from both sides into a single chronological sequence.
 * Returns the merged data in both tool-specific forms.
 *
 * @param {object} current - current state of both sides
 * @param {object} last - last synced state of both sides
 * @param {string} strategy - "timestamp" or "abort"
 * @param {object} opts - conversion options (directory, etc.)
 * @returns {{claudeEntries: object[], opencodeMessages: object[], claudeNew: object[], opencodeNew: object[]}}
 */
function mergeAbort(current, last, diff, opts) {
  const { claudeNew, opencodeNew } = diff;

  if (claudeNew.length > 0 && opencodeNew.length > 0) {
    const err = new Error(
      `Both sides have new turns since the last sync.\n` +
        `Claude: ${claudeNew.length} new turns. OpenCode: ${opencodeNew.length} new turns.\n` +
        `Run with --strategy timestamp to merge by timestamp, or resolve manually.`
    );
    err.claudeNew = claudeNew;
    err.opencodeNew = opencodeNew;
    throw err;
  }

  // Nothing to abort over - only one side changed (or neither). Merge normally.
  return mergeTimestamp(current, last, diff, opts);
}

/**
 * Merge new turns from both sides into a single sequence per side.
 *
 * @param {object} current - current state of both sides
 * @param {object} last - last synced state of both sides
 * @param {{claudeNew: object[], opencodeNew: object[]}} diff - from diffSync
 * @param {object} opts - conversion options (directory, etc.)
 * @returns {{claudeEntries: object[], opencodeMessages: object[], claudeNew: object[], opencodeNew: object[]}}
 */
function mergeTimestamp(current, last, diff, opts) {
  const { claudeNew, opencodeNew } = diff;
  const cur = normalizeCurrent(current);
  const lst = normalizeCurrent(last);

  // Always build the merged state from the last synced baseline, then add the
  // genuinely new turns. This protects against OpenCode's `export` returning a
  // partial or stale session (e.g. while the server is running, or when an
  // imported session loses its original messages after being continued). Using
  // the current state as the base would silently drop any history that OpenCode
  // failed to include.
  const mergedClaude = [...lst.claude];
  const mergedOpenCode = [...lst.opencode];

  // Preserve the original session ids across both tools so the merged output
  // continues to be written to the same Claude JSONL and the same OpenCode
  // session. Without this, converted turns would create a new session id and
  // `writeClaudeSession` / `importIntoOpenCode` would fork the conversation
  // instead of updating it in place.
  const claudeSessionId = lst.claude[0]?.sessionId || opts.claudeSessionId;
  const opencodeSessionId = lst.opencode[0]?.info?.sessionID || opts.opencodeId;

  // Add genuinely new turns reported by the current state.
  const existingClaudeKeys = new Set(mergedClaude.map(claudeTurnKey));
  for (const e of claudeNew) {
    const k = claudeTurnKey(e);
    if (!existingClaudeKeys.has(k)) {
      mergedClaude.push(e);
      existingClaudeKeys.add(k);
    }
  }
  const existingOpenCodeKeys = new Set(mergedOpenCode.map(opencodeTurnKey));
  for (const m of opencodeNew) {
    const k = opencodeTurnKey(m);
    if (!existingOpenCodeKeys.has(k)) {
      mergedOpenCode.push(m);
      existingOpenCodeKeys.add(k);
    }
  }

  // Fold Claude-only new turns into OpenCode.
  if (claudeNew.length > 0) {
    const newOpenCodeMessages = convertToOpenCode(claudeNew, {
      directory: opts.directory,
      title: opts.title ?? "Synced session",
      providerID: opts.providerID,
      agent: opts.agent,
      opencodeSessionId,
    }).messages;
    for (const m of newOpenCodeMessages) {
      if (!existingOpenCodeKeys.has(opencodeTurnKey(m))) {
        mergedOpenCode.push(m);
        existingOpenCodeKeys.add(opencodeTurnKey(m));
      }
    }
  }

  // Expand OpenCode-only new turns into Claude entries.
  if (opencodeNew.length > 0) {
    const newClaudeEntries = convertToClaude(
      { info: { id: opts.opencodeId || "placeholder", directory: opts.directory }, messages: opencodeNew },
      { directory: opts.directory, sessionId: claudeSessionId }
    );
    for (const e of newClaudeEntries) {
      if (!existingClaudeKeys.has(claudeTurnKey(e))) {
        mergedClaude.push(e);
        existingClaudeKeys.add(claudeTurnKey(e));
      }
    }
  }

  // Sort both merged representations by timestamp and recompute parent chains.
  // Claude: keep assistant + tool-result pairs together.
  const claudeWithGroups = [];
  for (let i = 0; i < mergedClaude.length; i++) {
    const e = mergedClaude[i];
    const next = mergedClaude[i + 1];
    if (e.type === "assistant" && next && next.type === "user" && next.parentUuid === e.uuid) {
      claudeWithGroups.push({ entries: [e, next], ts: toEpochMs(e.timestamp) });
      i++; // skip the paired result entry
    } else {
      claudeWithGroups.push({ entries: [e], ts: toEpochMs(e.timestamp) });
    }
  }
  claudeWithGroups.sort((a, b) => a.ts - b.ts);
  mergedClaude.length = 0;
  for (const g of claudeWithGroups) mergedClaude.push(...g.entries);

  let prevUuid = null;
  for (const e of mergedClaude) {
    e.parentUuid = prevUuid;
    prevUuid = e.uuid;
  }

  // OpenCode: sort by message creation time.
  mergedOpenCode.sort((a, b) => (a.info?.time?.created || 0) - (b.info?.time?.created || 0));
  let prevOpenCodeId = null;
  for (const m of mergedOpenCode) {
    m.info.parentID = prevOpenCodeId || m.info.sessionID;
    prevOpenCodeId = m.info.id;
  }

  return { claudeEntries: mergedClaude, opencodeMessages: mergedOpenCode, claudeNew, opencodeNew };
}

const STRATEGIES = {
  timestamp: mergeTimestamp,
  abort: mergeAbort,
};

/**
 * Merge new turns from both sides according to the given strategy.
 *
 * @param {object} current - current state of both sides
 * @param {object} last - last synced state of both sides
 * @param {string} strategy - one of the keys of STRATEGIES
 * @param {object} opts - conversion options (directory, etc.)
 * @returns {{claudeEntries: object[], opencodeMessages: object[], claudeNew: object[], opencodeNew: object[]}}
 */
export function mergeSync(current, last, strategy, opts = {}) {
  const diff = diffSync(current, last);
  const fn = STRATEGIES[strategy];
  if (!fn) {
    throw new Error(`Unknown strategy "${strategy}". Use one of: ${Object.keys(STRATEGIES).join(", ")}.`);
  }
  return fn(current, last, diff, opts);
}

/**
 * Load current state from both tools.
 *
 * @param {string} claudeFile - path to Claude JSONL
 * @param {string} opencodeId - OpenCode session id
 * @returns {{claudeEntries: object[], opencodeMessages: object[]}}
 */
export function loadCurrentState(claudeFile, opencodeId) {
  const claudeEntries = toConversation(parseSessionFile(claudeFile));
  const opencodeMessages = exportSession(opencodeId).messages || [];
  return { claudeEntries, opencodeMessages };
}

/**
 * Resolve a session id (Claude or OpenCode) to the paired ids using the ledger
 * mapping. If no id is provided, use the latest ledger commit.
 *
 * @returns {{claudeId: string, opencodeId: string} | null}
 */
export function resolveSessionPair(ledgerDir, sessionId, ledgerLog) {
  let sourceId = sessionId;
  if (!sourceId) {
    const entries = ledgerLog(ledgerDir, 1);
    if (entries.length === 0) return null;
    const m = entries[0].message.match(/fork [^:]+: ([^ ]+) /);
    sourceId = m ? m[1] : null;
  }
  if (!sourceId) return null;
  const isOpenCode = sourceId.startsWith("ses_");
  return findMapping(ledgerDir, isOpenCode ? { opencodeId: sourceId } : { claudeId: sourceId });
}

/**
 * Run a full bidirectional sync for a known session pair.
 *
 * @returns {{ok:boolean, changed?:boolean, claudeNew?:number, opencodeNew?:number, message?:string, error?:string, exitCode?:number}}
 */
export function syncSession({ ledgerDir, dir, claudeId, opencodeId, strategy, dryRun, provider, agent }) {
  const claudeProjectDir = path.join(claudeProjectsDir(), encodeProjectPath(dir));
  const claudeFile = path.join(claudeProjectDir, `${claudeId}.jsonl`);
  if (!fs.existsSync(claudeFile)) {
    return { ok: false, error: `Claude session file not found: ${claudeFile}`, exitCode: 1 };
  }

  const current = loadCurrentState(claudeFile, opencodeId);
  const last = readLedgerPair(ledgerDir, claudeId, opencodeId);
  if (!last.claude || !last.opencode) {
    return {
      ok: false,
      error: `Last synced state not found in the ledger for ${opencodeId}. Run a fork first.`,
      exitCode: 1,
    };
  }

  if (strategy !== "timestamp" && strategy !== "abort") {
    return { ok: false, error: `Unknown strategy "${strategy}". Use "timestamp" or "abort".`, exitCode: 1 };
  }

  let merged;
  try {
    merged = mergeSync(current, last, strategy, {
      directory: dir,
      title: last.opencode.info?.title || "Synced session",
      providerID: provider,
      agent,
      opencodeId,
    });
  } catch (err) {
    if (err.claudeNew && err.opencodeNew) {
      return {
        ok: false,
        error: err.message,
        claudeNew: err.claudeNew.length,
        opencodeNew: err.opencodeNew.length,
        exitCode: 2,
      };
    }
    throw err;
  }

  const cur = normalizeCurrent(current);
  const baseline = normalizeCurrent(last);
  const curClaudeKeys = new Set(cur.claude.map(claudeTurnKey));
  const curOpenCodeKeys = new Set(cur.opencode.map(opencodeTurnKey));
  const missingClaude = baseline.claude.some((e) => !curClaudeKeys.has(claudeTurnKey(e)));
  const missingOpenCode = baseline.opencode.some((m) => !curOpenCodeKeys.has(opencodeTurnKey(m)));

  if (merged.claudeNew.length === 0 && merged.opencodeNew.length === 0 && !missingClaude && !missingOpenCode) {
    return { ok: true, changed: false, message: "No changes on either side since the last sync." };
  }

  const openCodePayload = {
    info: {
      ...last.opencode.info,
      id: opencodeId,
      directory: dir,
      time: {
        created: last.opencode.info?.time?.created || Date.now(),
        updated: Date.now(),
      },
    },
    messages: merged.opencodeMessages,
  };

  if (dryRun) {
    return {
      ok: true,
      changed: true,
      claudeNew: merged.claudeNew.length,
      opencodeNew: merged.opencodeNew.length,
      message: `Dry run: computed merged state. ${merged.claudeEntries.length} Claude entries, ${merged.opencodeMessages.length} OpenCode messages.`,
    };
  }

  const { hash, changed } = commitFork(ledgerDir, {
    sessionId: opencodeId,
    claudeId,
    opencodeId,
    claudeSource: { data: merged.claudeEntries },
    opencodeSource: { data: openCodePayload },
    direction: "sync",
  });

  let message = changed
    ? `Ledger commit ${hash.slice(0, 10)} recorded at ${ledgerDir}`
    : `No changes since last sync (ledger already at ${hash.slice(0, 10)})`;

  try {
    const { filePath } = writeClaudeSession(merged.claudeEntries, dir);
    message += `\nWrote Claude session to ${filePath}`;
  } catch (err) {
    return { ok: false, error: err.message, exitCode: 1 };
  }

  try {
    const out = importIntoOpenCode(openCodePayload, { cwd: dir });
    message += `\n${out || `Synced OpenCode session ${opencodeId}`}`;
  } catch (err) {
    return { ok: false, error: err.message, exitCode: 1 };
  }

  return { ok: true, changed, claudeNew: merged.claudeNew.length, opencodeNew: merged.opencodeNew.length, message };
}
