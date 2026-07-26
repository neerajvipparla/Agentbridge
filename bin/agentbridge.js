#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";

import {
  findLatestSession,
  findSessionById,
  findProjectDir,
  listSessions,
  listAllProjectDirs,
  parseSessionFile,
  toConversation,
  summarizeSession,
  renderTranscript,
} from "../src/claude-reader.js";
import { convertToOpenCode } from "../src/converter.js";
import { importIntoOpenCode } from "../src/opencode-import.js";
import { ledgerPath, commitFork, log as ledgerLog } from "../src/git-ledger.js";

const program = new Command();

program
  .name("agentbridge")
  .description(
    "Phase 1: fork a Claude Code chat session into OpenCode and record it as a local git commit."
  )
  .version("0.1.0");

program
  .command("list")
  .alias("ls")
  .description("List Claude Code sessions you can fork, newest first")
  .option("-d, --dir <path>", "project directory (defaults to cwd)", process.cwd())
  .option("-a, --all", "list sessions across every project Claude Code has seen, not just this one", false)
  .action((opts) => {
    const targets = opts.all
      ? listAllProjectDirs()
      : (() => {
          const dir = findProjectDir(path.resolve(opts.dir));
          return dir ? [dir] : [];
        })();

    if (targets.length === 0) {
      console.log(
        opts.all
          ? "No Claude Code sessions found anywhere under ~/.claude/projects."
          : `No Claude Code sessions found for ${path.resolve(opts.dir)}. Try --all to search every project, or run \`claude\` here first.`
      );
      return;
    }

    const rows = [];
    for (const dir of targets) {
      for (const session of listSessions(dir)) {
        const entries = parseSessionFile(session.file);
        const summary = summarizeSession(entries);
        if (summary.messageCount === 0) continue; // skip empty/aborted sessions
        rows.push({ ...session, ...summary });
      }
    }
    rows.sort((a, b) => b.mtime - a.mtime);

    if (rows.length === 0) {
      console.log("No non-empty sessions found.");
      return;
    }

    for (const r of rows) {
      const when = new Date(r.mtime).toLocaleString();
      console.log(`${r.id}`);
      console.log(`  ${when}  ·  ${r.messageCount} messages${opts.all ? `  ·  ${r.cwd}` : ""}`);
      console.log(`  "${r.firstMessage}"`);
      console.log("");
    }
    console.log(`Preview one in full with:  agentbridge show <session-id>${opts.all ? " --all" : ""}`);
    console.log(`Fork one to OpenCode with: agentbridge fork <session-id>`);
  });

program
  .command("show")
  .description("Print the full transcript of a Claude Code session (to decide whether to fork it)")
  .argument("<session-id>", "Claude Code session id")
  .option("-d, --dir <path>", "project directory (defaults to cwd)", process.cwd())
  // `show` already falls back to scanning every project when the id isn't in
  // --dir, so lookups span all projects regardless; --all is accepted for
  // symmetry with `list` (and so the hint `list --all` prints stays valid).
  .option("-a, --all", "search every project Claude Code has seen, not just --dir", false)
  .action((sessionId, opts) => {
    const dir = path.resolve(opts.dir);
    const session = findSessionById(sessionId, dir);
    if (!session) {
      console.error(`Could not find Claude Code session "${sessionId}" (looked under ~/.claude/projects).`);
      process.exitCode = 1;
      return;
    }
    const entries = parseSessionFile(session.file);
    console.log(renderTranscript(entries));
  });

program
  .command("fork")
  .description("Convert a Claude Code session into OpenCode and import it")
  .argument("[session-id]", "Claude Code session id to fork (defaults to the most recent one)")
  .option("-d, --dir <path>", "project directory (defaults to cwd)", process.cwd())
  .option("--title <title>", "title for the new OpenCode session")
  .option("--provider <providerID>", "OpenCode provider id to attribute assistant turns to", "anthropic")
  .option("--agent <agent>", "OpenCode agent name", "build")
  .option("--dry-run", "convert and write the ledger commit, but skip `opencode import`", false)
  .action((sessionId, opts) => {
    const dir = path.resolve(opts.dir);

    const session = sessionId ? findSessionById(sessionId, dir) : findLatestSession(dir);
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
      rawJsonlPath: session.file,
      convertedJson: converted,
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
