---
name: shipping-via-pull-requests
description: Use when starting a feature or bugfix, when on branch main with changes to make, or when preparing to open, review, or merge a pull request in this repo.
---

# Shipping via Pull Requests

## The rule

**`main` receives no direct commits. Every change lands through a pull request.**

Branch before the first edit, not after. If you have already edited files on `main`, stop and move them — uncommitted work follows the checkout, nothing is lost:

```bash
git checkout -b feat/short-description
```

Branch names: `feat/`, `fix/`, `refactor/`, `docs/`, `test/` plus a kebab-case phrase naming the outcome — `feat/opencode-to-claude-converter`, `fix/untagged-tool-result-dropped`.

**One concern per branch.** A branch that fixes a bug *and* renames three functions gets split in two. Reviewers approve what they can hold in their head.

## Commits

Imperative subject under ~72 chars saying what the commit does; body saying why it was needed. The reader is someone bisecting in six months with no other context.

```
Seed pending tool ids from assistant entries in pass one

Untagged toolUseResult payloads were dropped because the FIFO queue was
only populated during the emit pass, which runs after the user entry
carrying the result. Pairing now works for sessions recorded by Claude
Code versions that omit tool_use_id.
```

Never commit `.agentbridge/` (gitignored), temp import payloads left behind by a failed `opencode import`, or handoff/scratch transcripts.

## Before opening it

Run these and read the output. The PR quotes the real output, never the word "tested".

```bash
node --test                                                # if test/ exists
node bin/agentbridge.js fork <id> --dry-run -d <project>
node bin/agentbridge.js fork <id> --dry-run -d <project>   # must print "No changes since last fork"
node bin/agentbridge.js log -d <project>
```

The second dry-run is the idempotency gate. If it records a commit instead of reporting no change, determinism is broken — do not open the PR.

## What the PR body is

Five sections, in this order, a few lines each:

**Problem** — what was wrong or missing, in terms of behavior a user hits. Not a restatement of the diff.

**Approach** — how you solved it, plus any alternative you rejected and why. Omit only when the diff is one obvious line.

**Verification** — the commands you ran and their actual output, including the idempotency gate.

**Blast radius** — answer both, every time:
- *Does this change `converter.js` output for existing sessions?* If yes, say so: the next `fork` of an already-forked session records a new ledger commit and OpenCode re-imports it. Expected, but it must be announced.
- *Does this change the OpenCode payload shape?* If yes, name the `opencode` version you verified against and how.

**Docs** — which of README.md / CLAUDE.md / module headers you updated, or the one-line reason none needed it.

```bash
git push -u origin feat/short-description
gh pr create --title "..." --body-file <path>
```

## Merging

- Never merge with a failing check or an unaddressed review comment.
- Squash-merge unless the individual commits each tell a story worth keeping.
- Delete the branch after merge.
- Never force-push a branch someone else has reviewed or pulled — push a fixup commit instead.
- Do not merge your own PR when a human was asked to review it.

## Rationalizations

| Excuse | Reality |
|---|---|
| "It's a one-line fix, main is fine" | Branching costs one command. One-line fixes are exactly the ones that ship unreviewed and break determinism. |
| "It's my repo, nobody else reviews it" | The PR is the durable record of *why*. `git log` on a squashed main tells you what changed and nothing else. |
| "I'll open the PR once I finish the next thing too" | That is two concerns in one branch. Open the first one now. |
| "Tests pass, the blast radius is obvious" | Obvious to you, today. Write the two lines. |
| "I'll amend and force-push to address the review comment" | Reviewers lose their place. Push a new commit; squash at merge. |
| "The dry-run check is slow, CI will catch it" | There is no CI in this repo. You are the check. |

## Red flags

- `git commit` while `git branch --show-current` prints `main`
- A Verification section that says "tested locally"
- A PR touching `converter.js` with no Blast radius note
- A diff carrying both a bugfix and unrelated cleanup
- `git push --force` on a branch that has review comments
