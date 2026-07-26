// src/claude-reader.js
//
// Reads Claude Code's local session storage.
//
// Claude Code stores one JSONL file per session under:
//   ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl
// where <encoded-cwd> is the absolute working directory with "/" (and other
// path separators) replaced by "-".
//
// Each line is one JSON object ("entry"). The fields we rely on:
//   type          "user" | "assistant" | "summary" | ...
//   uuid          this entry's id
//   parentUuid    previous entry's id (linear chain, ignoring branches)
//   sessionId     the session this entry belongs to
//   timestamp     ISO-8601 string
//   isSidechain   true for subagent/background-task turns
//   isMeta        true for Claude Code's own system/meta messages
//   cwd           working directory Claude Code was run from
//   gitBranch     git branch at the time, if any
//   version       Claude Code version string
//   message       { role, content, model, usage, ... }
//     content is either a plain string or an array of content blocks:
//       { type: "text", text }
//       { type: "thinking", thinking }
//       { type: "tool_use", id, name, input }
//       { type: "tool_result", tool_use_id, content, is_error }
//   toolUseResult sometimes carries the raw tool result payload for a
//                 preceding tool_use (attached to the *next* "user" entry)

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export function claudeProjectsDir() {
  return path.join(os.homedir(), ".claude", "projects");
}

/**
 * Claude Code's own encoding of an absolute path into a directory name.
 *
 * Claude Code names each project directory after its absolute cwd with EVERY
 * non-alphanumeric character replaced by "-" (not just the path separators).
 * Dots, underscores, spaces, etc. all become "-", and runs are NOT collapsed:
 *   /Users/me/.config/my_app  ->  -Users-me--config-my-app
 * Verified against real directory names under ~/.claude/projects. An earlier
 * version replaced only "/" and "\", which silently found nothing for any
 * project whose path contained a ".", "_", space, or other punctuation.
 */
export function encodeProjectPath(absPath) {
  return absPath.replace(/[^a-zA-Z0-9]/g, "-");
}

/** Find the project directory for a given cwd, or null if none exists. */
export function findProjectDir(cwd = process.cwd()) {
  const base = claudeProjectsDir();
  const candidate = path.join(base, encodeProjectPath(path.resolve(cwd)));
  return fs.existsSync(candidate) ? candidate : null;
}

/** List session files (main sessions only, not agent-*.jsonl subagent files) for a project dir. */
export function listSessions(projectDir) {
  if (!fs.existsSync(projectDir)) return [];
  return fs
    .readdirSync(projectDir)
    .filter((f) => f.endsWith(".jsonl") && !f.startsWith("agent-"))
    .map((f) => {
      const full = path.join(projectDir, f);
      const stat = fs.statSync(full);
      return { id: f.replace(/\.jsonl$/, ""), file: full, mtime: stat.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime); // newest first
}

/** Find the most recently modified session for a project dir. */
export function findLatestSession(cwd = process.cwd()) {
  const dir = findProjectDir(cwd);
  if (!dir) return null;
  const sessions = listSessions(dir);
  return sessions[0] || null;
}

/** Locate a specific session by id, searching all projects if needed. */
export function findSessionById(sessionId, cwd = process.cwd()) {
  const dir = findProjectDir(cwd);
  if (dir) {
    const direct = path.join(dir, `${sessionId}.jsonl`);
    if (fs.existsSync(direct)) return { id: sessionId, file: direct };
  }
  // Fall back to scanning every project directory.
  const base = claudeProjectsDir();
  if (!fs.existsSync(base)) return null;
  for (const projectName of fs.readdirSync(base)) {
    const full = path.join(base, projectName, `${sessionId}.jsonl`);
    if (fs.existsSync(full)) return { id: sessionId, file: full };
  }
  return null;
}

/** Parse a session JSONL file into an ordered list of entries. Skips malformed lines. */
export function parseSessionFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const entries = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // Corrupt/partial line (e.g. a crash mid-write) - skip it rather than fail the whole fork.
    }
  }
  return entries;
}

/**
 * Reduce raw entries to the linear conversation Claude Code would render:
 * drop sidechains (subagent turns) and meta entries, keep user/assistant only.
 */
export function toConversation(entries) {
  return entries.filter(
    (e) => !e.isSidechain && !e.isMeta && (e.type === "user" || e.type === "assistant")
  );
}

/** List every project directory Claude Code has recorded sessions for. */
export function listAllProjectDirs() {
  const base = claudeProjectsDir();
  if (!fs.existsSync(base)) return [];
  return fs
    .readdirSync(base)
    .map((name) => path.join(base, name))
    .filter((full) => fs.statSync(full).isDirectory());
}

/** Best-effort plain-text preview of a single content block or string. */
function previewText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const textBlock = content.find((b) => b.type === "text" && b.text);
    if (textBlock) return textBlock.text;
    const toolBlock = content.find((b) => b.type === "tool_use");
    if (toolBlock) return `[used tool: ${toolBlock.name}]`;
  }
  return "";
}

/**
 * Build a short, human-readable summary of a session for browsing:
 * first user message, how many turns, when it was last touched.
 */
export function summarizeSession(entries) {
  const convo = toConversation(entries);
  const firstUser = convo.find((e) => e.type === "user");
  const lastEntry = convo[convo.length - 1];
  const firstLine = firstUser ? previewText(firstUser.message?.content).split("\n")[0] : "(empty)";
  return {
    messageCount: convo.length,
    firstMessage: firstLine.slice(0, 120),
    lastTimestamp: lastEntry?.timestamp ?? null,
    cwd: entries.find((e) => e.cwd)?.cwd ?? null,
    gitBranch: entries.find((e) => e.gitBranch)?.gitBranch ?? null,
  };
}

/** Render a full transcript preview (for `agentbridge show`). */
export function renderTranscript(entries) {
  const convo = toConversation(entries);
  const lines = [];
  for (const e of convo) {
    const who = e.type === "user" ? "You" : "Claude";
    const blocks = Array.isArray(e.message?.content) ? e.message.content : null;
    if (blocks) {
      for (const b of blocks) {
        if (b.type === "text" && b.text) lines.push(`[${who}] ${b.text}`);
        else if (b.type === "tool_use") lines.push(`[${who}] → tool: ${b.name}(${JSON.stringify(b.input)})`);
        else if (b.type === "tool_result") lines.push(`[tool result] ${previewText(b.content).slice(0, 300)}`);
        else if (b.type === "thinking") lines.push(`[${who} thinking] ${b.thinking}`);
      }
    } else if (typeof e.message?.content === "string" && e.message.content) {
      lines.push(`[${who}] ${e.message.content}`);
    }
  }
  return lines.join("\n");
}


