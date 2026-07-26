# agentbridge

Phase 1 of a Claude Code ⇄ OpenCode context bridge: fork a Claude Code chat
session into OpenCode, and record every fork as a commit in a local git
ledger.

```
agentbridge list [--dir <path>] [--all]
agentbridge show <session-id> [--dir <path>]
agentbridge fork [session-id] [--dir <path>] [--title <t>] [--provider <id>] [--agent <name>] [--dry-run]
agentbridge log  [--dir <path>] [--limit <n>]
```

Typical flow: `agentbridge list` to see what's available (newest first, with a
one-line preview of each), `agentbridge show <id>` to read the full
transcript of one you're unsure about, then `agentbridge fork <id>` once
you've picked one. `--all` on `list`/`show` searches every project Claude
Code has ever recorded a session for, not just the current directory.

Run `agentbridge fork` with no arguments inside (or with `--dir` pointing at)
a project you've used `claude` in, and it will:

1. find the most recent Claude Code session for that project (or a specific
   one, if you pass a session id)
2. convert it into OpenCode's session/message/part JSON format
3. commit both the raw Claude Code transcript and the converted JSON to a
   local git repo at `.agentbridge/ledger/` inside the project
4. run `opencode import` so the conversation shows up in OpenCode, ready to
   resume with `opencode --session <id>`

Re-running `fork` on an unchanged session is a no-op (same OpenCode session
id, no new ledger commit). If the Claude session has grown since the last
fork, it updates the same OpenCode session in place and records a new commit
containing only the diff.

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

`src/converter.js` turns that into OpenCode's import/export JSON shape:

```
{
  "info": { id, slug, title, version, directory, time: { created, updated } },
  "messages": [
    { "info": <UserMessage|AssistantMessage>, "parts": [ <Part>, ... ] },
    ...
  ]
}
```

**This shape isn't documented anywhere public.** I derived it by installing
`opencode@1.18.5` locally, round-tripping synthetic sessions through
`opencode import ...` / `opencode export ...` and reading opencode's disk
layout (SQLite tables: `session`, `message`, `part` - each message/part row
just stores a `data` JSON blob matching the shapes below) plus its generated
SDK types in `@opencode-ai/sdk/dist/gen/types.gen.d.ts` for the exact fields
of `Session`, `UserMessage`, `AssistantMessage`, and every `Part` variant
(`text`, `reasoning`, `tool`, `file`, `step-start`, `step-finish`, `snapshot`,
`patch`, `agent`, `retry`, `compaction`, `subtask`). **If a future opencode
release changes this shape, `opencode import` will start rejecting the
converted JSON with a schema validation error** (it uses zod internally, so
the error tells you exactly which field it wanted) - re-run the same
probing approach (see git history of this file / ask me) to update
`converter.js`.

Mapping notes:
- Claude's `text` / `thinking` content blocks → OpenCode `text` / `reasoning`
  parts.
- Claude's `tool_use` blocks → OpenCode `tool` parts. The matching
  `tool_result` (or, in some Claude Code versions, the raw `toolUseResult`
  field on the following entry) is folded into the tool part's `state`
  instead of being rendered as a separate message - that's how OpenCode
  represents a finished tool call. If no result is found (the tool call never
  finished), the part is marked `status: "pending"` rather than inventing a
  result.
- Claude's synthetic "here's your tool result" user turn is *not* emitted as
  its own OpenCode message (it would show up as an empty bubble); its content
  is already captured in the tool part above.
- IDs and the session's `created`/`updated` timestamps are **derived
  deterministically** from Claude's own `uuid`s/timestamps (sha256-based),
  not randomly generated or read from the wall clock. This is what makes
  re-forking idempotent - see `deriveId()` in `converter.js`.
- Model attribution: assistant turns are tagged with `--provider` (default
  `anthropic`) and Claude's own model string (e.g.
  `claude-opus-4-8`) as `modelID`. Make sure that provider/model pair is
  actually configured in OpenCode, or override with `--provider`/`--agent` if
  your OpenCode setup names things differently.

## Known limitations (v1)

- Parallel tool calls within a single assistant turn are matched to their
  results positionally (FIFO) when Claude Code doesn't tag the result with a
  `tool_use_id`. This is correct for the common one-tool-per-turn case;
  heavily parallel tool use could mis-pair in rare cases.
- File attachments, permission prompts, and Claude Code's own slash commands
  aren't converted (OpenCode has no exact equivalent for some of these).
- Only Claude Code → OpenCode, one-way, one session at a time. See below for
  what's next.

## Phase 2 (not built yet): bidirectional sync

The plan is to build sync *on top of* the git ledger this phase already
writes, rather than invent a separate sync protocol:

1. **Both directions get a converter.** `converter.js` becomes two modules:
   `claude-to-opencode.js` (done) and `opencode-to-claude.js` (mirrors it,
   writing back into a Claude-shaped JSONL). Both read/write through the same
   ledger.
2. **The ledger becomes the source of truth for "what did we last sync".**
   Every fork/sync writes a commit; the *previous* commit for a session is
   the last-known-synced state. When you ask to sync, agentbridge re-reads
   both tools' current state, converts each into the other's format, and
   diffs against the last ledger commit to see what's new on each side.
3. **Conflict handling:** if both sides changed since the last sync (you
   edited/continued the conversation in both Claude Code *and* OpenCode
   before syncing), that's a real conflict - not something to silently
   resolve. Options to decide on: (a) always append both sides' new turns in
   timestamp order and let you continue from a merged transcript, (b) refuse
   and show a `git diff`-style conflict for you to resolve manually, or (c)
   let you pick "keep mine" / "keep theirs" per session. Given this is a
   conversation transcript, not source code, I'd lean toward (a) as the
   default with (b) available via a flag - line-level git merge doesn't
   really make sense for structured JSON, so the merge logic needs to be
   conversation-aware (append-only by timestamp), not textual.
4. **Live sync** (optional stretch goal): a `agentbridge watch` command using
   file watchers on `~/.claude/projects/**/*.jsonl` and polling OpenCode's
   session list, auto-forking on change so both tools stay near-real-time in
   sync without you having to remember to run `fork` manually.

Happy to start on any part of this whenever you want - my suggestion would be
(1) and (2) first (a working manual two-way sync you trigger yourself), and
only add (4) live-watching once the conflict-handling in (3) feels solid,
since that's the part most likely to lose someone's work if it's wrong.
