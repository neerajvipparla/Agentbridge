# agentbridge

Phase 1 of a Claude Code ⇄ OpenCode context bridge: fork a chat session from
one agent into the other, and record every fork as a commit in a local git
ledger.

```
agentbridge list [-s claude|opencode] [--dir <path>] [--all]
agentbridge show <session-id> [-s claude|opencode] [--dir <path>]
agentbridge fork [session-id] [-s claude|opencode] [--dir <path>] [--dry-run]
                 [--title <t>] [--provider <id>] [--agent <name>]
agentbridge sync [session-id] [--dir <path>] [--strategy timestamp|abort]
agentbridge watch [session-id] [--dir <path>] [--strategy timestamp|abort] [--interval <ms>]
agentbridge log  [--dir <path>] [--limit <n>]
```

Typical flow:

- `agentbridge list` (or `list -s opencode`) to see what's available.
- `agentbridge show <id>` to read the full transcript.
- `agentbridge fork <id>` to clone the session into the *other* tool.

`--source` / `-s` selects the source tool:

| Command | Default source | `-s opencode` |
|---|---|---|
| `list` | Claude Code sessions | OpenCode sessions |
| `show` | auto-detect by id | OpenCode session |
| `fork` | auto-detect by id (or latest Claude) | OpenCode → Claude Code |

Auto-detection: ids starting with `ses_` are OpenCode; everything else is
treated as a Claude Code session id.

Run `agentbridge fork` with no arguments inside a project you've used `claude`
in, and it will find the most recent Claude Code session, convert it into
OpenCode's format, commit both representations to `.agentbridge/ledger/`, and
run `opencode import` so the conversation shows up in OpenCode.

Run `agentbridge fork <ses_...> -s opencode` to go the other way: it exports
the OpenCode session, converts it back to a Claude Code JSONL transcript, and
writes it to `~/.claude/projects/<encoded-dir>/<uuid>.jsonl` so `claude` can
resume it.

Re-running `fork` on an unchanged session is a no-op (same target id, no new
ledger commit). If the source session has grown since the last fork, it
updates the target in place and records a new commit containing only the diff.

`--dry-run` converts and writes the ledger commit, but skips the final
`opencode import` / Claude file write.

## Bidirectional sync (`sync`)

`agentbridge sync [session-id]` reconciles a conversation that has been edited
in both tools since the last fork/sync.

- It reads the current Claude transcript and the current OpenCode session.
- It compares both to the last synced state stored in `.agentbridge/ledger/`.
- It merges only the *new* turns into both tools.

```bash
agentbridge sync                          # latest session in the ledger
agentbridge sync <claude-uuid>            # by Claude session id
agentbridge sync <ses_...>                # by OpenCode session id
agentbridge sync --strategy abort         # refuse if both sides changed
agentbridge sync --strategy timestamp     # merge by timestamp (default)
```

Conflict strategies:

- `timestamp` (default) — append new turns from both sides and sort by time.
  This is the recommended default for conversations because turns are
  append-only and chronological order is usually the right merge.
- `abort` — stop and show how many new turns each side has, so you can resolve
  manually. Use this when you want full control over the merge.

`sync` also records a ledger commit, so you can roll back or inspect the diff.

## Live sync (`watch`)

`agentbridge watch [session-id]` monitors the Claude session file and polls
OpenCode, automatically syncing when either side changes.

```bash
agentbridge watch                     # latest session in the ledger
agentbridge watch <ses_...>           # watch a specific OpenCode session
agentbridge watch --interval 1000     # poll OpenCode every 1 second
agentbridge watch --strategy abort    # stop and warn on conflicts
```

Press **Ctrl-C** to stop. The default poll interval is 5 seconds.

**Safety note:** `watch` uses the same merge strategy as `sync`. With the default
`timestamp` strategy it will auto-merge both sides' new turns. If you prefer to
review every conflict, use `--strategy abort`.

## Install

```
cd agentbridge
npm install
npm link   # or: node bin/agentbridge.js ...
```

Requires `git` and the `opencode` CLI on your `PATH`.

## How the conversion works

Claude Code stores one JSONL file per session at
`~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`, where `<encoded-cwd>`
is the absolute working directory with **every non-alphanumeric character**
replaced by `-` (e.g. `/Users/me/.config/my_app` →
`-Users-me--config-my-app`), not just the path separators.
Each line is an entry with a `type` (`user`/`assistant`/...), a `message`
object whose `content` is either a string or an array of blocks (`text`,
`thinking`, `tool_use`, `tool_result`), and Claude's own `uuid`/`parentUuid`
chain. `src/claude-reader.js` finds and parses these files; `toConversation()`
filters out subagent ("sidechain") and internal ("meta") entries so you get
the same linear conversation you'd see in the Claude Code TUI.

`src/converter.js` turns Claude Code into OpenCode's import/export JSON shape;
`src/opencode-to-claude.js` runs the reverse direction. Both are built on the
same import/export JSON contract that was reverse-engineered from
`opencode@1.18.5` by round-tripping synthetic sessions through
`opencode import ...` / `opencode export ...` and reading OpenCode's generated
SDK types in `@opencode-ai/sdk/dist/gen/types.gen.d.ts`.

Forward (`converter.js`) mapping:

```
Claude JSONL  →  OpenCode { info, messages:[{info, parts}] }
```

- Claude's `text` / `thinking` blocks → OpenCode `text` / `reasoning` parts.
- Claude's `tool_use` blocks → OpenCode `tool` parts. The matching
  `tool_result` (or the raw `toolUseResult` field on the following entry) is
  folded into the tool part's `state` instead of being rendered as a separate
  message. If no result is found, the part is marked `status: "pending"`.
- Claude's synthetic "here's your tool result" user turn is *not* emitted as
  its own OpenCode message (it would show up as an empty bubble); its content
  is already captured in the tool part above.
- Empty assistant turns (e.g. redacted thinking blocks that keep only a
  `signature` and no text) are also skipped to avoid blank bubbles.

Reverse (`opencode-to-claude.js`) mapping:

```
OpenCode { info, messages:[{info, parts}] }  →  Claude JSONL
```

- OpenCode `text` / `reasoning` parts → Claude `text` / `thinking` blocks.
- OpenCode `tool` parts are expanded back into the two-entry structure Claude
  Code uses: an assistant entry containing a `tool_use` block, followed by a
  synthetic user entry containing the matching `tool_result` block plus a
  `toolUseResult` fallback.
- A **fresh, deterministic Claude session UUID** is generated from the
  OpenCode session id rather than reusing the `ses_...` id (the formats are
  intentionally different). Re-importing the same OpenCode session produces
  the same Claude id, so reverse-forking is also idempotent.

In both directions, IDs and timestamps are **derived deterministically** from
the source tool's own ids/timestamps (sha256-based), not random. This is what
makes re-forking idempotent. Override `--provider` / `--agent` on forward
forks if your OpenCode config names them differently.

## Known limitations

- Parallel tool calls within a single assistant turn are matched to their
  results positionally (FIFO) when Claude Code doesn't tag the result with a
  `tool_use_id`. This is correct for the common one-tool-per-turn case;
  heavily parallel tool use could mis-pair in rare cases.
- File attachments, permission prompts, Claude Code slash commands, and
  OpenCode-specific part types besides `text` / `reasoning` / `tool` aren't
  converted yet.
- One session at a time; no batch mode.
- `sync` merges by timestamp; it does not yet de-duplicate semantically
  identical turns added independently on both sides.

## Phase 2: bidirectional sync (implemented)

The `agentbridge sync` command implements steps 1-3:

1. **Both directions get a converter.** Done: `converter.js` (Claude → OpenCode)
   and `opencode-to-claude.js` (OpenCode → Claude). Both write through the
   same ledger.
2. **The ledger is the source of truth for "what did we last sync".**
   `sync` reads the last ledger commit for the session pair, diffs it against
   the current state of both tools, and only merges the new turns.
3. **Conflict handling:** `timestamp` (default) appends both sides' new turns
   in chronological order; `abort` refuses and reports the conflict so you
   can resolve manually.
4. **Live sync:** `agentbridge watch` monitors the Claude JSONL file with
   `fs.watch` and polls OpenCode's session list, auto-syncing on change.
