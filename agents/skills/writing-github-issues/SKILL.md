---
name: writing-github-issues
description: Use when you encounter a bug, unexpected behavior, missing feature, or operational papercut, and need to capture it as a GitHub issue so the next agent or human can pick it up.
---

# Writing GitHub Issues

## The rule

**If a problem isn't tracked, it's not real.**

A vague note in chat is not a substitute for a GitHub issue. A well-written issue survives the end of the current session and lets the next person start from a shared understanding instead of rediscovering the same bug, asking the same questions, and making the same wrong assumptions.

## Issues are not PRs

**Filing an issue does not mean you must immediately open a PR for it.** A PR is a unit of delivery, not a unit of discovery. The goal of an issue is to capture the problem durably; the goal of a PR is to deliver a coherent change that can be reviewed, tested, and merged.

Batch small related issues into one PR. Examples of a single, coherent PR:

- Three stale README file paths found while reading the same module
- Two typo fixes in the same command help text
- A small bug fix plus the test that reproduces it, plus a README update that documents the corrected behavior

Do **not** create a separate PR for every one-line fix unless each one is genuinely unrelated and risky to batch. The "one concern per branch" rule from `shipping-via-pull-requests` means "don't mix unrelated work" — it does not mean "one issue equals one branch." Multiple small fixes in the same area, discovered in the same pass, are one concern.

When you are working on a larger feature, open the design issue first, then open the implementation PR when the work is significant enough to stand on its own. A tracking issue with a checklist is fine for a multi-step feature, but each checklist item should not become its own PR unless it truly could be merged independently.

## Before you file

Reproduce it at least once. If you can't reproduce it, say so explicitly in the issue and explain what you *did* observe. Don't file an issue for a one-time hallucination with no evidence unless you also explain why you believe it's real despite not reproducing it.

Check whether the issue already exists:

```bash
gh issue list --state all --search "<keyword>" --limit 20
```

If a related issue exists, add a comment there instead of opening a duplicate. If you're unsure whether it's the same issue, open a new one and explicitly mention the related issue by number, explaining why you think it's different.

## Required fields

Every issue must have these five sections, in this order. Omitting one makes the issue harder to act on.

### 1. What is the issue

A single sentence a stranger can understand. Then one paragraph of context, written from the user's perspective:

```
Forked Claude Code session to OpenCode, sent a follow-up prompt, and OpenCode
appeared to ignore it until I clicked "revert to last message".
```

State the observed behavior and the expected behavior. If you only have observed behavior, say so: "Expected behavior is unclear — we need to decide what should happen here."

### 2. Type of issue

Pick exactly one:

| Type | Meaning | Example |
|---|---|---|
| `bug` | Something that worked or should work is broken or wrong | `fork --dry-run` records a new commit on an unchanged session |
| `feature` | New capability that doesn't exist yet | Add `--strategy grouped` to keep each side's turns together on sync |
| `improvement` | Existing behavior works but should be better | README install steps don't mention the scoped npm name |
| `small fix` | Typo, stale comment, broken link, or trivially safe one-liner | README references `converter.js` instead of `src/converters/claude-to-opencode.js` |

If you hesitate between two, pick the more serious one. A bug masquerading as an improvement gets ignored; an improvement labeled as a bug gets corrected quickly.

### 3. Components involved

Name the actual files, functions, commands, or external integrations. Don't say "the sync logic" — say:

- `src/sync/sync.js` — `mergeSync()`
- `src/sync/watch.js` — `watchSession()`
- `bin/agentbridge.js` — `fork` command wiring
- `src/readers/opencode-reader.js` — `exportSession()`
- `.github/workflows/publish-npm.yml`
- `opencode import` / `opencode export` CLI boundary

For each component, add one line on why it's involved. This is what lets the next agent reason about blast radius without re-reading the whole repo.

### 4. Reproduction steps

Numbered, exact, minimal. Every command should be copy-pasteable. Include the environment:

```
1. Run `agentbridge fork <inactive-claude-id> -d <project>` without `--dry-run`.
2. Run `opencode --session <ses_...>` or let OpenCode auto-switch to the imported session.
3. Type a new prompt immediately and press Enter.
4. Observe that the prompt does not appear to trigger a model response.
5. Click "revert to last message" in the OpenCode UI.
6. Observe that the prompt now triggers a response.
```

If the issue is a design question rather than a reproducible bug, replace this section with "Not a runtime bug — see Suggestions below for the design decision needed."

### 5. Suggestions for the agent picking this up

This is the most important section. Be explicit about what the next person should do:

- **Where to start reading.** Point at one file and one function.
- **What to verify first.** E.g. "Confirm that `opencode import` followed immediately by `opencode export <id>` returns the full session, or if messages are delayed."
- **What decision the user or project needs.** E.g. "Decide whether to add a post-import retry loop, document a manual wait step, or both."
- **What not to do.** E.g. "Do not change the converter output shape until we know the data isn't reaching OpenCode — this looks like a UI handoff issue, not a conversion issue."

## Labels

Always add at least one label. If no labels exist yet, create the obvious ones:

- `bug`, `feature`, `improvement`, `small fix`
- `sync`, `fork`, `cli`, `ci-cd`, `docs`

Use `good first issue` only for `small fix` items with a clear, bounded change.

## Creating the issue

```bash
gh issue create --title "OpenCode UI ignores prompt immediately after fork" \
  --label "bug, sync" \
  --body-file /tmp/issue-body.md
```

If the body is short enough to fit inline, use `--body` instead. Prefer `--body-file` — it keeps the markdown readable.

## Red flags - stop and rewrite

- Title is a question, not a statement of the problem
- No reproduction steps for a bug
- "It doesn't work" without saying what "it" is or what "work" looks like
- No component names, only vague nouns like "sync" or "the converter"
- Suggestions section says "fix it" without saying where to start
- Issue duplicates an existing one without explaining why it's separate

## Anti-patterns

- Using an issue as a scratchpad or todo list for unrelated tasks
- Filing one issue for two unrelated problems
- Describing a symptom without a reproduction, then guessing a root cause in the title
- Forgetting to mention that the bug was observed in a forked session imported from the other tool — that's the central scenario of this project, and omitting it wastes time

## Common mistakes

| Mistake | Why it's wrong | What to do instead |
|---|---|---|
| One issue per one-line fix | Creates noise and review friction; the project ends up with dozens of open PRs each changing a single character | Batch related small fixes into one PR and reference all fixed issues in the PR body |
| Opening a PR immediately after every issue | An issue is a tracker, not a delivery mechanism | Group issues that touch the same files or same behavior into a single implementation pass |
| "I'll open a PR for each step" of a feature | Every PR must be independently mergeable; half-finished plumbing PRs block review and create dependency chains | Use a tracking issue with checkboxes, then open PRs for complete, reviewable slices |
| Skipping the issue because the fix is "too small" | Even a one-word fix needs a record of why it changed, and the next person needs to know it happened | File the issue, but batch the fix with other small items rather than creating a separate PR |

Remember: the issue count is not a score. A well-organized set of issues and a smaller number of focused PRs is better than an issue and a PR for every keystroke.
