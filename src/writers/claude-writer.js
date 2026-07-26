// src/writers/claude-writer.js
//
// Writes a Claude Code JSONL transcript to the location Claude Code expects:
//   ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl

import fs from "node:fs";
import path from "node:path";
import { claudeProjectsDir, encodeProjectPath } from "../readers/claude-reader.js";

/**
 * Write an array of Claude Code entries as a JSONL session file.
 *
 * @param {object[]} entries - Claude Code JSONL entries
 * @param {string} [directory] - fallback cwd if the first entry has no cwd
 * @param {object} [opts]
 * @param {string} [opts.baseDir] - override the base `~/.claude/projects` path (used by tests)
 * @returns {{filePath:string, projectDir:string, sessionId:string}}
 */
export function writeClaudeSession(entries, directory, opts = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("No entries to write");
  }
  const sessionId = entries[0]?.sessionId;
  const cwd = entries[0]?.cwd || directory;
  if (!sessionId) {
    throw new Error("Entries are missing sessionId");
  }
  if (!cwd) {
    throw new Error("Entries are missing cwd and no directory was provided");
  }

  const projectDir = path.join(opts.baseDir || claudeProjectsDir(), encodeProjectPath(cwd));
  fs.mkdirSync(projectDir, { recursive: true });

  const filePath = path.join(projectDir, `${sessionId}.jsonl`);
  const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  fs.writeFileSync(filePath, lines);

  return { filePath, projectDir, sessionId };
}
