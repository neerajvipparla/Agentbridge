# Sync divergence strategies — design

Date: 2026-07-26
Status: approved, pending implementation plan

## Problem

`agentbridge sync` already detects divergence (both sides changed since the
last fork/sync) via two strategies: `timestamp` (auto-merge) and `abort`
(refuse and report counts). Two things about today's `timestamp` strategy
don't match what's actually wanted:

1. **Ordering.** `timestamp` currently sorts the merged result by real
   wall-clock timestamp, interleaving both sides' new turns. The wanted
   behavior is different: each side's *own* new turns first, then the
   *other* side's new turns appended after — grouped by origin, not
   time-interleaved.
2. **No way to pick a winner.** When both sides have diverged and you don't
   want to keep both branches, there's no way to say "keep only this side's
   continuation, drop the other's."

### Concrete scenario driving this

A session is forked from Claude Code to OpenCode at message N (both sides
identical up to N). Afterward, both sides diverge independently:

- Claude Code gets native turns N+1, N+2
- OpenCode gets native turns N+1′, N+2′, N+3′

Running `sync` should, by default, produce on **each** side: baseline, then
that side's own native new turns, then the other side's new turns
(converted), appended after — not interleaved by timestamp. Concretely, the
Claude Code transcript becomes `[...baseline, N+1, N+2, N+1′, N+2′, N+3′]`
and the OpenCode session becomes
`[...baseline, N+1′, N+2′, N+3′, N+1, N+2]`.

Separately, an explicit override lets you pick one side's branch and drop
the other's entirely, while the common baseline is preserved on both.

## Decisions

Resolved through discussion before this doc was written; not open questions:

1. **`--strategy` grows two new values**: `timestamp` (default, redefined
   per above), `abort` (unchanged), `persist-claude`, `persist-opencode`.
   No separate `--persist` flag — one flag, one place to look, and it's
   impossible to pass a contradictory combination of `--strategy` and
   `--persist`.
2. **`persist-claude`** merges to `baseline + claudeNew` on both
   representations; `opencodeNew` is discarded entirely (not appended, not
   converted, not written anywhere in the live files).
   **`persist-opencode`** is the mirror image.
3. **Safety net for persist-\*:** none beyond what already exists. The
   ledger is a git repo; the pre-sync commit still has the discarded
   branch's content in history, recoverable via `git log`/`checkout`
   inside `.agentbridge/ledger/` if truly needed. No extra confirmation
   step, no dry-run requirement.
4. **`persist-claude`/`persist-opencode` are `sync`-only, not `watch`.**
   `watch` is unattended and continuous; leaving it running in a mode that
   silently discards one side's turns on every poll is a different, riskier
   feature than what's being built here. Not in scope.
5. **`timestamp`'s existing semantics are being redefined**, not preserved
   under a new name. `tests/sync.test.js`'s existing `T5` ("timestamp merge
   interleaves both sides correctly") encodes the *old* contract and will be
   rewritten to assert the new one, using the exact N/N′ scenario above as
   its fixture.
6. **Code structure: one function per strategy, `mergeSync` becomes a thin
   dispatcher** (chosen over patching more branches into the existing
   function). Two strategies bolted onto one function was fine; four
   justifies the split - matches how the rest of this codebase is already
   built (reader/converter/writer/ledger as small, single-purpose stages),
   and each strategy becomes independently readable and testable.

## Architecture

```
sync command (bin/agentbridge.js)
        │
        ▼
syncSession()  ── loads current + last from ledger, unchanged from today
        │
        ▼
mergeSync(current, last, strategy, opts)
        │
        ├─ diffSync(current, last) → { claudeNew, opencodeNew }   (once, shared)
        │
        └─ dispatch by `strategy` to one of:
              mergeTimestamp(current, last, diff, opts)   [redefined]
              mergeAbort(current, last, diff, opts)       [unchanged]
              mergePersistClaude(current, last, diff, opts)   [new]
              mergePersistOpencode(current, last, diff, opts) [new]
                    │
                    ▼
        { claudeEntries, opencodeMessages, claudeNew, opencodeNew }
                    │
                    ▼
syncSession() continues exactly as today: no-op check, dry-run,
write Claude file, import into OpenCode, commit to ledger.
```

**Finding that shrinks the implementation:** `watch`'s existing strategy
validation in `bin/agentbridge.js` already only accepts `"timestamp"` or
`"abort"` - `persist-claude`/`persist-opencode` are rejected there
automatically today, with no code change needed to keep persist-* off
`watch`. This gets an explicit test (decision 4) but not new logic.

## Components

- **`diffSync(current, last)`** - unchanged. Computes `claudeNew`/
  `opencodeNew` by turn-key (uuid, or a stable content hash when uuid is
  absent). Strategy-agnostic; every strategy function receives its output
  rather than recomputing it.

- **`mergeTimestamp(current, last, diff, opts)`** *(redefined)* - for each
  side: `[...baseline, ...ownNativeNewTurns, ...otherSideNewTurnsConverted]`,
  in that order. Within `ownNativeNewTurns` and `otherSideNewTurnsConverted`,
  turns keep their original relative order (the order `diffSync` found them
  in, which `convertToOpenCode`/`convertToClaude` preserve) - only the
  *interleaving between the two groups* is removed, not the order within
  each. No sort by timestamp. Parent-chain fields (`parentUuid` /
  `parentID`) are recomputed linearly over the concatenated result, same as
  today - just without the interleaving sort step beforehand.

- **`mergeAbort(current, last, diff, opts)`** - unchanged: throws when both
  `claudeNew` and `opencodeNew` are non-empty, reporting counts. When only
  one side has new turns (nothing to abort over), it merges exactly like
  `mergeTimestamp` - trivially identical in that case, since there's only
  one side's turns to place and no interleaving question to differ on.

- **`mergePersistClaude(current, last, diff, opts)`** *(new)* -
  `[...baseline, ...claudeNew]` on the Claude side; the same list converted
  to OpenCode's format via `convertToOpenCode` on the OpenCode side.
  `opencodeNew` is read from `diff` only to report "N turns discarded" in
  the CLI message - never appended or converted.

- **`mergePersistOpencode(current, last, diff, opts)`** *(new)* - mirror of
  the above.

- **`mergeSync(current, last, strategy, opts)`** - becomes a small dispatch
  table (`{ timestamp: mergeTimestamp, abort: mergeAbort, "persist-claude":
  mergePersistClaude, "persist-opencode": mergePersistOpencode }`) plus the
  shared `diffSync` call. The same object is the single source of truth for
  "what strategies exist," used both for dispatch and for validating the
  `--strategy` value - not duplicated between validation and the CLI's
  `--help` text.

- **`bin/agentbridge.js`** - `sync`'s `--strategy` option description text
  is updated to list all four values. `watch`'s option text and inline
  validation are untouched (still `timestamp`/`abort` only).

## Data flow

1. `syncSession` loads `current` (live Claude + OpenCode state) and `last`
   (ledger baseline) - unchanged from today.
2. `mergeSync` runs `diffSync` once, dispatches to the matching strategy
   function.
3. The strategy function returns the merged representations plus the raw
   `claudeNew`/`opencodeNew` diff (used for the "N new turns" console
   message).
4. `syncSession` compares the merged output's actual content against `last`
   (same check as today) to decide whether anything really changed before
   writing files or committing to the ledger.

**No-op case, handled without special-case code:** with `persist-opencode`,
if Claude has new turns but OpenCode has none, the merged output is
`baseline + nothing` - byte-identical to `last`. The existing "did the
content actually change" check and `commitFork`'s git-level "nothing to
commit" detection already catch this and report `changed: false`, the same
way re-running `fork` on an unchanged session is already a no-op today.
Discarding a side that had nothing to discard is correctly a no-op, with no
new logic required to make it so.

## Error handling

- Unknown `--strategy` value on `sync` → existing error message, extended
  to list all four valid values (sourced from the dispatch table, per
  Components above).
- `persist-claude`/`persist-opencode` passed to `watch` → already rejected
  by `watch`'s existing inline check; no new code, covered by a new test
  instead (see below).
- `--dry-run` → unaffected for any strategy; it already just skips the
  write/import/commit step after the merge is computed.

## Testing

Per `agents/skills/writing-tests-first`: every behavior change gets a test
that can actually fail if the behavior regresses.

- **Redefine `T5`** in `tests/sync.test.js`: currently asserts `timestamp`
  interleaves both sides by time - rewritten to assert the new
  grouped-by-origin contract, using the exact N+1/N+2 (Claude-native) /
  N+1′/N+2′/N+3′ (OpenCode-native) scenario from this doc's Problem section
  as the fixture.
- **New test**: `mergePersistClaude` - the OpenCode-only new turns are
  absent from *both* merged representations; Claude's new turns are present
  in both (native on the Claude side, converted on the OpenCode side).
- **New test**: `mergePersistOpencode` - mirror of the above.
- **New test**: `persist-opencode` with zero new Claude turns is a true
  no-op - `commitFork` reports `changed: false`.
- **New test**: `watch` rejects `persist-claude` and `persist-opencode` with
  its existing "Unknown strategy" error - makes the already-existing
  constraint an explicit, asserted contract rather than incidental
  behavior.

## Non-goals (explicitly out of scope for this change)

- Semantic/fuzzy duplicate detection (recognizing two differently-worded
  turns as "the same" turn). Already a stated known limitation; unrelated
  to the ordering and persist-* behavior this design adds.
- An interactive or guided conflict-resolution UI beyond `abort`'s existing
  "refuse and report counts" behavior.
- `persist-claude`/`persist-opencode` support in `watch` (decision 4).
- Any change to `fork`'s behavior - this design only touches `sync`
  (and, incidentally, confirms `watch`'s existing strategy validation needs
  no change).
