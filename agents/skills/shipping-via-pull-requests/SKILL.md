---
name: shipping-via-pull-requests
description: Use when starting a feature or bugfix, when on branch main or dev with changes to make, or when preparing to open, review, or merge a pull request in this repo.
---

# Shipping via Pull Requests

## The rule

**Neither `main` nor `dev` receives a direct commit. Every change lands through a pull request.**

This repo has two long-lived branches: `dev` is where ordinary work happens; `main` is what the publish workflow (`.github/workflows/publish-npm.yml`) actually runs from and what gets released to npm.

**PRs target `dev` by default.** The one exception: a change whose diff is entirely under `.github/workflows/` (CI/CD) targets `main` directly - there's nothing for `dev` to gain from carrying a CI-only commit it doesn't act on. If a branch touches both application code and a workflow file, split it: that's two concerns anyway (see below).

Branch before the first edit, not after. If you have already edited files on `dev` or `main`, stop and move them — uncommitted work follows the checkout, nothing is lost:

```bash
git checkout dev && git pull origin dev
git checkout -b feat/short-description
```

For a CI/CD-only change, branch from `main` instead:

```bash
git checkout main && git pull origin main
git checkout -b ci/short-description
```

Branch names: `feat/`, `fix/`, `refactor/`, `docs/`, `test/`, `ci/` plus a kebab-case phrase naming the outcome — `feat/opencode-to-claude-converter`, `fix/untagged-tool-result-dropped`, `ci/bump-action-versions`.

**One concern per branch.** A single feature or bugfix is one concern, and it includes its tests, docs, and any small related fixes that would be meaningless to ship without it. A branch that fixes a bug *and* renames three functions gets split in two. A branch that adds `--strategy grouped` to `sync` and updates the README and adds a test is one concern. Reviewers approve what they can hold in their head, not what you can fit in one line.

## A feature is one PR, not a family of PRs

A branch named `feat/...` should contain the whole feature as one reviewable unit. That means:

- The implementation code
- Tests that exercise the new behavior
- README / CLAUDE.md / skill updates that explain the change to users and future agents
- Any small fixes you discover along the way that are required for the feature to work (e.g. fixing a stale file path you only notice because you're documenting the new flow)

Do not split a feature into separate PRs for "the code", "the tests", and "the docs" unless each piece could truly be merged and shipped independently. A docs PR that describes a feature that doesn't exist yet is not independently useful; a test PR for code that hasn't merged yet is not independently mergeable. Keep them together.

This is the same rule as "one concern per branch" — the concern is the feature. The docs and tests are part of the feature, not separate concerns.

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
gh pr create --base dev --title "..." --body-file <path>
```

Always pass `--base` explicitly. Don't rely on `gh pr create`'s default - that follows the repository's configured default branch, which may not be `dev`.

## Merging

- Never merge with a failing check or an unaddressed review comment.
- Squash-merge unless the individual commits each tell a story worth keeping.
- Delete the branch after merge.
- Never force-push a branch someone else has reviewed or pulled — push a fixup commit instead.
- Do not merge your own PR when a human was asked to review it.

## Rationalizations

| Excuse | Reality |
|---|---|
| "It's a one-line fix, dev is fine" | Branching costs one command. One-line fixes are exactly the ones that ship unreviewed and break determinism. |
| "It's my repo, nobody else reviews it" | The PR is the durable record of *why*. `git log` on a squashed branch tells you what changed and nothing else. |
| "I'll open the PR once I finish the next thing too" | That is two concerns in one branch. Open the first one now. |
| "Tests pass, the blast radius is obvious" | Obvious to you, today. Write the two lines. |
| "I'll amend and force-push to address the review comment" | Reviewers lose their place. Push a new commit; squash at merge. |
| "It's just a workflow file, main is fine" | CI/CD changes go to `main` directly by design (see above) - but still through a PR, not a direct commit. |
| "The dry-run check is slow, CI will catch it" | The publish workflow only runs on `main` and only checks that a version isn't republished - it does not run the converter dry-run gate. You are still the check for that. |
| "Docs should be a separate PR" | Docs for a feature that doesn't exist yet are not independently useful. The feature and its docs are one concern. |
| "Tests should be a separate PR" | A test for code that isn't merged yet can't be merged yet either. Tests are part of the feature. |
| "I'll make a PR for each step of the feature" | Half-finished plumbing PRs block review and create dependency chains. Open PRs for complete, reviewable slices, or keep the whole feature on one branch. |

## Red flags

- `git commit` while `git branch --show-current` prints `main` or `dev`
- A Verification section that says "tested locally"
- A PR touching `converter.js` with no Blast radius note
- A diff carrying both a bugfix and unrelated cleanup
- A PR mixing application code with a `.github/workflows/` change
- A feature split into separate PRs for code, tests, and docs when none can ship independently
- `git push --force` on a branch that has review comments
