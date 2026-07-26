// src/git-ledger.js
//
// A tiny local git repo used purely as a versioned ledger of every fork
// agentbridge performs. It is NOT your project's own git repo - it lives
// under .agentbridge/ledger inside the project directory (add
// .agentbridge/ to .gitignore if you don't want it alongside your code repo,
// or point --ledger elsewhere).
//
// Each fork produces one commit containing:
//   claude/<session-id>.jsonl   - byte-for-byte copy of the source transcript
//   opencode/<session-id>.json  - the converted OpenCode import payload
//
// This gives you a diffable, revertible history of every fork, and is the
// foundation phase 2 (bidirectional sync) will build on: sync conflicts can
// be reasoned about as diffs between ledger commits instead of ad hoc state.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function ledgerPath(projectDir) {
  return path.join(projectDir, ".agentbridge", "ledger");
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();
}

export function ensureLedger(ledgerDir) {
  fs.mkdirSync(ledgerDir, { recursive: true });
  fs.mkdirSync(path.join(ledgerDir, "claude"), { recursive: true });
  fs.mkdirSync(path.join(ledgerDir, "opencode"), { recursive: true });
  if (!fs.existsSync(path.join(ledgerDir, ".git"))) {
    git(ledgerDir, ["init", "-q"]);
    // Local, tool-only identity so this works even with no global git config.
    git(ledgerDir, ["config", "user.email", "agentbridge@local"]);
    git(ledgerDir, ["config", "user.name", "agentbridge"]);
  }
}

/**
 * Write the raw + converted files and commit them.
 * Returns the commit hash.
 */
export function commitFork(ledgerDir, { sessionId, rawJsonlPath, convertedJson, direction }) {
  ensureLedger(ledgerDir);

  const claudeDest = path.join(ledgerDir, "claude", `${sessionId}.jsonl`);
  const opencodeDest = path.join(ledgerDir, "opencode", `${sessionId}.json`);

  fs.copyFileSync(rawJsonlPath, claudeDest);
  fs.writeFileSync(opencodeDest, JSON.stringify(convertedJson, null, 2) + "\n");

  git(ledgerDir, ["add", "-A"]);

  const messageCount = convertedJson.messages?.length ?? 0;
  const summary = `fork ${direction}: ${sessionId} (${messageCount} messages)`;

  // Nothing to commit (re-forking an unchanged session) shouldn't be an error.
  try {
    git(ledgerDir, ["commit", "-q", "-m", summary]);
  } catch (err) {
    const msg = err.stdout?.toString() ?? err.message;
    if (/nothing to commit/i.test(msg)) {
      return { hash: git(ledgerDir, ["rev-parse", "HEAD"]), changed: false };
    }
    throw err;
  }

  return { hash: git(ledgerDir, ["rev-parse", "HEAD"]), changed: true };
}

export function log(ledgerDir, limit = 20) {
  // Reading history shouldn't create anything: if no ledger exists yet, there
  // are simply no forks to show.
  if (!fs.existsSync(path.join(ledgerDir, ".git"))) return [];

  let out;
  try {
    out = git(ledgerDir, [
      "log",
      `-${limit}`,
      "--pretty=format:%H|%ad|%s",
      "--date=iso-strict",
    ]);
  } catch (err) {
    // A freshly `git init`ed repo with no commits makes `git log` exit 128
    // ("does not have any commits yet") - treat that as an empty history.
    const msg = (err.stderr?.toString() ?? "") + (err.stdout?.toString() ?? "") + (err.message ?? "");
    if (/does not have any commits|unknown revision|bad default revision/i.test(msg)) return [];
    throw err;
  }
  if (!out) return [];
  return out.split("\n").map((line) => {
    const [hash, date, ...rest] = line.split("|");
    return { hash, date, message: rest.join("|") };
  });
}
