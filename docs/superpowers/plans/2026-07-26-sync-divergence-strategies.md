# Sync Divergence Strategies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redefine `agentbridge sync`'s default `timestamp` strategy to group merged turns by origin (each side's own new turns first, then the other side's, appended - not interleaved by real timestamp), and add two new strategies, `persist-claude` and `persist-opencode`, that keep one side's divergent branch and discard the other's entirely.

**Architecture:** `mergeSync` in `src/sync/sync.js` becomes a thin dispatcher over four small strategy functions (`mergeTimestamp`, `mergeAbort`, `mergePersistClaude`, `mergePersistOpencode`), each with the same `(current, last, diff, opts) → merged` shape. The dispatch table is the single source of truth for valid `--strategy` values, used both for dispatch and for CLI validation.

**Tech Stack:** Node.js ESM, `node --test` with plain `assert` + `console.log` (not `describe`/`it` - see Global Constraints), `commander` for the CLI.

**Spec:** `docs/superpowers/specs/2026-07-26-sync-divergence-strategies-design.md` - read it if any task instruction here seems to conflict with it; this plan implements it and should not need to, but the spec is the record of *why*.

## Global Constraints

- **ESM only.** Use `import`, never `require`, in every file this plan touches.
- **Test style: match `tests/sync.test.js`'s existing convention exactly.** It does not use `node:test`'s `describe`/`it` - it's a flat script using `assert` from `node:assert` and `console.log("PASS Tn")` per assertion block, relying on `node --test` to run the whole file as one implicit test unit (uncaught exceptions fail it). New tests in this plan follow that exact style, continuing the existing `T1`-`T7` numbering (`T8`, `T9`, `T10`). Do not introduce `describe`/`it` into this file.
- **Branch policy:** work happens on a branch off `dev` (not `main` - this isn't a CI/CD-only change). Open the PR with `gh pr create --base dev`. See `agents/skills/shipping-via-pull-requests/SKILL.md`.
- **No new source files for the merge logic.** All four strategy functions live in `src/sync/sync.js`, per the design's decision to keep this a single-module change rather than splitting into a `strategies/` directory - four small functions in one file is not yet the "second concrete case" threshold `agents/skills/writing-quality-code/SKILL.md` sets for extracting a new file.
- **Every file path and function name in this plan has been verified against the actual current repository** (read directly, not inferred) - if you find any has drifted since this plan was written, stop and flag it rather than guessing a fix.
- **Run `npm test` after every task** and confirm the full suite passes (not just the new assertions) before committing.

---

### Task 1: Extract the strategy dispatcher (pure refactor, no behavior change)

**Files:**
- Modify: `src/sync/sync.js`

**Interfaces:**
- Consumes: nothing new - `diffSync`, `normalizeCurrent`, `claudeTurnKey`, `opencodeTurnKey`, `convertToOpenCode`, `convertToClaude` all already exist in this file exactly as today.
- Produces: `mergeTimestamp(current, last, diff, opts)` and `mergeAbort(current, last, diff, opts)` - internal (not exported) functions later tasks will extend. `mergeSync(current, last, strategy, opts)` keeps its existing exported signature and return shape (`{ claudeEntries, opencodeMessages, claudeNew, opencodeNew }`) - no caller of `mergeSync` (in this file's `syncSession`, or in `tests/sync.test.js`) changes in this task.

This task moves the current body of `mergeSync` into two new functions with **zero behavior change** - it is a refactor, verified by the *existing* test suite passing completely unmodified. Task 2 changes behavior; this task only changes structure.

- [ ] **Step 1: Read the current file to confirm nothing has drifted**

Open `src/sync/sync.js` and confirm `mergeSync` still starts with:

```js
export function mergeSync(current, last, strategy, opts = {}) {
  const { claudeNew, opencodeNew } = diffSync(current, last);

  if (strategy === "abort" && claudeNew.length > 0 && opencodeNew.length > 0) {
```

If it doesn't match, stop and report - the rest of this task's instructions assume this exact starting shape.

- [ ] **Step 2: Replace `mergeSync` with the dispatcher + two extracted functions**

Replace the entire existing `mergeSync` function (from `export function mergeSync(current, last, strategy, opts = {}) {` through its closing `}`, currently ending with `return { claudeEntries: mergedClaude, opencodeMessages: mergedOpenCode, claudeNew, opencodeNew };\n}`) with:

```js
function mergeAbort(current, last, diff, opts) {
  const { claudeNew, opencodeNew } = diff;

  if (claudeNew.length > 0 && opencodeNew.length > 0) {
    const err = new Error(
      `Both sides have new turns since the last sync.\n` +
        `Claude: ${claudeNew.length} new turns. OpenCode: ${opencodeNew.length} new turns.\n` +
        `Run with --strategy timestamp to merge by timestamp, or resolve manually.`
    );
    err.claudeNew = claudeNew;
    err.opencodeNew = opencodeNew;
    throw err;
  }

  // Nothing to abort over - only one side changed (or neither). Merge normally.
  return mergeTimestamp(current, last, diff, opts);
}

/**
 * Merge new turns from both sides into a single sequence per side.
 *
 * @param {object} current - current state of both sides
 * @param {object} last - last synced state of both sides
 * @param {{claudeNew: object[], opencodeNew: object[]}} diff - from diffSync
 * @param {object} opts - conversion options (directory, etc.)
 * @returns {{claudeEntries: object[], opencodeMessages: object[], claudeNew: object[], opencodeNew: object[]}}
 */
function mergeTimestamp(current, last, diff, opts) {
  const { claudeNew, opencodeNew } = diff;
  const cur = normalizeCurrent(current);
  const lst = normalizeCurrent(last);

  // Always build the merged state from the last synced baseline, then add the
  // genuinely new turns. This protects against OpenCode's `export` returning a
  // partial or stale session (e.g. while the server is running, or when an
  // imported session loses its original messages after being continued). Using
  // the current state as the base would silently drop any history that OpenCode
  // failed to include.
  const mergedClaude = [...lst.claude];
  const mergedOpenCode = [...lst.opencode];

  // Preserve the original session ids across both tools so the merged output
  // continues to be written to the same Claude JSONL and the same OpenCode
  // session. Without this, converted turns would create a new session id and
  // `writeClaudeSession` / `importIntoOpenCode` would fork the conversation
  // instead of updating it in place.
  const claudeSessionId = lst.claude[0]?.sessionId || opts.claudeSessionId;
  const opencodeSessionId = lst.opencode[0]?.info?.sessionID || opts.opencodeId;

  // Add genuinely new turns reported by the current state.
  const existingClaudeKeys = new Set(mergedClaude.map(claudeTurnKey));
  for (const e of claudeNew) {
    const k = claudeTurnKey(e);
    if (!existingClaudeKeys.has(k)) {
      mergedClaude.push(e);
      existingClaudeKeys.add(k);
    }
  }
  const existingOpenCodeKeys = new Set(mergedOpenCode.map(opencodeTurnKey));
  for (const m of opencodeNew) {
    const k = opencodeTurnKey(m);
    if (!existingOpenCodeKeys.has(k)) {
      mergedOpenCode.push(m);
      existingOpenCodeKeys.add(k);
    }
  }

  // Fold Claude-only new turns into OpenCode.
  if (claudeNew.length > 0) {
    const newOpenCodeMessages = convertToOpenCode(claudeNew, {
      directory: opts.directory,
      title: opts.title ?? "Synced session",
      providerID: opts.providerID,
      agent: opts.agent,
      opencodeSessionId,
    }).messages;
    for (const m of newOpenCodeMessages) {
      if (!existingOpenCodeKeys.has(opencodeTurnKey(m))) {
        mergedOpenCode.push(m);
        existingOpenCodeKeys.add(opencodeTurnKey(m));
      }
    }
  }

  // Expand OpenCode-only new turns into Claude entries.
  if (opencodeNew.length > 0) {
    const newClaudeEntries = convertToClaude(
      { info: { id: opts.opencodeId || "placeholder", directory: opts.directory }, messages: opencodeNew },
      { directory: opts.directory, sessionId: claudeSessionId }
    );
    for (const e of newClaudeEntries) {
      if (!existingClaudeKeys.has(claudeTurnKey(e))) {
        mergedClaude.push(e);
        existingClaudeKeys.add(claudeTurnKey(e));
      }
    }
  }

  // Sort both merged representations by timestamp and recompute parent chains.
  // Claude: keep assistant + tool-result pairs together.
  const claudeWithGroups = [];
  for (let i = 0; i < mergedClaude.length; i++) {
    const e = mergedClaude[i];
    const next = mergedClaude[i + 1];
    if (e.type === "assistant" && next && next.type === "user" && next.parentUuid === e.uuid) {
      claudeWithGroups.push({ entries: [e, next], ts: toEpochMs(e.timestamp) });
      i++; // skip the paired result entry
    } else {
      claudeWithGroups.push({ entries: [e], ts: toEpochMs(e.timestamp) });
    }
  }
  claudeWithGroups.sort((a, b) => a.ts - b.ts);
  mergedClaude.length = 0;
  for (const g of claudeWithGroups) mergedClaude.push(...g.entries);

  let prevUuid = null;
  for (const e of mergedClaude) {
    e.parentUuid = prevUuid;
    prevUuid = e.uuid;
  }

  // OpenCode: sort by message creation time.
  mergedOpenCode.sort((a, b) => (a.info?.time?.created || 0) - (b.info?.time?.created || 0));
  let prevOpenCodeId = null;
  for (const m of mergedOpenCode) {
    m.info.parentID = prevOpenCodeId || m.info.sessionID;
    prevOpenCodeId = m.info.id;
  }

  return { claudeEntries: mergedClaude, opencodeMessages: mergedOpenCode, claudeNew, opencodeNew };
}

const STRATEGIES = {
  timestamp: mergeTimestamp,
  abort: mergeAbort,
};

/**
 * Merge new turns from both sides according to the given strategy.
 *
 * @param {object} current - current state of both sides
 * @param {object} last - last synced state of both sides
 * @param {string} strategy - one of the keys of STRATEGIES
 * @param {object} opts - conversion options (directory, etc.)
 * @returns {{claudeEntries: object[], opencodeMessages: object[], claudeNew: object[], opencodeNew: object[]}}
 */
export function mergeSync(current, last, strategy, opts = {}) {
  const diff = diffSync(current, last);
  const fn = STRATEGIES[strategy];
  if (!fn) {
    throw new Error(`Unknown strategy "${strategy}". Use one of: ${Object.keys(STRATEGIES).join(", ")}.`);
  }
  return fn(current, last, diff, opts);
}
```

This is a pure cut-and-paste-and-rename: the body of the old `mergeSync` (everything between the abort-check and the final return) becomes `mergeTimestamp`'s body unchanged; the abort-check becomes `mergeAbort`, falling through to `mergeTimestamp` when only one side changed (identical behavior to the old code's fall-through, since interleaving a single side's turns with nothing to interleave against is a no-op either way).

- [ ] **Step 2: Run the full existing test suite - must be unchanged**

Run: `npm test`
Expected: `tests 3`, `pass 3`, `fail 0` (same as before this task - `tests/sync.test.js`'s T1 through T7 all still pass, unmodified, because this task changed no behavior).

If anything fails, you have introduced a behavior change in what should be a pure refactor - stop and re-check Step 1's replacement against the original code before proceeding.

- [ ] **Step 3: Commit**

```bash
git add src/sync/sync.js
git commit -m "Extract mergeSync into a strategy dispatcher (no behavior change)"
```

---

### Task 2: Redefine `timestamp` to group by origin instead of interleaving

**Files:**
- Modify: `src/sync/sync.js` (the `mergeTimestamp` function from Task 1)
- Modify: `tests/sync.test.js` (rewrite `T5`)

**Interfaces:**
- Consumes: `mergeTimestamp(current, last, diff, opts)` from Task 1 - same signature, its *body* changes.
- Produces: no signature change - `mergeSync`'s exported contract is identical; only `timestamp`'s merged *ordering* changes. Nothing outside this file depends on the internal ordering, so no other production file changes.

Before the sort step, `mergedClaude` is already exactly `[...baseline, ...claudeNew (native), ...opencodeNew (converted)]`, and `mergedOpenCode` is already exactly `[...baseline, ...opencodeNew (native), ...claudeNew (converted)]` - that IS the grouped-by-origin order the design wants. The only change needed is to **delete the sort step** and keep the parent-chain recomputation that follows it (which stays correct and necessary regardless of order).

- [ ] **Step 1: Delete the sort step in `mergeTimestamp`**

In `src/sync/sync.js`, inside `mergeTimestamp` (added in Task 1), delete this entire block:

```js
  // Sort both merged representations by timestamp and recompute parent chains.
  // Claude: keep assistant + tool-result pairs together.
  const claudeWithGroups = [];
  for (let i = 0; i < mergedClaude.length; i++) {
    const e = mergedClaude[i];
    const next = mergedClaude[i + 1];
    if (e.type === "assistant" && next && next.type === "user" && next.parentUuid === e.uuid) {
      claudeWithGroups.push({ entries: [e, next], ts: toEpochMs(e.timestamp) });
      i++; // skip the paired result entry
    } else {
      claudeWithGroups.push({ entries: [e], ts: toEpochMs(e.timestamp) });
    }
  }
  claudeWithGroups.sort((a, b) => a.ts - b.ts);
  mergedClaude.length = 0;
  for (const g of claudeWithGroups) mergedClaude.push(...g.entries);
```

and delete this line (the OpenCode sort):

```js
  // OpenCode: sort by message creation time.
  mergedOpenCode.sort((a, b) => (a.info?.time?.created || 0) - (b.info?.time?.created || 0));
```

Leave the two comment/code blocks that immediately follow (the `prevUuid`/`parentUuid` loop and the `prevOpenCodeId`/`parentID` loop) exactly as they are - they still need to run, over the now-unsorted arrays, to stitch new entries' parent links to the last entry before them.

Replace the two deleted comments with one line explaining why there's no sort:

```js
  // No sort here, deliberately: mergedClaude/mergedOpenCode are already in
  // the wanted order (baseline, then this side's own new turns, then the
  // other side's new turns converted in) from the construction above.
  // Grouping by origin instead of interleaving by real timestamp is the
  // contract `timestamp` promises - see the design doc.
```

`toEpochMs` (used only by the deleted sort) becomes unused in this file after this step - leave its definition in place; it is still exported-adjacent utility code other strategies may use, and removing it is out of scope for this task (if a linter or reviewer flags it as dead code, that is a Task 4 or follow-up concern, not this one).

- [ ] **Step 2: Rewrite `T5` in `tests/sync.test.js` with a fixture that actually distinguishes old from new behavior**

The current `T5` fixture happens to have Claude's new-turn timestamps already chronologically before OpenCode's, so interleaved-by-time and grouped-by-origin produce the *same* order for it - it would pass under either the old or new code, proving nothing. Replace `T5` with a fixture using deliberately interleaved timestamps, so the two behaviors diverge and the test actually pins the new contract.

Replace this block in `tests/sync.test.js`:

```js
console.log("T5: timestamp merge interleaves both sides correctly");
const m5 = mergeSync(currentBoth, baseOpenCode, "timestamp", { directory: "/tmp", opencodeId: "ses_test" });
assert.equal(m5.opencodeMessages.length, 6);
assert.equal(m5.claudeEntries.length, 6);
const texts = m5.opencodeMessages.map((m) => m.parts[0].text);
assert.deepEqual(texts, ["hello", "hi there", "claude q", "claude a", "openc q", "openc a"]);
console.log("PASS T5");
```

with:

```js
console.log("T5: timestamp merge groups by origin (own new turns first, then the other side's) - not interleaved by time");
// Deliberately interleaved timestamps: chronologically, claude q (+2s) < openc q
// (+3s) < openc a (+4s) < claude a (+5s). If the old sort-by-time behavior were
// still in place, both sides would show that exact interleaved order. Grouped
// by origin, each side shows its own two new turns adjacent to each other
// instead - and the two sides' resulting order differs from each other.
const currentBothInterleaved = {
  claudeEntries: [
    ...baseClaude,
    claudeEntry("user", "u2", "2026-07-26T10:00:02Z", "claude q", "a1"),
    claudeEntry("assistant", "a2", "2026-07-26T10:00:05Z", "claude a", "u2"),
  ],
  opencodeMessages: [
    ...baseOpenCode.opencode,
    ocMsg("user", "msg_u3", 1785060003000, "openc q", "msg_a1"),
    ocMsg("assistant", "msg_a3", 1785060004000, "openc a", "msg_u3"),
  ],
};
const m5 = mergeSync(currentBothInterleaved, baseOpenCode, "timestamp", { directory: "/tmp", opencodeId: "ses_test" });
assert.equal(m5.opencodeMessages.length, 6);
assert.equal(m5.claudeEntries.length, 6);
const opencodeTexts5 = m5.opencodeMessages.map((m) => m.parts[0].text);
assert.deepEqual(
  opencodeTexts5,
  ["hello", "hi there", "openc q", "openc a", "claude q", "claude a"],
  "OpenCode's own view: its native new turns first, then Claude's, converted"
);
const claudeVersions5 = m5.claudeEntries.map((e) => e.version);
assert.deepEqual(
  claudeVersions5,
  ["1.0", "1.0", "1.0", "1.0", "imported-from-opencode", "imported-from-opencode"],
  "Claude's own view: its native new turns first (version 1.0, from the test fixture), then OpenCode's, converted (version imported-from-opencode)"
);
console.log("PASS T5");
```

(`claudeEntry`'s fixture entries all have `version: "1.0"` per its helper at the top of this file; `convertToClaude`'s default `version` option is `"imported-from-opencode"` - checking `.version` sidesteps the fact that native fixture entries store `message.content` as a plain string while converted entries store it as a content-block array, so a single `.map()` over `.message.content` would see two different shapes.)

Do not modify `T1`-`T4`, `T6`, or `T7` - none of them exercise both-sides-changed with divergent orderings the way the old `T5` almost did, so none of them distinguish old from new behavior, and all continue to pass unmodified.

- [ ] **Step 3: Run the test file directly to see the new T5 pass**

Run: `node tests/sync.test.js`
Expected: prints `PASS T1` through `PASS T7` in order, ending with `ALL SYNC TESTS PASSED`, and does not throw.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: `tests 3`, `pass 3`, `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/sync/sync.js tests/sync.test.js
git commit -m "Redefine timestamp strategy to group by origin instead of interleaving"
```

---

### Task 3: Add `persist-claude` and `persist-opencode` strategies

**Files:**
- Modify: `src/sync/sync.js` (add two functions, register in `STRATEGIES`, update `syncSession`'s validation)
- Modify: `bin/agentbridge.js` (update `sync`'s `--strategy` option description text only - `watch`'s is untouched, see Task 4)
- Modify: `tests/sync.test.js` (add `T8`, `T9`, `T10`)

**Interfaces:**
- Consumes: `normalizeCurrent`, `claudeTurnKey`, `opencodeTurnKey`, `convertToOpenCode`, `convertToClaude` - all already in `src/sync/sync.js`, unchanged. `STRATEGIES` from Task 1.
- Produces: `mergePersistClaude(current, last, diff, opts)` and `mergePersistOpencode(current, last, diff, opts)`, same return shape as `mergeTimestamp`/`mergeAbort`. `STRATEGIES` grows to four entries - this is what Task 4's `watch` test and the CLI's `--strategy` validation both key off.

- [ ] **Step 1: Add the two new strategy functions**

In `src/sync/sync.js`, immediately after `mergeTimestamp` (added in Task 1, modified in Task 2) and before the `STRATEGIES` object, add:

```js
/**
 * Keep only Claude's divergent new turns; OpenCode's are discarded entirely
 * (not appended, not converted). The common baseline is preserved on both
 * sides. opencodeNew is still returned (unused in the merge) so the CLI can
 * report how many turns were discarded.
 */
function mergePersistClaude(current, last, diff, opts) {
  const { claudeNew, opencodeNew } = diff;
  const lst = normalizeCurrent(last);

  const mergedClaude = [...lst.claude];
  const existingClaudeKeys = new Set(mergedClaude.map(claudeTurnKey));
  for (const e of claudeNew) {
    const k = claudeTurnKey(e);
    if (!existingClaudeKeys.has(k)) {
      mergedClaude.push(e);
      existingClaudeKeys.add(k);
    }
  }

  const mergedOpenCode = [...lst.opencode];
  if (claudeNew.length > 0) {
    const existingOpenCodeKeys = new Set(mergedOpenCode.map(opencodeTurnKey));
    const opencodeSessionId = lst.opencode[0]?.info?.sessionID || opts.opencodeId;
    const newOpenCodeMessages = convertToOpenCode(claudeNew, {
      directory: opts.directory,
      title: opts.title ?? "Synced session",
      providerID: opts.providerID,
      agent: opts.agent,
      opencodeSessionId,
    }).messages;
    for (const m of newOpenCodeMessages) {
      const k = opencodeTurnKey(m);
      if (!existingOpenCodeKeys.has(k)) {
        mergedOpenCode.push(m);
        existingOpenCodeKeys.add(k);
      }
    }
  }

  let prevUuid = null;
  for (const e of mergedClaude) {
    e.parentUuid = prevUuid;
    prevUuid = e.uuid;
  }
  let prevOpenCodeId = null;
  for (const m of mergedOpenCode) {
    m.info.parentID = prevOpenCodeId || m.info.sessionID;
    prevOpenCodeId = m.info.id;
  }

  return { claudeEntries: mergedClaude, opencodeMessages: mergedOpenCode, claudeNew, opencodeNew };
}

/**
 * Mirror of mergePersistClaude: keep only OpenCode's divergent new turns,
 * discard Claude's entirely.
 */
function mergePersistOpencode(current, last, diff, opts) {
  const { claudeNew, opencodeNew } = diff;
  const lst = normalizeCurrent(last);

  const mergedOpenCode = [...lst.opencode];
  const existingOpenCodeKeys = new Set(mergedOpenCode.map(opencodeTurnKey));
  for (const m of opencodeNew) {
    const k = opencodeTurnKey(m);
    if (!existingOpenCodeKeys.has(k)) {
      mergedOpenCode.push(m);
      existingOpenCodeKeys.add(k);
    }
  }

  const mergedClaude = [...lst.claude];
  if (opencodeNew.length > 0) {
    const existingClaudeKeys = new Set(mergedClaude.map(claudeTurnKey));
    const claudeSessionId = lst.claude[0]?.sessionId || opts.claudeSessionId;
    const newClaudeEntries = convertToClaude(
      { info: { id: opts.opencodeId || "placeholder", directory: opts.directory }, messages: opencodeNew },
      { directory: opts.directory, sessionId: claudeSessionId }
    );
    for (const e of newClaudeEntries) {
      const k = claudeTurnKey(e);
      if (!existingClaudeKeys.has(k)) {
        mergedClaude.push(e);
        existingClaudeKeys.add(k);
      }
    }
  }

  let prevUuid = null;
  for (const e of mergedClaude) {
    e.parentUuid = prevUuid;
    prevUuid = e.uuid;
  }
  let prevOpenCodeId = null;
  for (const m of mergedOpenCode) {
    m.info.parentID = prevOpenCodeId || m.info.sessionID;
    prevOpenCodeId = m.info.id;
  }

  return { claudeEntries: mergedClaude, opencodeMessages: mergedOpenCode, claudeNew, opencodeNew };
}
```

- [ ] **Step 2: Register both in `STRATEGIES`**

Change:

```js
const STRATEGIES = {
  timestamp: mergeTimestamp,
  abort: mergeAbort,
};
```

to:

```js
const STRATEGIES = {
  timestamp: mergeTimestamp,
  abort: mergeAbort,
  "persist-claude": mergePersistClaude,
  "persist-opencode": mergePersistOpencode,
};
```

- [ ] **Step 3: Update `syncSession`'s strategy validation to use `STRATEGIES`**

In `src/sync/sync.js`, inside `syncSession`, find:

```js
  if (strategy !== "timestamp" && strategy !== "abort") {
    return { ok: false, error: `Unknown strategy "${strategy}". Use "timestamp" or "abort".`, exitCode: 1 };
  }
```

Replace with:

```js
  if (!(strategy in STRATEGIES)) {
    return {
      ok: false,
      error: `Unknown strategy "${strategy}". Use one of: ${Object.keys(STRATEGIES).join(", ")}.`,
      exitCode: 1,
    };
  }
```

This makes `STRATEGIES` (from Task 1/this task) the single place that lists valid strategy names - `mergeSync`'s dispatch and `syncSession`'s validation both read it, instead of the value list being duplicated in two error messages.

- [ ] **Step 4: Update `sync`'s `--strategy` CLI help text (not `watch`'s)**

In `bin/agentbridge.js`, find the `sync` command's option (inside `program.command("sync")`):

```js
  .option("-s, --strategy <strategy>", 'merge strategy: "timestamp" (default) or "abort"', "timestamp")
```

Replace with:

```js
  .option(
    "-s, --strategy <strategy>",
    'merge strategy: "timestamp" (default), "abort", "persist-claude", or "persist-opencode"',
    "timestamp"
  )
```

**Do not touch `watch`'s `--strategy` option or its inline validation in this task** - `watch` intentionally keeps only `timestamp`/`abort` (Task 4 adds a test confirming this, but the code is already correct as-is).

- [ ] **Step 5: Add `T8`, `T9`, `T10` to `tests/sync.test.js`**

After the existing `T7` block (`console.log("PASS T7");`) and before the final `console.log("\nALL SYNC TESTS PASSED");`, add:

```js
console.log("T8: persist-claude keeps Claude's new turns, discards OpenCode's");
const m8 = mergeSync(currentBoth, baseOpenCode, "persist-claude", { directory: "/tmp", opencodeId: "ses_test" });
assert.equal(m8.claudeEntries.length, 4, "baseline + Claude's 2 new turns");
assert.equal(m8.opencodeMessages.length, 4, "baseline + Claude's 2 new turns, converted");
const opencodeTexts8 = m8.opencodeMessages.map((m) => m.parts[0].text);
assert.deepEqual(
  opencodeTexts8,
  ["hello", "hi there", "claude q", "claude a"],
  "OpenCode's divergent turns (openc q/openc a) are discarded entirely"
);
console.log("PASS T8");

console.log("T9: persist-opencode keeps OpenCode's new turns, discards Claude's");
const m9 = mergeSync(currentBoth, baseOpenCode, "persist-opencode", { directory: "/tmp", opencodeId: "ses_test" });
assert.equal(m9.opencodeMessages.length, 4, "baseline + OpenCode's 2 new turns");
assert.equal(m9.claudeEntries.length, 4, "baseline + OpenCode's 2 new turns, converted");
const opencodeTexts9 = m9.opencodeMessages.map((m) => m.parts[0].text);
assert.deepEqual(opencodeTexts9, ["hello", "hi there", "openc q", "openc a"], "OpenCode keeps its own native turns");
const claudeVersions9 = m9.claudeEntries.map((e) => e.version);
assert.deepEqual(
  claudeVersions9,
  ["1.0", "1.0", "imported-from-opencode", "imported-from-opencode"],
  "Claude's divergent turns (claude q/claude a) are discarded; the kept turns are converted from OpenCode"
);
console.log("PASS T9");

console.log("T10: persist-opencode with no new OpenCode turns is a true no-op");
const currentOpenCodeUnchanged = {
  claudeEntries: currentBoth.claudeEntries,
  opencodeMessages: baseOpenCode.opencode,
};
const m10 = mergeSync(currentOpenCodeUnchanged, baseOpenCode, "persist-opencode", { directory: "/tmp", opencodeId: "ses_test" });
assert.equal(m10.claudeEntries.length, 2, "no OpenCode turns to persist; Claude's divergent turns are discarded");
assert.equal(m10.opencodeMessages.length, 2, "OpenCode side is unchanged from baseline");
const claudeTexts10 = m10.claudeEntries.map((e) => e.message.content);
assert.deepEqual(claudeTexts10, ["hello", "hi there"], "merged Claude content matches the baseline exactly - nothing new was persisted");
console.log("PASS T10");
```

This last test is why `commitFork` will correctly record no ledger commit for a `persist-opencode` sync where OpenCode had nothing new to persist: the merge output is content-identical to the baseline, and `commitFork`'s existing git-level "nothing to commit" detection (unchanged by this plan) already handles that case generically - the same mechanism that makes re-running `fork` on an unchanged session a no-op today. No new ledger-level test is needed to prove this; `T10` proves the necessary precondition (byte-identical merge output).

- [ ] **Step 6: Run the test file directly**

Run: `node tests/sync.test.js`
Expected: `PASS T1` through `PASS T10`, then `ALL SYNC TESTS PASSED`.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: `tests 3`, `pass 3`, `fail 0`.

- [ ] **Step 8: Commit**

```bash
git add src/sync/sync.js bin/agentbridge.js tests/sync.test.js
git commit -m "Add persist-claude and persist-opencode sync strategies"
```

---

### Task 4: Confirm `watch` rejects persist-*, reorder its validation for testability, update docs

**Files:**
- Modify: `bin/agentbridge.js` (reorder `watch`'s validation - no new logic)
- Create: `tests/watch-strategy-validation.test.js`
- Modify: `README.md` (the "Keeping both sides in sync" section)

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing later tasks depend on - this is the last task.

`watch`'s existing inline check already only accepts `"timestamp"` or `"abort"`, so `persist-claude`/`persist-opencode` are already rejected there - no new validation logic. But that check currently runs *after* the ledger-existence and session-mapping checks, which means testing it today would require a fully populated ledger just to reach the line that matters. This task reorders `watch`'s existing checks (strategy and interval validation move before the ledger check) - a small, harmless priority change (a user who passes both a bad `--dir` and a bad `--strategy` now sees the strategy error first) that also makes the constraint trivially testable without any ledger setup.

- [ ] **Step 1: Reorder `watch`'s validation in `bin/agentbridge.js`**

Find the `watch` command's `.action(async (sessionId, opts) => { ... })` body. It currently runs, in order: resolve `dir` → check ledger exists → resolve session mapping → check Claude file exists → validate `strategy` → validate `interval` → start watching.

Change the order to: resolve `dir` → validate `strategy` → validate `interval` → check ledger exists → resolve session mapping → check Claude file exists → start watching. Concretely, move this block:

```js
    const strategy = opts.strategy;
    if (strategy !== "timestamp" && strategy !== "abort") {
      console.error(`Unknown strategy "${strategy}". Use "timestamp" or "abort".`);
      process.exitCode = 1;
      return;
    }

    const interval = Number(opts.interval);
    if (!Number.isFinite(interval) || interval < 500) {
      console.error("Interval must be at least 500 ms.");
      process.exitCode = 1;
      return;
    }
```

from its current position (after the Claude-file-exists check) to immediately after `const dir = path.resolve(opts.dir);` - i.e., as the very first checks in the action, before `const ledgerDir = ledgerPath(dir);`. Do not change the code inside this block at all - it is a pure relocation. Every other line in the action keeps its current relative order and content.

- [ ] **Step 2: Run existing tests to confirm nothing broke**

Run: `npm test`
Expected: `tests 3`, `pass 3`, `fail 0` (this file has no existing test coverage for `watch`, so this just confirms the reorder didn't break anything else - e.g. a typo).

- [ ] **Step 3: Write the new test file**

Create `tests/watch-strategy-validation.test.js`:

```js
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const binPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "agentbridge.js");

function expectRejection(strategy) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-watch-test-"));
  try {
    execFileSync("node", [binPath, "watch", "--strategy", strategy, "--dir", tmpDir], { stdio: "pipe" });
    assert.fail(`expected watch to exit non-zero for strategy "${strategy}"`);
  } catch (err) {
    assert.equal(err.status, 1, `expected exit code 1 for strategy "${strategy}"`);
    assert.match(err.stderr.toString(), new RegExp(`Unknown strategy "${strategy}"`));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

console.log("W1: watch rejects persist-claude");
expectRejection("persist-claude");
console.log("PASS W1");

console.log("W2: watch rejects persist-opencode");
expectRejection("persist-opencode");
console.log("PASS W2");

console.log("\nALL WATCH STRATEGY VALIDATION TESTS PASSED");
```

This relies on Task 4 Step 1's reorder: strategy validation now runs before the ledger-existence check, so a fresh empty temp directory (no ledger, no fork ever run there) is enough to reach it - no need to set up a real fork/ledger just to test this guard clause.

- [ ] **Step 4: Run the new test file directly**

Run: `node tests/watch-strategy-validation.test.js`
Expected: `PASS W1`, `PASS W2`, then `ALL WATCH STRATEGY VALIDATION TESTS PASSED`.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: `tests 4` (the new file is picked up automatically by the `tests/*.test.js` glob in `package.json`'s `test` script - no `package.json` change needed), `pass 4`, `fail 0`.

- [ ] **Step 6: Update README's "Keeping both sides in sync" section**

In `README.md`, find:

```
- `timestamp` (default) - append new turns from both sides and sort by time.
  Turns are append-only and chronological, so this is the right default for
  a conversation.
- `abort` - stop and report how many new turns each side has, so you resolve
  the conflict manually instead of auto-merging.
```

Replace with:

```
- `timestamp` (default) - each side keeps its own new turns first, then the
  other side's new turns appended after (not interleaved by real time). If
  Claude Code gained N+1, N+2 and OpenCode independently gained N+1′, N+2′,
  N+3′ since the last sync, running `sync` produces, on the Claude side,
  `[...baseline, N+1, N+2, N+1′, N+2′, N+3′]`, and on the OpenCode side,
  `[...baseline, N+1′, N+2′, N+3′, N+1, N+2]`.
- `abort` - stop and report how many new turns each side has, so you resolve
  the conflict manually instead of auto-merging.
- `persist-claude` / `persist-opencode` - keep only one side's divergent new
  turns; the other side's are discarded entirely (not appended, not
  converted). The common baseline before the divergence is preserved on
  both sides regardless. The discarded turns aren't gone forever - the
  ledger's pre-sync commit still has them in its git history if you ever
  need them back.
```

Also update the top-of-README command block. As of this writing it has **two** lines with the identical substring `[--strategy timestamp|abort]` - one for `sync`, one for `watch`:

```
agentbridge sync [session-id] [--dir <path>] [--strategy timestamp|abort]
                 [--provider <id>] [--agent <name>] [--dry-run]
agentbridge watch [session-id] [--dir <path>] [--strategy timestamp|abort]
                  [--interval <ms>] [--provider <id>] [--agent <name>]
```

Change **only the `agentbridge sync` line** to
`[--strategy timestamp|abort|persist-claude|persist-opencode]`. Leave the
`agentbridge watch` line's `[--strategy timestamp|abort]` exactly as it is -
`watch` does not gain the new values. If you search-and-replace, match on
the full line (`agentbridge sync [session-id] ...`), not just the
`[--strategy timestamp|abort]` substring, or you will silently change both
lines.

Then **run `node bin/agentbridge.js sync --help` and `node bin/agentbridge.js watch --help`** and confirm the flag text you wrote matches the real output for each, per `agents/skills/writing-readme/SKILL.md`'s verification rule - don't take this plan's wording as ground truth without checking; the plan was written before implementation, the running CLI after is the source of truth.

- [ ] **Step 7: Final full-suite run and manual verification**

Run: `npm test`
Expected: `tests 4`, `pass 4`, `fail 0`.

Run: `node bin/agentbridge.js sync --help` and `node bin/agentbridge.js watch --help` - confirm `sync`'s strategy text lists all four values and `watch`'s still lists only `timestamp`/`abort`.

- [ ] **Step 8: Commit**

```bash
git add bin/agentbridge.js tests/watch-strategy-validation.test.js README.md
git commit -m "Confirm watch rejects persist-*; reorder validation for testability; update docs"
```
