// src/ledger/git-ledger.js
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

function writeLedgerData(ledgerDir, subdir, sessionId, ext, source) {
  const dest = path.join(ledgerDir, subdir, `${sessionId}.${ext}`);
  if (source.path) {
    // Raw source: byte-for-byte copy.
    fs.copyFileSync(source.path, dest);
  } else if (ext === "jsonl") {
    // Claude-format data: an array of JSONL entries.
    const lines = Array.isArray(source.data)
      ? source.data.map((e) => JSON.stringify(e)).join("\n") + "\n"
      : source.data + "\n";
    fs.writeFileSync(dest, lines);
  } else {
    // OpenCode-format data: a JSON object.
    fs.writeFileSync(dest, JSON.stringify(source.data, null, 2) + "\n");
  }
  return dest;
}

function countMessages(claudeSource, opencodeSource) {
  if (claudeSource.data && Array.isArray(claudeSource.data)) {
    return claudeSource.data.length;
  }
  if (opencodeSource.data && Array.isArray(opencodeSource.data.messages)) {
    return opencodeSource.data.messages.length;
  }
  return 0;
}

const MAPPING_FILE = "mapping.json";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();
}

function readMapping(ledgerDir) {
  const p = path.join(ledgerDir, MAPPING_FILE);
  if (!fs.existsSync(p)) return { pairs: [] };
  try {
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    return { pairs: Array.isArray(data.pairs) ? data.pairs : [] };
  } catch {
    return { pairs: [] };
  }
}

function writeMapping(ledgerDir, mapping) {
  const p = path.join(ledgerDir, MAPPING_FILE);
  fs.writeFileSync(p, JSON.stringify(mapping, null, 2) + "\n");
}

function updateMapping(mapping, claudeId, opencodeId) {
  if (!claudeId || !opencodeId) return;
  const existing = mapping.pairs.find(
    (p) => p.claudeId === claudeId || p.opencodeId === opencodeId
  );
  if (existing) {
    existing.claudeId = claudeId;
    existing.opencodeId = opencodeId;
  } else {
    mapping.pairs.push({ claudeId, opencodeId });
  }
}

export function findMapping(ledgerDir, { claudeId, opencodeId } = {}) {
  const mapping = readMapping(ledgerDir);
  return mapping.pairs.find(
    (p) => (claudeId && p.claudeId === claudeId) || (opencodeId && p.opencodeId === opencodeId)
  );
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

export function readLedgerFiles(ledgerDir, sessionId) {
  const claudePath = path.join(ledgerDir, "claude", `${sessionId}.jsonl`);
  const opencodePath = path.join(ledgerDir, "opencode", `${sessionId}.json`);
  const claude = fs.existsSync(claudePath)
    ? fs.readFileSync(claudePath, "utf8").split("\n").filter(Boolean).map(JSON.parse)
    : null;
  const opencode = fs.existsSync(opencodePath)
    ? JSON.parse(fs.readFileSync(opencodePath, "utf8"))
    : null;
  return { claude, opencode };
}

/**
 * Read the ledger state for a session pair, trying both the Claude and OpenCode
 * ids. Forward forks key files by Claude id; reverse forks key by OpenCode id.
 */
export function readLedgerPair(ledgerDir, claudeId, opencodeId) {
  const a = readLedgerFiles(ledgerDir, claudeId);
  const b = readLedgerFiles(ledgerDir, opencodeId);
  // Prefer the more recently modified claude file if both exist.
  const aClaudePath = path.join(ledgerDir, "claude", `${claudeId}.jsonl`);
  const bClaudePath = path.join(ledgerDir, "claude", `${opencodeId}.jsonl`);
  const aTime = fs.existsSync(aClaudePath) ? fs.statSync(aClaudePath).mtimeMs : 0;
  const bTime = fs.existsSync(bClaudePath) ? fs.statSync(bClaudePath).mtimeMs : 0;
  const preferB = bTime > aTime;
  return {
    claude: (preferB ? b.claude : null) ?? a.claude,
    opencode: (preferB ? b.opencode : null) ?? a.opencode,
  };
}

/**
 * Write the raw + converted files and commit them.
 *
 * One of the two sources is always the raw source (provided as a file path) and
 * the other is the converted form (provided as data), but the ledger stores
 * both representations keyed by the source session id regardless of direction.
 *
 * @param {object} claudeSource - either { path: string } or { data: object[] }
 * @param {object} opencodeSource - either { path: string } or { data: object }
 * @returns {{hash:string, changed:boolean}}
 */
export function commitFork(ledgerDir, { sessionId, claudeId, opencodeId, claudeSource, opencodeSource, direction }) {
  ensureLedger(ledgerDir);

  writeLedgerData(ledgerDir, "claude", sessionId, "jsonl", claudeSource);
  writeLedgerData(ledgerDir, "opencode", sessionId, "json", opencodeSource);

  // Record the bidirectional id mapping for sync.
  let resolvedClaudeId = claudeId;
  if (!resolvedClaudeId) {
    if (Array.isArray(claudeSource.data)) {
      resolvedClaudeId = claudeSource.data[0]?.sessionId;
    } else if (claudeSource.path) {
      resolvedClaudeId = path.basename(claudeSource.path).replace(/\.jsonl$/, "");
    }
  }
  let resolvedOpenCodeId = opencodeId;
  if (!resolvedOpenCodeId) {
    if (opencodeSource.data && typeof opencodeSource.data === "object" && opencodeSource.data.info?.id) {
      resolvedOpenCodeId = opencodeSource.data.info.id;
    }
  }
  const mapping = readMapping(ledgerDir);
  updateMapping(mapping, resolvedClaudeId, resolvedOpenCodeId);
  writeMapping(ledgerDir, mapping);

  git(ledgerDir, ["add", "-A"]);

  const messageCount = countMessages(claudeSource, opencodeSource);
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
