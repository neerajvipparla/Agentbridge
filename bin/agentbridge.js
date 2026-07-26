#!/usr/bin/env node
import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";

import {
  findLatestSession as findLatestClaudeSession,
  findSessionById as findClaudeSessionById,
  findProjectDir,
  listSessions as listClaudeSessions,
  listAllProjectDirs,
  parseSessionFile,
  toConversation,
  summarizeSession as summarizeClaudeSession,
  renderTranscript as renderClaudeTranscript,
  claudeProjectsDir,
  encodeProjectPath,
} from "../src/readers/claude-reader.js";
import {
  findLatestSession as findLatestOpenCodeSession,
  findSessionById as findOpenCodeSessionById,
  listSessions as listOpenCodeSessions,
  listSessionsForDir as listOpenCodeSessionsForDir,
  summarizeSession as summarizeOpenCodeSession,
  renderTranscript as renderOpenCodeTranscript,
} from "../src/readers/opencode-reader.js";
import { convertToOpenCode } from "../src/converters/claude-to-opencode.js";
import { convertToClaude } from "../src/converters/opencode-to-claude.js";
import { importIntoOpenCode } from "../src/writers/opencode-import.js";
import { writeClaudeSession } from "../src/writers/claude-writer.js";
import { ledgerPath, commitFork, log as ledgerLog } from "../src/ledger/git-ledger.js";
import { syncSession, resolveSessionPair } from "../src/sync/sync.js";
import { watchSession, waitForInterrupt } from "../src/sync/watch.js";

const program = new Command();

program
  .name("agentbridge")
  .description("Fork chat sessions between Claude Code and OpenCode, recorded as local git commits.")
  .version("0.1.0");

function resolveSource(sessionId, explicit) {
  if (explicit) {
    if (explicit !== "claude" && explicit !== "opencode") {
      throw new Error(`Unknown source "${explicit}". Use "claude" or "opencode".`);
    }
    return explicit;
  }
  // Auto-detect: OpenCode session ids start with "ses_".
  if (sessionId && sessionId.startsWith("ses_")) return "opencode";
  return "claude";
}

function renderClaudeList(rows, showCwd) {
  if (rows.length === 0) {
    console.log("No non-empty sessions found.");
    return;
  }
  for (const r of rows) {
    const when = new Date(r.mtime).toLocaleString();
    console.log(`${r.id}`);
    console.log(`  ${when}  ·  ${r.messageCount} messages${showCwd ? `  ·  ${r.cwd}` : ""}`);
    console.log(`  "${r.firstMessage}"`);
    console.log("");
  }
}

function renderOpenCodeList(rows) {
  if (rows.length === 0) {
    console.log("No OpenCode sessions found.");
    return;
  }
  for (const r of rows) {
    const when = new Date(r.updated).toLocaleString();
    console.log(`${r.id}`);
    console.log(`  ${when}  ·  ${r.messageCount} messages  ·  ${r.cwd}`);
    console.log(`  "${r.firstMessage}"`);
    console.log("");
  }
}

program
  .command("list")
  .alias("ls")
  .description("List sessions you can fork, newest first")
  .option("-d, --dir <path>", "project directory (defaults to cwd for Claude; omitted = all for OpenCode)")
  .option("-a, --all", "list sessions across every project Claude Code has seen, not just this one", false)
  .option("-s, --source <tool>", 'source tool: "claude" or "opencode" (defaults to claude)')
  .action((opts) => {
    const source = opts.source || "claude";
    if (source === "opencode") {
      const sessions = opts.dir
        ? listOpenCodeSessionsForDir(path.resolve(opts.dir))
        : listOpenCodeSessions();
      const rows = sessions
        .map((s) => ({
          ...s,
          ...summarizeOpenCodeSession(s.session),
        }))
        .filter((r) => r.messageCount > 0);
      renderOpenCodeList(rows);
      console.log(`Preview one in full with:  agentbridge show <session-id> -s opencode`);
      console.log(`Fork one to Claude Code with: agentbridge fork <session-id> -s opencode`);
      return;
    }

    const searchDir = opts.dir ? path.resolve(opts.dir) : process.cwd();
    const targets = opts.all
      ? listAllProjectDirs()
      : (() => {
          const dir = findProjectDir(searchDir);
          return dir ? [dir] : [];
        })();

    if (targets.length === 0) {
      console.log(
        opts.all
          ? "No Claude Code sessions found anywhere under ~/.claude/projects."
          : `No Claude Code sessions found for ${searchDir}. Try --all to search every project, or run \`claude\` here first.`
      );
      return;
    }

    const rows = [];
    for (const dir of targets) {
      for (const session of listClaudeSessions(dir)) {
        const entries = parseSessionFile(session.file);
        const summary = summarizeClaudeSession(entries);
        if (summary.messageCount === 0) continue;
        rows.push({ ...session, ...summary });
      }
    }
    rows.sort((a, b) => b.mtime - a.mtime);

    renderClaudeList(rows, opts.all);
    console.log(`Preview one in full with:  agentbridge show <session-id>${opts.all ? " --all" : ""}`);
    console.log(`Fork one to OpenCode with: agentbridge fork <session-id>`);
  });

program
  .command("show")
  .description("Print the full transcript of a session")
  .argument("<session-id>", "session id")
  .option("-d, --dir <path>", "project directory (defaults to cwd)", process.cwd())
  .option("-a, --all", "search every project Claude Code has seen, not just --dir", false)
  .option("-s, --source <tool>", 'source tool: "claude" or "opencode" (auto-detect)')
  .action((sessionId, opts) => {
    const source = resolveSource(sessionId, opts.source);
    if (source === "opencode") {
      const session = findOpenCodeSessionById(sessionId);
      if (!session) {
        console.error(`Could not find OpenCode session "${sessionId}".`);
        process.exitCode = 1;
        return;
      }
      console.log(renderOpenCodeTranscript(session.session));
      return;
    }

    const dir = path.resolve(opts.dir);
    const session = findClaudeSessionById(sessionId, dir);
    if (!session) {
      console.error(`Could not find Claude Code session "${sessionId}" (looked under ~/.claude/projects).`);
      process.exitCode = 1;
      return;
    }
    const entries = parseSessionFile(session.file);
    console.log(renderClaudeTranscript(entries));
  });

program
  .command("fork")
  .description("Fork a session into the other tool and record it in the local git ledger")
  .argument("[session-id]", "session id to fork (defaults to the most recent one)")
  .option("-d, --dir <path>", "project directory (forward: source dir; reverse: target dir)", process.cwd())
  .option("-s, --source <tool>", 'source tool: "claude" or "opencode" (auto-detect)')
  .option("--title <title>", "title for the new OpenCode session (forward only)")
  .option("--provider <providerID>", "OpenCode provider id to attribute assistant turns to (forward only)", "anthropic")
  .option("--agent <agent>", "OpenCode agent name (forward only)", "build")
  .option("--dry-run", "convert and write the ledger commit, but skip the final import/write", false)
  .action((sessionId, opts) => {
    const source = resolveSource(sessionId, opts.source);

    if (source === "opencode") {
      const session = sessionId ? findOpenCodeSessionById(sessionId) : findLatestOpenCodeSession();
      if (!session) {
        console.error(
          sessionId
            ? `Could not find OpenCode session "${sessionId}".`
            : `No OpenCode sessions found. Have you run \`opencode\` yet?`
        );
        process.exitCode = 1;
        return;
      }

      const dir = path.resolve(opts.dir || session.session.info?.directory || process.cwd());
      const entries = convertToClaude(session.session, { directory: dir });
      if (entries.length === 0) {
        console.error(`Session ${session.id} has no user/assistant messages to fork.`);
        process.exitCode = 1;
        return;
      }

      const ledgerDir = ledgerPath(dir);
      const { hash, changed } = commitFork(ledgerDir, {
        sessionId: session.id,
        claudeSource: { data: entries },
        opencodeSource: { data: session.session },
        direction: "opencode -> claude-code",
      });
      console.log(
        changed
          ? `Ledger commit ${hash.slice(0, 10)} recorded at ${ledgerDir}`
          : `No changes since last fork (ledger already at ${hash.slice(0, 10)})`
      );

      if (opts.dryRun) {
        console.log(`Dry run: skipped writing Claude file. Claude session id: ${entries[0].sessionId}`);
        return;
      }

      try {
        const { filePath } = writeClaudeSession(entries, dir);
        console.log(`Wrote Claude session to ${filePath}`);
        console.log(`Resume it with: run \`claude\` in ${dir}`);
      } catch (err) {
        console.error(err.message);
        process.exitCode = 1;
      }
      return;
    }

    const dir = path.resolve(opts.dir);
    const session = sessionId ? findClaudeSessionById(sessionId, dir) : findLatestClaudeSession(dir);
    if (!session) {
      console.error(
        sessionId
          ? `Could not find Claude Code session "${sessionId}" (looked under ~/.claude/projects).`
          : `No Claude Code sessions found for ${dir}. Have you run \`claude\` here yet?`
      );
      process.exitCode = 1;
      return;
    }

    const entries = toConversation(parseSessionFile(session.file));
    if (entries.length === 0) {
      console.error(`Session ${session.id} has no user/assistant messages to fork.`);
      process.exitCode = 1;
      return;
    }

    const title = opts.title ?? `Forked from Claude Code (${session.id.slice(0, 8)})`;
    const converted = convertToOpenCode(entries, {
      directory: dir,
      title,
      providerID: opts.provider,
      agent: opts.agent,
    });

    const ledgerDir = ledgerPath(dir);
    const { hash, changed } = commitFork(ledgerDir, {
      sessionId: session.id,
      claudeSource: { path: session.file },
      opencodeSource: { data: converted },
      direction: "claude-code -> opencode",
    });
    console.log(
      changed
        ? `Ledger commit ${hash.slice(0, 10)} recorded at ${ledgerDir}`
        : `No changes since last fork (ledger already at ${hash.slice(0, 10)})`
    );

    if (opts.dryRun) {
      console.log(`Dry run: skipped \`opencode import\`. Converted OpenCode session id: ${converted.info.id}`);
      return;
    }

    try {
      const out = importIntoOpenCode(converted, { cwd: dir });
      console.log(out || `Imported into OpenCode as ${converted.info.id}`);
      console.log(`Resume it with: opencode --session ${converted.info.id}`);
    } catch (err) {
      console.error(err.message);
      process.exitCode = 1;
    }
  });

program
  .command("sync")
  .description("Reconcile a conversation that has been edited in both tools")
  .argument("[session-id]", "Claude or OpenCode session id (defaults to the most recently forked session in the ledger)")
  .option("-d, --dir <path>", "project directory (defaults to cwd)", process.cwd())
  .option("-s, --strategy <strategy>", 'merge strategy: "timestamp" (default) or "abort"', "timestamp")
  .option("--provider <providerID>", "OpenCode provider id for new Claude turns", "anthropic")
  .option("--agent <agent>", "OpenCode agent name for new Claude turns", "build")
  .option("--dry-run", "compute the merge but skip writing files or importing", false)
  .action((sessionId, opts) => {
    const dir = path.resolve(opts.dir);
    const ledgerDir = ledgerPath(dir);
    if (!fs.existsSync(path.join(ledgerDir, ".git"))) {
      console.error(`No ledger found at ${ledgerDir}. Run a fork first.`);
      process.exitCode = 1;
      return;
    }

    const mapping = resolveSessionPair(ledgerDir, sessionId, ledgerLog);
    if (!mapping) {
      console.error(
        `No mapping found for "${sessionId || "the latest ledger commit"}" in the ledger. ` +
          `You may need to run a fork first so the session pair is recorded.`
      );
      process.exitCode = 1;
      return;
    }

    const result = syncSession({
      ledgerDir,
      dir,
      claudeId: mapping.claudeId,
      opencodeId: mapping.opencodeId,
      strategy: opts.strategy,
      dryRun: opts.dryRun,
      provider: opts.provider,
      agent: opts.agent,
    });

    if (result.claudeNew !== undefined && result.opencodeNew !== undefined && (result.claudeNew > 0 || result.opencodeNew > 0)) {
      console.log(`Syncing ${result.claudeNew} new Claude turns and ${result.opencodeNew} new OpenCode turns.`);
    }
    if (result.message) console.log(result.message);
    if (result.error) console.error(result.error);
    if (result.exitCode) process.exitCode = result.exitCode;
  });

program
  .command("watch")
  .description("Auto-sync a conversation when either tool changes (press Ctrl-C to stop)")
  .argument("[session-id]", "Claude or OpenCode session id (defaults to the most recently forked session in the ledger)")
  .option("-d, --dir <path>", "project directory (defaults to cwd)", process.cwd())
  .option("-s, --strategy <strategy>", 'merge strategy: "timestamp" (default) or "abort"', "timestamp")
  .option("-i, --interval <ms>", "OpenCode poll interval in milliseconds", "5000")
  .option("--provider <providerID>", "OpenCode provider id for new Claude turns", "anthropic")
  .option("--agent <agent>", "OpenCode agent name for new Claude turns", "build")
  .action(async (sessionId, opts) => {
    const dir = path.resolve(opts.dir);
    const ledgerDir = ledgerPath(dir);
    if (!fs.existsSync(path.join(ledgerDir, ".git"))) {
      console.error(`No ledger found at ${ledgerDir}. Run a fork first.`);
      process.exitCode = 1;
      return;
    }

    const mapping = resolveSessionPair(ledgerDir, sessionId, ledgerLog);
    if (!mapping) {
      console.error(
        `No mapping found for "${sessionId || "the latest ledger commit"}" in the ledger. ` +
          `You may need to run a fork first so the session pair is recorded.`
      );
      process.exitCode = 1;
      return;
    }

    const { claudeId, opencodeId } = mapping;
    const claudeProjectDir = path.join(claudeProjectsDir(), encodeProjectPath(dir));
    const claudeFile = path.join(claudeProjectDir, `${claudeId}.jsonl`);
    if (!fs.existsSync(claudeFile)) {
      console.error(`Claude session file not found: ${claudeFile}`);
      process.exitCode = 1;
      return;
    }

    const strategy = opts.strategy;
    if (strategy !== "timestamp" && strategy !== "abort") {
      console.error(`Unknown strategy "${strategy}". Use "timestamp" or "abort".`);
      process.exitCode = 1;
      return;
    }

    const interval = Number(opts.interval);
    if (!Number.isFinite(interval) || interval < 500) {
      console.error("Interval must be at least 500 ms.");
      process.exitCode = 1;
      return;
    }

    console.log(`Watching ${claudeFile} and OpenCode session ${opencodeId} (poll every ${interval}ms). Press Ctrl-C to stop.`);
    const handle = watchSession({
      claudeFile,
      claudeId,
      opencodeId,
      ledgerDir,
      dir,
      strategy,
      interval,
      provider: opts.provider,
      agent: opts.agent,
      onEvent: (type, message) => {
        if (type === "error") console.error(message);
        else console.log(message);
      },
    });

    await waitForInterrupt();
    handle.stop();
  });

program
  .command("log")
  .description("Show the fork history recorded in the local git ledger")
  .option("-d, --dir <path>", "project directory (defaults to cwd)", process.cwd())
  .option("-n, --limit <count>", "number of entries to show", "20")
  .action((opts) => {
    const dir = path.resolve(opts.dir);
    const entries = ledgerLog(ledgerPath(dir), Number(opts.limit));
    if (entries.length === 0) {
      console.log("No forks recorded yet. Run `agentbridge fork` first.");
      return;
    }
    for (const e of entries) {
      console.log(`${e.hash.slice(0, 10)}  ${e.date}  ${e.message}`);
    }
  });

program.parse();
