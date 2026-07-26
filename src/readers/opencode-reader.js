// src/readers/opencode-reader.js
//
// Reads OpenCode's local session storage via the `opencode` CLI.
//
// OpenCode's internal storage format (SQLite files under ~/.config/opencode/
// etc.) has changed before and may change again. The stable read surface is the
// `opencode` CLI: `session list --format json` and `export <id>` both return
// JSON matching the import/export contract this tool already uses.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

let DatabaseSync;
function getDatabaseSync() {
  if (DatabaseSync) return DatabaseSync;
  try {
    const require = createRequire(import.meta.url);
    ({ DatabaseSync } = require("node:sqlite"));
  } catch {
    // node:sqlite is only available in Node.js 22.5+. Fall back to CLI export.
  }
  return DatabaseSync;
}

function run(args, maxBytes = 100 * 1024 * 1024) {
  try {
    return execFileSync("opencode", args, {
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: maxBytes,
    })
      .toString()
      .trim();
  } catch (err) {
    const stderr = err.stderr?.toString() ?? "";
    const stdout = err.stdout?.toString() ?? "";
    throw new Error(
      `opencode ${args.join(" ")} failed: ${stderr || stdout || err.message}`
    );
  }
}

/**
 * Run an opencode subcommand whose stdout can be large and parse it from a
 * temp file. execFileSync's pipe buffer sometimes truncates multi-hundred-KB
 * JSON; writing straight to a file descriptor avoids that.
 */
function runToFile(args) {
  const tmpFile = path.join(os.tmpdir(), `agentbridge-${args.join("-")}-${Date.now()}.json`);
  const fd = fs.openSync(tmpFile, "w");
  try {
    execFileSync("opencode", args, {
      stdio: ["ignore", fd, "pipe"],
    });
  } catch (err) {
    const stderr = err.stderr?.toString() ?? "";
    throw new Error(`opencode ${args.join(" ")} failed: ${stderr || err.message}`);
  } finally {
    fs.closeSync(fd);
  }
  try {
    const content = fs.readFileSync(tmpFile, "utf8");
    fs.unlinkSync(tmpFile);
    return content;
  } catch (err) {
    throw new Error(`Failed to read opencode output from ${tmpFile}: ${err.message}`);
  }
}

/** List all OpenCode sessions, newest first (by `updated` time). */
export function listSessions() {
  const out = run(["session", "list", "--format", "json"]);
  const sessions = out ? JSON.parse(out) : [];
  if (!Array.isArray(sessions)) return [];
  return sessions
    .map((s) => ({
      id: s.id,
      title: s.title ?? "Untitled",
      directory: s.directory,
      created: s.created,
      updated: s.updated,
      session: exportSession(s.id),
    }))
    .sort((a, b) => b.updated - a.updated);
}

/** List OpenCode sessions whose directory matches the given project path. */
export function listSessionsForDir(dir) {
  const resolved = path.resolve(dir);
  return listSessions().filter((s) => s.directory === resolved);
}

/** Find the most recently updated OpenCode session. */
export function findLatestSession() {
  const sessions = listSessions();
  return sessions[0] ? { id: sessions[0].id, session: exportSession(sessions[0].id) } : null;
}

function openCodeDbPath() {
  const home = os.homedir();
  if (process.platform === "darwin" || process.platform === "linux") {
    return path.join(home, ".local", "share", "opencode", "opencode.db");
  }
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || home, "opencode", "opencode.db");
  }
  return path.join(home, ".local", "share", "opencode", "opencode.db");
}

/**
 * Read a session straight from OpenCode's SQLite database.
 *
 * This is a fallback / augmentation for `opencode export`. The CLI export has
 * proven unreliable in live situations (while the OpenCode server is running,
 * or when an imported session is continued): it can return empty parts, drop
 * imported messages, or only reflect the server's in-memory state. The SQLite
 * file is the durable source of truth, so reading it directly is more robust.
 *
 * Returns `null` if the database is unavailable, the schema is unexpected, or
 * the session is not found, so callers can fall back to CLI export.
 */
export function readSessionFromDatabase(sessionId, dbPathOverride) {
  const DatabaseSync = getDatabaseSync();
  if (!DatabaseSync) return null;
  const dbPath = dbPathOverride || openCodeDbPath();
  if (!fs.existsSync(dbPath)) return null;

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }

  try {
    // Message rows are stored as JSON blobs with a shape like:
    //   {"role":"user", "time":{"created":...}, "agent":..., "model":...}
    //   {"role":"assistant", "parentID":"...", "time":{...}, "tokens":...}
    // The `id` column is the message id, but it is not duplicated inside the
    // JSON blob, so we inject it as `info.id` (and `info.sessionID`, etc.) to
    // match the public export shape.
    const messageStmt = db.prepare(
      "SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id"
    );
    const messageRows = messageStmt.all(sessionId);
    if (messageRows.length === 0) return null;

    const partStmt = db.prepare(
      "SELECT id, message_id, data FROM part WHERE session_id = ? ORDER BY time_created, id"
    );
    const partRows = partStmt.all(sessionId);

    const partsByMessage = new Map();
    for (const p of partRows) {
      const list = partsByMessage.get(p.message_id) || [];
      const partData = JSON.parse(p.data);
      list.push({ ...partData, id: p.id, sessionID: sessionId, messageID: p.message_id });
      partsByMessage.set(p.message_id, list);
    }

    const messages = [];
    for (const row of messageRows) {
      const msgData = JSON.parse(row.data);
      const info = {
        id: row.id,
        sessionID: sessionId,
        ...msgData,
        time: msgData.time,
      };
      const parts = partsByMessage.get(row.id) || [];
      messages.push({ info, parts });
    }

    const sessionStmt = db.prepare(
      "SELECT id, title, directory, version, time_created, time_updated FROM session WHERE id = ?"
    );
    const sessionRow = sessionStmt.get(sessionId);
    if (!sessionRow) return null;

    const info = {
      id: sessionRow.id,
      title: sessionRow.title,
      directory: sessionRow.directory,
      version: sessionRow.version,
      time: {
        created: sessionRow.time_created,
        updated: sessionRow.time_updated,
      },
    };

    return { info, messages };
  } catch {
    // Schema or data shape changed; fall back to CLI export.
    return null;
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Export one OpenCode session as JSON (the same shape `opencode import` accepts).
 *
 * We prefer the SQLite database reader because the CLI `export` is lossy when
 * the OpenCode server is running or when an imported session is continued. The
 * CLI export is kept as a fallback for portability / future schema changes.
 */
export function exportSession(sessionId) {
  const fromDb = readSessionFromDatabase(sessionId);
  if (fromDb) return fromDb;
  const out = runToFile(["export", sessionId]);
  return JSON.parse(out);
}

/** Find a specific OpenCode session by id and export it. */
export function findSessionById(sessionId) {
  const s = listSessions().find((x) => x.id === sessionId);
  if (s) return { id: s.id, session: exportSession(s.id) };
  // OpenCode's session list can lag behind imports; try exporting directly.
  try {
    return { id: sessionId, session: exportSession(sessionId) };
  } catch {
    return null;
  }
}

/** Best-effort plain-text preview of a single OpenCode part. */
function previewText(part) {
  if (part.type === "text" && part.text) return part.text;
  if (part.type === "reasoning" && part.text) return part.text;
  if (part.type === "tool") return `[used tool: ${part.tool}]`;
  return "";
}

/**
 * Build a short, human-readable summary of an OpenCode session for browsing:
 * first user message, how many messages, when it was last touched.
 */
export function summarizeSession(session) {
  const messages = session.messages ?? [];
  const firstUser = messages.find((m) => m.info?.role === "user");
  const firstPart = firstUser?.parts?.find((p) => previewText(p));
  const firstLine = firstPart ? previewText(firstPart).split("\n")[0] : "(empty)";
  return {
    messageCount: messages.length,
    firstMessage: firstLine.slice(0, 120),
    lastTimestamp: session.info?.time?.updated ? new Date(session.info.time.updated).toISOString() : null,
    cwd: session.info?.directory ?? null,
  };
}

/** Render a full transcript preview (for `agentbridge show`). */
export function renderTranscript(session) {
  const lines = [];
  for (const m of session.messages ?? []) {
    const who = m.info?.role === "user" ? "You" : "OpenCode";
    for (const p of m.parts ?? []) {
      if (p.type === "text" && p.text) lines.push(`[${who}] ${p.text}`);
      else if (p.type === "reasoning" && p.text) lines.push(`[${who} thinking] ${p.text}`);
      else if (p.type === "tool") lines.push(`[${who}] → tool: ${p.tool}(${JSON.stringify(p.state?.input ?? {})})`);
      else if (p.type === "tool" && p.state?.output) lines.push(`[tool result] ${String(p.state.output).slice(0, 300)}`);
    }
  }
  return lines.join("\n");
}
