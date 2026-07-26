---
name: writing-readme
description: Use when creating a README.md for the first time, or before adding to, reordering, or rewriting any section of an existing one - installation steps, usage examples, command or flag lists, architecture claims, or the project description.
---

# Writing READMEs

## The verification rule

**Every claim in the README must trace to something you read or ran, not to what the code is supposed to do, used to do, or is named as if it does.**

A README is the one document a stranger reads before they trust anything else you say about the project. A wrong install command or a stale file path costs them more than no README at all - it costs the time they spend debugging your documentation before they give up.

Closing the specific shortcuts:

- **Naming a file path in prose** - grep for it or Read it this session. Don't name a file from memory or from what an earlier version of the README called it.
- **Describing a flag or command** - run `--help`, or read the argument parser. Don't infer behavior from what the flag's name suggests it should do.
- **Stating a behavior** ("X is deterministic", "Y falls back to Z", "this requires version N") - find the line of code that makes it true. Don't assume it from the surrounding design intent.
- **Showing example output** - run the command for real and paste what it actually printed, redacting only genuinely sensitive values. Don't fabricate plausible-looking output.
- **Carrying a claim forward** from an older draft or a different section - re-verify it, don't assume it still holds just because it's already written down somewhere.

## Rationalizations

| Excuse | Reality |
|---|---|
| "I already know this codebase" | Knowledge decays the moment someone else's commit lands. Verifying costs one grep; being wrong costs a stranger's first five minutes. |
| "The flag name makes it obvious" | `--strategy abort` doesn't tell you what "abort" actually does until you read the handler. |
| "I'll fix it if someone files an issue" | A wrong install command is the first thing a new user hits - and the reason they leave before ever filing that issue. |
| "It's just a doc change, low risk" | A stale file path in prose sends the next reader, human or agent, to edit the wrong file with full confidence. |
| "The old README already said this" | The old README could already be wrong. Age is not evidence. |

## Red flags - stop and verify

- Naming a file path you have not opened or grepped for this session
- Describing a flag's behavior without having read its handler or run `--help`
- An example command block you have not actually run
- Copying a paragraph forward without re-checking it against current code

## What a good README contains

Two real specs agree on the core shape - [makeareadme.com](https://www.makeareadme.com/) (name, description, install, usage, support, contributing, license, in that rough order, erring toward longer and more explicit rather than shorter) and the stricter [standard-readme spec](https://github.com/RichardLitt/standard-readme/blob/master/spec.md) (title, short description, install, usage, contributing, license - in that exact order, license always last). For a CLI specifically, task-oriented documentation practice adds: answer "what is this" in the first line, show a working command within the first screenful, and document flags/defaults/aliases without trying to inline every one - point to `--help` for the exhaustive list rather than duplicating it and letting the duplicate drift.

Synthesized order for a CLI tool:

1. **Name + one-line description** - what it does, stated as behavior, not marketing.
2. **The command surface** - the actual commands/flags, shown as a block, before installation. For a CLI, what it *does* is more persuasive than how to get it.
3. **Install** - copy-pasteable, every command run and confirmed before it's written down.
4. **Usage / typical flow** - task-oriented examples with real output, not a flag-by-flag reference.
5. **How it works** (optional) - only if the mechanism is non-obvious enough that a user or contributor needs it to trust or extend the tool.
6. **Known limitations** - stated plainly, not buried or omitted. A limitations section a stranger can read in ten seconds is worth more than silence they discover the hard way.
7. **Roadmap / not-yet-built work** (optional) - labelled as such, in present tense only for what's actually true today.
8. **Contributing**, then **License** - last, always.

Don't inline exhaustive flag documentation inside every section - state it once, point elsewhere (`--help`, a docs site, or an API reference) for the rest. A README that tries to be the complete reference becomes the copy that drifts from the real one.

## Scope

This skill covers the README's own internal shape and the discipline for keeping its claims true. It does not cover *which* document a given fact belongs in (README vs `CLAUDE.md` vs a module header vs JSDoc) - see `writing-documentation` for that layering, and cross-reference it rather than duplicating its update-trigger table here.

## Before calling a README edit done

- Every command block in the diff has actually been run, this session, against the current code
- Every file path named in prose exists at that exact path right now
- Every flag/behavior claim was read in source, not inferred from a name
- License section (if present) is last
- Nothing describes unbuilt work in the present tense
