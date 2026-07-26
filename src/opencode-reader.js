// src/opencode-reader.js
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

/** Export one OpenCode session as JSON (the same shape `opencode import` accepts). */
export function exportSession(sessionId) {
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
