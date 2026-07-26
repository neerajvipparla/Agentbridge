---
name: agentbridge
description: Use when the user wants to fork, sync, or reconcile chat sessions between Claude Code and OpenCode using the agentbridge CLI.
---

# agentbridge

## When to use

Use this skill whenever the user wants to:

- Move a Claude Code conversation into OpenCode (`fork`).
- Move an OpenCode conversation into Claude Code (`fork -s opencode`).
- Reconcile a conversation that has new messages in both tools (`sync`).
- Continuously sync a conversation while both tools are open (`watch`).
- Inspect the local ledger history (`log`).
- List available sessions (`list`).

## Commands

All commands assume `agentbridge` is on PATH (installed with `npm install -g @neerajvipparla/agentbridge` or `npm link` from the repo).

List sessions:

```bash
agentbridge list
agentbridge list --all
agentbridge list -s opencode
```

Fork a session:

```bash
agentbridge fork <claude-session-id> -d <project-dir> --dry-run
agentbridge fork <opencode-session-id> -s opencode -d <project-dir> --dry-run
```

Sync a diverged session:

```bash
agentbridge sync <session-id> -d <project-dir> --dry-run
```

Watch and auto-sync:

```bash
agentbridge watch <session-id> -d <project-dir>
```

Show ledger history:

```bash
agentbridge log -d <project-dir>
```

## Important rules

- Always use `--dry-run` first when the user wants a preview or when the result is uncertain.
- The default sync strategy is `timestamp` (groups turns by origin and orders by timestamp). Other strategies: `abort`, `persist-claude`, `persist-opencode`.
- `persist-claude` and `persist-opencode` are only valid for `sync`, not for `watch`.
- `watch` only accepts `timestamp` or `abort`.
- Never introduce `crypto.randomUUID()` or `Date.now()` into converter logic; the ledger depends on deterministic ids.
- The ledger lives at `<project-dir>/.agentbridge/ledger/`. A fork must be recorded there before `sync` or `watch` can work.
- Claude Code project paths are encoded with every non-alphanumeric character replaced by `-` when locating sessions under `~/.claude/projects`.

## Common paths

- Repo: `/Users/neeraj/Dev/Claude/Agentbridge`
- Worktree: `/Users/neeraj/Dev/Claude/Agentbridge/.claude/worktrees/sync-divergence`
