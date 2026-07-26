---
name: writing-documentation
description: Use when adding or changing a CLI flag, converter output shape, invariant, or known limitation, and when writing or updating README.md, CLAUDE.md, module header comments, or JSDoc in this repo.
---

# Writing Documentation

## One fact, one home

Every fact about this project lives in exactly one layer; the others link to it by name. Duplicated facts diverge, and then the reader cannot tell which copy is current.

| Layer | Audience | Holds | Does not hold |
|---|---|---|---|
| **JSDoc** | caller of a function | the contract: params, types, return, what "absent" means | why the module exists |
| **Module header** (`src/*.js` top block) | someone editing this file | the file's responsibility, the external format it speaks, where that format's rules came from | usage instructions |
| **README.md** | a human deciding whether to use the tool | install, commands, how the conversion works, known limitations, roadmap | invariants an editor must not break |
| **CLAUDE.md** | an agent operating in the repo | commands, the verification loop, invariants, load-bearing details | a retelling of the README |
| **`agents/skills/`** | an agent doing recurring work | how to do a repeating task well; code facts *cited as examples* | the canonical statement of a code fact — CLAUDE.md and README own those |

When a fact seems to belong in two layers, pick the narrower audience and have the wider one point at it. CLAUDE.md *states* the determinism invariant; `writing-tests-first` names it and says which test pins it, without restating what it is.

## What every piece carries

**Runnable commands.** Copy each documented command, run it, paste back what it printed. A command that assumes a directory exists either says so or creates it.

**Provenance on anything reverse-engineered.** Version probed, method used, symptom when it drifts. The README does this for the OpenCode payload shape: derived from `opencode@1.18.5` by round-tripping `import`/`export`, zod-validated, so drift arrives as a field-named error. Without all three, a future reader cannot tell knowledge from guess.

**Failure modes, not just the happy path.** What the command prints when it finds nothing; what happens when a tool call never finished; what "No changes since last fork" means.

**Honest limitations, shipped with the feature.** README's "Known limitations (v1)" is part of the deliverable, not an admission. When you find a case the code handles poorly, the limitation list *is* the change.

**Unbuilt work labelled unbuilt.** README's "Phase 2 (not built yet)" heading replaces a paragraph of hedging. Keep that labelling literal — never describe intended behavior in the present tense.

## Update triggers

A change is not complete until its docs are. Match the change:

| You changed | Update |
|---|---|
| A CLI flag or command | README usage block, and the `commander` `.description()` that feeds `--help` |
| Converter output shape | README "How the conversion works", plus the Blast radius note in the PR |
| An invariant, or added a load-bearing line | CLAUDE.md load-bearing details, and the comment at the line itself |
| Verification steps or commands | CLAUDE.md Commands |
| Found a case handled poorly | README known limitations |
| An external format's rules | The module header that speaks that format, with the version you verified against |
| A recurring task an agent will repeat | A skill in `agents/skills/`, not a README section |

## Style

Present tense, active voice, second person for instructions. Say what the reader does and what they will see.

- State the mechanism, not the adjective: "re-forking an unchanged session records no new commit" beats "forking is efficient".
- Name things exactly as the code names them — `toConversation`, ledger, part, entry. A synonym introduced in prose becomes a second vocabulary.
- One real example beats three abstract ones. `/Users/me/.config/my_app` → `-Users-me--config-my-app` teaches the whole encoding rule in one line.
- No marketing language, no "simply", no "just".

## Anti-patterns

- Prose restating the code line beneath it
- An example that no longer runs — the most expensive kind of documentation, because it is trusted
- A version number with no note on how it was verified or what happens when it moves
- `TODO: document this`
- Copying a CLAUDE.md section into the README, or the reverse
- Describing Phase 2 behavior in the present tense
