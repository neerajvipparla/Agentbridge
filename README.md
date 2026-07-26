# agentbridge

A bidirectional Claude Code ⇄ OpenCode context bridge: fork a chat session
from one tool into the other, keep both sides in sync as the conversation
continues, and record every fork or sync as a commit in a local git ledger.

```
agentbridge list [-s claude|opencode] [--dir <path>] [--all]
agentbridge show <session-id> [-s claude|opencode] [--dir <path>] [--all]
agentbridge fork [session-id] [-s claude|opencode] [--dir <path>] [--dry-run]
                 [--title <t>] [--provider <id>] [--agent <name>]
agentbridge sync [session-id] [--dir <path>] [--strategy timestamp|abort]
                 [--provider <id>] [--agent <name>] [--dry-run]
agentbridge watch [session-id] [--dir <path>] [--strategy timestamp|abort]
                  [--interval <ms>] [--provider <id>] [--agent <name>]
agentbridge log [--dir <path>] [--limit <n>]
```

Run `agentbridge <command> --help` for the exhaustive flag list with
defaults - the block above is the shape of the surface, not a full
reference.

## Install

```
npm install -g @neerajvipparla/agentbridge
```

The package is published under a scoped name (npm's automated policy flags
`agentbridge` as too similar to an existing, unrelated `agent-bridge`
package) but the command it installs is still plain `agentbridge`.

Or run it once without installing:

```
npx -y @neerajvipparla/agentbridge list
```

Requires `git` and the `opencode` CLI on your `PATH`.

### From source

```
git clone https://github.com/neerajvipparla/Agentbridge.git
cd Agentbridge
npm install
npm link   # or: node bin/agentbridge.js ...
```

## Usage

Typical flow: `list` to see what's available, `show` to read a transcript
you're unsure about, `fork` once you've picked one.

```
$ agentbridge list
ad245505-24b0-478b-9126-b3dcdf79852f
  7/26/2026, 4:34:18 PM  ·  805 messages
  "<command-message>init</command-message>"

Preview one in full with:  agentbridge show <session-id>
Fork one to OpenCode with: agentbridge fork <session-id>
```

`--source` / `-s` picks which tool a command reads from or converts between:

| Command | Default source | `-s opencode` |
|---|---|---|
| `list` | Claude Code sessions | OpenCode sessions |
| `show` | auto-detect by id | OpenCode session |
| `fork` | auto-detect by id (or latest Claude session) | OpenCode → Claude Code |

Auto-detection: ids starting with `ses_` are treated as OpenCode; everything
else is treated as a Claude Code session id.

### Forking Claude Code → OpenCode

```
$ agentbridge fork b9a600da-9bf0-4d52-a70b-ff66bade638b --dry-run
Ledger commit bb0ee7d608 recorded at .../.agentbridge/ledger
Dry run: skipped `opencode import`. Converted OpenCode session id: ses_d51119061f313e2d7f905e57
```

Run it without `--dry-run` inside (or with `--dir` pointing at) a project
you've used `claude` in, and it will find the most recent Claude Code
session, convert it into OpenCode's format, commit both representations to
`.agentbridge/ledger/`, and run `opencode import` so the conversation shows
up in OpenCode, ready to resume with `opencode --session <id>`.

### Forking OpenCode → Claude Code

```
agentbridge fork <ses_...> -s opencode
```

Exports the OpenCode session, converts it back to a Claude Code JSONL
transcript, and writes it to `~/.claude/projects/<encoded-dir>/<uuid>.jsonl`
so `claude` can resume it.

Re-running `fork` on an unchanged session is a no-op (same target id, no new
ledger commit, and `--dry-run` reports "No changes since last fork"). If the
source session has grown since the last fork, it updates the target in
place and records a new commit containing only the diff.

### Keeping both sides in sync

`agentbridge sync [session-id]` reconciles a conversation that's been edited
in both tools since the last fork or sync - it reads the current state of
both, compares each to the last synced state recorded in the ledger, and
merges only the genuinely new turns.

```bash
agentbridge sync                          # latest session pair in the ledger
agentbridge sync <claude-uuid>            # by Claude session id
agentbridge sync <ses_...>                # by OpenCode session id
agentbridge sync --strategy abort         # refuse if both sides changed
agentbridge sync --strategy timestamp     # merge by timestamp (default)
```

- `timestamp` (default) - append new turns from both sides and sort by time.
  Turns are append-only and chronological, so this is the right default for
  a conversation.
- `abort` - stop and report how many new turns each side has, so you resolve
  the conflict manually instead of auto-merging.

`sync` records its own ledger commit on a real change, so you can inspect or
roll back a merge like any other fork. Re-running it with nothing new on
either side is a no-op, same as `fork`.

`agentbridge watch [session-id]` does the same thing continuously: it
monitors the Claude session file for changes and polls OpenCode's state,
auto-syncing whenever either side changes.

```bash
agentbridge watch                     # latest session pair in the ledger
agentbridge watch <ses_...>           # watch a specific OpenCode session
agentbridge watch --interval 1000     # poll OpenCode every 1 second
agentbridge watch --strategy abort    # stop and warn on conflicts instead
```

Press **Ctrl-C** to stop. The default poll interval is 5 seconds.
`watch` uses the same merge strategy as `sync` - with the default
`timestamp` strategy it auto-merges both sides' new turns on every poll, so
use `--strategy abort` if you'd rather review every conflict by hand.

### Reviewing what's been forked

```
agentbridge log [--limit <n>]
```

Prints the commit history of the local git ledger for the current project -
one line per fork or sync, newest first.

## How it works

Claude Code stores one JSONL file per session at
`~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`, where `<encoded-cwd>`
is the absolute working directory with **every non-alphanumeric character**
replaced by `-` (e.g. `/Users/me/.config/my_app` →
`-Users-me--config-my-app`), not just the path separators. Each line is an
entry with a `type` (`user`/`assistant`/...), a `message` object whose
`content` is either a string or an array of blocks (`text`, `thinking`,
`tool_use`, `tool_result`), and Claude's own `uuid`/`parentUuid` chain.
`src/readers/claude-reader.js` finds and parses these files; `toConversation()`
filters out subagent ("sidechain") and internal ("meta") entries so you get
the same linear conversation you'd see in the Claude Code TUI. OpenCode
sessions are read via the `opencode` CLI (`session list --format json` and
`export <id>`) rather than its internal SQLite format directly, since that
format has changed before and the CLI is the stable surface - `export` falls
back to reading OpenCode's SQLite database directly (via `node:sqlite`,
which needs **Node.js 22.5+**) only when the CLI's own export is incomplete,
e.g. while the OpenCode server is running.

`src/converters/claude-to-opencode.js` converts Claude Code into OpenCode's
import/export JSON shape; `src/converters/opencode-to-claude.js` runs the
reverse direction. Both are built on the same import/export JSON contract,
reverse-engineered from `opencode@1.18.5` by round-tripping synthetic
sessions through `opencode import ...` / `opencode export ...` and reading
OpenCode's generated SDK types in `@opencode-ai/sdk/dist/gen/types.gen.d.ts`.

Forward (`claude-to-opencode.js`) mapping:

- Claude's `text` / `thinking` blocks → OpenCode `text` / `reasoning` parts.
- Claude's `tool_use` blocks → OpenCode `tool` parts. The matching
  `tool_result` (or the raw `toolUseResult` field on the following entry) is
  folded into the tool part's `state` instead of being rendered as a
  separate message. If no result is found, the part is marked `status:
  "pending"`.
- Claude's synthetic "here's your tool result" user turn is *not* emitted as
  its own OpenCode message (it would show up as an empty bubble); its content
  is already captured in the tool part above.
- Empty assistant turns (e.g. redacted thinking blocks that keep only a
  `signature` and no text) are also skipped to avoid blank bubbles.

Reverse (`opencode-to-claude.js`) mapping:

- OpenCode `text` / `reasoning` parts → Claude `text` / `thinking` blocks.
- OpenCode `tool` parts are expanded back into the two-entry structure Claude
  Code uses: an assistant entry containing a `tool_use` block, followed by a
  synthetic user entry containing the matching `tool_result` block plus a
  `toolUseResult` fallback.
- A **fresh, deterministic Claude session UUID** is generated from the
  OpenCode session id rather than reusing the `ses_...` id (the formats are
  intentionally different).

**IDs are always deterministic** in both directions - sha256 over the source
tool's own ids, never `crypto.randomUUID()` - which is what makes re-forking
idempotent: importing the same session twice produces the same target id
and (for `fork`) byte-identical output, so the ledger records nothing on the
second run instead of a duplicate. **Timestamps** are derived from the
source's own recorded times where available; the one exception is a Claude
entry converted from an OpenCode message that has no `time.completed` or
`time.created` at all, which falls back to the current wall clock for that
entry's cosmetic timestamp field only - the entry and session *ids* stay
deterministic regardless. `sync` additionally stamps the OpenCode session's
`time.updated` with the real current time on every real merge (a sync
legitimately happens "now"), but a `sync` or `watch` cycle with nothing new
on either side still returns before writing anything, so it stays a true
no-op like `fork`.

The ledger (`.agentbridge/ledger/` inside the target project) is its own
nested git repo, not your project's own repo - `.agentbridge/` is
`.gitignore`d for you. Each fork or sync writes `claude/<id>.jsonl` and
`opencode/<id>.json` (raw or converted, depending on direction) plus a
`mapping.json` recording every known Claude-id ↔ OpenCode-id pair, which is
how `sync`/`watch`/`log` resolve either id back to its counterpart and to
the last-synced baseline.

Override `--provider` / `--agent` on `fork`/`sync`/`watch` if your OpenCode
config names its provider or agent differently than the defaults
(`anthropic` / `build`).

## Known limitations

- Parallel tool calls within a single assistant turn are matched to their
  results positionally (FIFO) when Claude Code doesn't tag the result with a
  `tool_use_id`. This is correct for the common one-tool-per-turn case;
  heavily parallel tool use could mis-pair in rare cases.
- File attachments, permission prompts, Claude Code slash commands, and
  OpenCode part types besides `text` / `reasoning` / `tool` aren't converted.
- One session at a time; no batch mode.
- `sync` merges by timestamp; it does not de-duplicate semantically
  identical turns added independently on both sides.
- The OpenCode SQLite fallback in `src/readers/opencode-reader.js` needs
  Node.js 22.5+ (`node:sqlite`). On older Node it silently falls back to the
  `opencode` CLI's own `export`, which can itself be incomplete while the
  OpenCode server is running or after an imported session has been
  continued.

## Contributing

PRs welcome. This repo uses two long-lived branches - `dev` for ordinary
work, `main` for what's released to npm - and PRs target `dev` by default
(CI/CD-only changes target `main` directly). See `CLAUDE.md` and
`agents/skills/` for the full development conventions (tests, code style,
PR shape, documentation) before opening one.

## License

MIT © neerajvipparla. See [LICENSE](LICENSE).
