# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Read this first

The working conventions for this repo live in `agents/skills/`. **Read the matching file in full before you start** — these are files to open with Read, not skills the harness auto-loads, so nothing will prompt you.

| Before you… | Read |
|---|---|
| write or change any function, or fix a bug | `agents/skills/writing-tests-first/SKILL.md` |
| add a module, refactor, or reach for an abstraction or design pattern | `agents/skills/writing-quality-code/SKILL.md` |
| start a feature, or commit while on `main` | `agents/skills/shipping-via-pull-requests/SKILL.md` |
| change a flag, output shape, invariant, or documented limitation | `agents/skills/writing-documentation/SKILL.md` |

If more than one row applies, read all of them. Do not infer a file's contents from its name or from this table — each states specific rules and rules out specific shortcuts, and the table is only an index. They are binding: `writing-tests-first` and `shipping-via-pull-requests` state hard rules (no code before a failing test; no direct commits to `main`), and the invariants in Architecture below depend on them being followed.

## Commands

There is **no build or lint tooling and no test files** — `package.json` has no `scripts` field. Don't assume a configured test runner exists; the `writing-tests-first` skill defines the convention for adding the first one (Node's built-in `node --test`, zero dependencies).

```
npm install
npm link                          # or run directly: node bin/agentbridge.js ...
node bin/agentbridge.js list --all
node bin/agentbridge.js fork <session-id> --dry-run -d <project-path>
```

Requires `git` and the `opencode` CLI on `PATH`. ESM only (`"type": "module"`) — use `import`, not `require`.

### Verifying a change

`--dry-run` converts and writes the ledger commit but skips `opencode import`, making it the safe way to exercise the converter:

1. `node bin/agentbridge.js fork <id> --dry-run -d <project>` against a real Claude Code project
2. inspect the emitted `.agentbridge/ledger/opencode/<id>.json`
3. `node bin/agentbridge.js log -d <project>` to confirm the commit

**Regression check:** re-running `fork` on an unchanged session must print `No changes since last fork`. If it records a new commit, determinism (below) is broken.

## Architecture

One-way pipeline, no cycles: `claude-reader.js` (locate/parse/filter Claude's JSONL) → `converter.js` (shape transform) → `git-ledger.js` (commit) → `opencode-import.js` (shells out to `opencode import`). `bin/agentbridge.js` is a thin commander wrapper over these.

**The determinism invariant — the most important property in the repo.** `deriveId()` in `converter.js` is sha256 over Claude Code's own uuids, and the session's `created`/`updated` come from entry timestamps, never `Date.now()`. This single property is what makes `fork` idempotent, keeps the ledger free of spurious commits, and makes `opencode import` update a session in place rather than duplicating it. Introducing `crypto.randomUUID()` or a wall-clock read into `converter.js` breaks all three at once.

**The OpenCode import JSON shape is reverse-engineered** from `opencode@1.18.5` and is not publicly documented. OpenCode validates it with zod on import, so drift in a future release surfaces as a validation error naming the exact field it wanted. The README's "How the conversion works" section documents the probing method used to derive it — follow that to update `converter.js`, don't guess.

### Load-bearing details that look like they could be simplified

- **The two-pass tool-result harvest in `converter.js`.** Pass 1 must walk *assistant* entries to seed `pendingToolUseIds` before reaching the later user entry carrying an untagged `toolUseResult`; folding it into the single emit pass silently drops untagged results.
- **`encodeProjectPath` replaces every non-alphanumeric character**, not just path separators — Claude Code names project dirs that way (`/Users/me/.config/my_app` → `-Users-me--config-my-app`). Handling only `/` finds nothing for any path containing `.`, `_`, or a space.
- **The `parts.length === 0` skip deliberately does not advance `previousId`**, so an assistant message's `parentID` chains to the last message actually emitted rather than to an id absent from `messages`.
- Claude's `tool_result` blocks are folded into the OpenCode `tool` part's `state` and the synthetic "here's your tool result" user turn is dropped — OpenCode has no separate tool-result part type, and emitting the turn renders a blank bubble.

### The ledger

`.agentbridge/ledger/` inside the *target project* is its own nested git repo with a local-only `agentbridge@local` identity — not the project's repo, and not this repo. `.agentbridge/` is already gitignored here. It stores the raw Claude JSONL alongside the converted JSON per session; the README's Phase 2 notes plan bidirectional sync on top of it.
