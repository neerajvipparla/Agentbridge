---
name: writing-tests-first
description: Use when about to write or modify any function, module, or bugfix in this repo, before writing implementation code. Also when a change touches converter output, id derivation, tool-result pairing, project-path encoding, or ledger commits.
---

# Writing Tests First

## The Iron Law

**No production code before a failing test.**

Write the test. Run it. Watch it fail for the reason you expect. Only then write the code that makes it pass.

Wrote the code first? Delete it and start over. Not "adapt it while writing the test." Not "keep it in a scratch file for reference." Delete means delete — code you are looking at while writing a test dictates the test, and you end up asserting what the code *does* instead of what it *should do*.

**Violating the letter of this rule is violating the spirit of it.**

## Runner and layout

No test tooling is installed and no tests exist yet. Use Node's built-in runner: zero dependencies, ESM-native, matches this package.

Creating the first test in the repo:

```bash
mkdir -p test/fixtures
node --test                          # runs everything it discovers
node --test test/converter.test.js   # runs one file
```

Use `node --test` bare. `node --test test/` fails on Node 24 — the directory is treated as a module entry point and you get `MODULE_NOT_FOUND`.

- One test file per module: `src/converters/claude-to-opencode.js` → `test/claude-to-opencode.test.js`
- Real captured input in `test/fixtures/*.jsonl`, hand-trimmed to the smallest transcript that exhibits the case
- Import `{ describe, it }` from `node:test`, `assert` from `node:assert/strict`

## Format

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { convertToOpenCode } from "../src/converters/claude-to-opencode.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const load = (name) =>
  fs.readFileSync(path.join(fixtures, name), "utf8").split("\n").filter(Boolean).map(JSON.parse);

describe("convertToOpenCode", () => {
  it("produces byte-identical output when run twice on the same entries", () => {
    const entries = load("tool-use-tagged.jsonl");
    const opts = { directory: "/tmp/project", title: "fixture" };

    const first = JSON.stringify(convertToOpenCode(entries, opts));
    const second = JSON.stringify(convertToOpenCode(entries, opts));

    assert.equal(first, second);
  });
});
```

Shape of a test:

- `it(...)` names the **behavior**, not the function: "skips corrupt JSONL lines instead of throwing", not "tests parseSessionFile".
- Arrange / act / assert, in that order, blank-line separated. No assertions in the arrange block.
- One behavior per `it`. Two behaviors means two `it`s, even when setup repeats.
- Assert on **values**, not truthiness: `assert.equal(part.state.status, "completed")`, never `assert.ok(part.state)`.
- Use `assert.deepEqual` on a whole structure when the whole structure is the contract.
- Never touch the real `~/.claude` or the real `opencode` binary. Filesystem and git tests get `fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-"))` and remove it in an `after` hook.

## How rigorous

Every test must be *able* to fail. If you did not watch it go red, you have not tested anything — you have written an assertion that happens to hold.

Cover four cases per unit before calling it done:

| Case | Example here |
|---|---|
| Happy path | tagged `tool_result` → tool part with `status: "completed"` |
| Boundary | conversation with zero renderable parts; single-entry session |
| Malformed input | truncated JSON line mid-file; `message.content` absent |
| Absent input | no project dir for the cwd; tool call with no result anywhere |

**Invariant tests are mandatory, not optional.** CLAUDE.md states the determinism invariant and the load-bearing details; each needs a test that pins it, such that breaking one turns a test red. The four with the highest blast radius:

- *Determinism* — convert the same fixture twice, assert byte-identical JSON; assert no emitted timestamp falls within a second of `Date.now()`.
- *Two-pass tool-result harvest* — fixture with an **untagged** `toolUseResult` on the following user entry; assert the tool part is `completed` and carries the output. Collapsing the two passes must turn this red.
- *`encodeProjectPath`* — assert a path containing `.`, `_`, and a space maps to all-hyphens: `/Users/me/.config/my_app` → `-Users-me--config-my-app`.
- *`previousId` non-advance* — fixture where a middle turn yields zero parts; assert every `parentID` refers to an id present in `messages`.

A bugfix is not fixed until a test reproduces the bug and then passes. Write that test before the fix.

## Rationalizations

| Excuse | Reality |
|---|---|
| "It's a one-line change" | One-line changes broke `encodeProjectPath` and the harvest pass ordering. Both were one line. |
| "I'll add tests after, same result" | Tests-after ask "what does this do?" Tests-first ask "what should this do?" They produce different tests. |
| "There's no test suite yet, so the convention doesn't apply" | You are writing the first test, not exempt from it. `mkdir -p test` is not a blocker. |
| "I already ran `fork --dry-run` and eyeballed the JSON" | Manual inspection is not repeatable and does not fail a future edit. |
| "This is a refactor, behavior is unchanged" | Then existing tests prove it. If none exist, write them first — that is what makes it a refactor rather than a rewrite. |
| "Testing this needs the real opencode binary" | Then you are testing the wrong seam. Test the payload `convertToOpenCode` returns; the subprocess call is one thin function. |
| "The fixture is tedious to build" | Capture a real session, delete lines until the case is minimal. Ten minutes, reusable forever. |

## Red flags — stop and start over

- Implementation exists and no test failed first
- A test you have never seen fail
- `assert.ok(...)` where a value comparison would do
- A test that reads `~/.claude` or shells out to `opencode`
- "I'll add the determinism test once the feature works"
- Changing a test's expectation to match new output without first asking whether the new output is correct
