---
name: writing-quality-code
description: Use when adding a module, refactoring existing code, reaching for an abstraction or a design pattern, or writing or revising comments in this repo.
---

# Writing Quality Code

## The module contract

Every module in `src/` satisfies all four. A new module makes them true of itself; an edit keeps them true.

1. **Pure core, effects at the edges.** `converter.js` takes data and returns data — no filesystem, no network, no subprocess, no clock, no randomness. `claude-reader.js` reads. `git-ledger.js` and `opencode-import.js` write and shell out. Put a transform in the core; put an effect in an edge module, thin enough to skip in tests.
2. **Derive, never generate.** Ids come from `deriveId()` (sha256 over Claude's own uuids); times come from entry timestamps. `crypto.randomUUID()` and `Date.now()` do not appear in the core. CLAUDE.md states what breaks when they do.
3. **The dependency graph is a line.** `bin/` → `claude-reader` → `converter` → `git-ledger` → `opencode-import`. No module imports one to its left. `converter.js` takes plain entry objects; it must not import `claude-reader.js` to reshape them itself.
4. **Never invent data to satisfy a schema.** A tool call with no result becomes `status: "pending"` — not a fabricated empty output that looks completed. When input is missing, say missing.

## Choosing an abstraction

**One implementation gets no interface.** The trigger to extract one is the *second* implementation existing in the tree — here, `opencode-to-claude.js` landing (README, Phase 2). Until that file exists, a `ConverterFactory`, a strategy registry, a `BaseConverter`, or a plugin lookup adds indirection with nothing on the other side of it.

Patterns that already describe this codebase, by their real names:

- **Pipes and filters** — the four-stage pipeline. New work is usually a new stage or a change inside one, not a new coordinating layer.
- **Adapter** — `converter.js` adapts Claude Code's session format to OpenCode's. Format knowledge lives here and nowhere else.
- **Repository** — `git-ledger.js` is the only thing that knows the ledger is a git repo. Callers ask for a commit; they never see `execFileSync`.

Before adding a pattern, name the second concrete case it serves. If you can only name a hypothetical one, you are early.

## What comments carry

Code says what. Comments carry the three things code cannot.

**1. Load-bearing warnings, at the point of temptation.** When code looks simplifiable and is not, the comment names what breaks — and, when known, that it already broke once:

```js
// Claude Code names each project directory after its absolute cwd with EVERY
// non-alphanumeric character replaced by "-" ... An earlier version replaced
// only "/" and "\", which silently found nothing for any project whose path
// contained a ".", "_", space, or other punctuation.
```

Put it on the line that will get "cleaned up", not only in the module header. Someone editing one function cannot see the consequence three files away.

**2. Provenance for anything reverse-engineered.** The version probed, the method, and the symptom of drift. The OpenCode payload shape was derived from `opencode@1.18.5` by round-tripping `import`/`export`, and is zod-validated — so drift arrives as a field-named error. A reader cannot recover any of that from the code.

**3. Module headers.** Each `src/*.js` opens with a block: what the file is responsible for, the external format it speaks, and where that format's rules came from. Match the existing files.

Contracts go in JSDoc on exported functions — `@param` with types is the only type system this package has, so keep it accurate. A wrong `@param` is worse than none.

Do not write: restatements of the signature, a comment per line, commented-out code, or a bare `TODO` with no owner and no condition for removal.

## Naming and shape

- Functions are verb-first and name the outcome: `findLatestSession`, `commitFork`, `stringifyToolResult`.
- Exported names use the domain vocabulary — session, entry, part, ledger, fork. Do not introduce a synonym for a term already in use.
- Guard clauses over nesting; return early on the absent case.
- A function whose middle third needs a sentence of explanation wants to be two functions.

## Before calling it done

- Every new branch in the logic is reachable from a test (see `writing-tests-first`)
- No new import points leftward in the pipeline
- No `Date.now()`, `Math.random()`, or `randomUUID` in `src/converter.js`
- Every abstraction added has a second concrete caller *today*
- Every non-obvious line either reads obviously or carries a comment saying what breaks
