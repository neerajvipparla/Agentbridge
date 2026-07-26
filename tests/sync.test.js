import assert from "node:assert";
import { diffSync, mergeSync } from "../src/sync/sync.js";

function ocMsg(role, id, created, text, parentID = null) {
  return {
    info: {
      id,
      sessionID: "ses_test",
      role,
      time: { created, completed: created + 100 },
      parentID: parentID || "ses_test",
      modelID: "claude-opus-4-8",
      providerID: "anthropic",
      mode: "build",
      agent: "build",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [{ id: `prt_${id}`, sessionID: "ses_test", messageID: id, type: "text", text }],
  };
}

function claudeEntry(role, uuid, timestamp, text, parentUuid = null) {
  return {
    type: role,
    uuid,
    parentUuid,
    sessionId: "claude_test",
    timestamp,
    isSidechain: false,
    isMeta: false,
    cwd: "/tmp",
    version: "1.0",
    message: { role, content: text },
  };
}

const baseClaude = [
  claudeEntry("user", "u1", "2026-07-26T10:00:00Z", "hello"),
  claudeEntry("assistant", "a1", "2026-07-26T10:00:01Z", "hi there", "u1"),
];

const baseOpenCode = {
  claude: baseClaude,
  opencode: [ocMsg("user", "msg_u1", 1785060000000, "hello"), ocMsg("assistant", "msg_a1", 1785060001000, "hi there", "msg_u1")],
};

console.log("T1: no changes -> empty diff");
const d1 = diffSync(baseOpenCode, baseOpenCode);
assert.equal(d1.claudeNew.length, 0);
assert.equal(d1.opencodeNew.length, 0);
console.log("PASS T1");

console.log("T2: Claude-only delta");
const currentClaudeOnly = {
  claudeEntries: [
    ...baseClaude,
    claudeEntry("user", "u2", "2026-07-26T10:00:02Z", "how are you", "a1"),
    claudeEntry("assistant", "a2", "2026-07-26T10:00:03Z", "fine", "u2"),
  ],
  opencodeMessages: baseOpenCode.opencode,
};
const d2 = diffSync(currentClaudeOnly, baseOpenCode);
assert.equal(d2.claudeNew.length, 2);
assert.equal(d2.opencodeNew.length, 0);
console.log("PASS T2");

console.log("T3: merge Claude-only delta into OpenCode");
const m3 = mergeSync(currentClaudeOnly, baseOpenCode, "timestamp", { directory: "/tmp", opencodeId: "ses_test" });
assert.equal(m3.opencodeMessages.length, 4);
assert.equal(m3.claudeEntries.length, 4);
assert.equal(m3.opencodeMessages[2].info.role, "user");
assert.equal(m3.opencodeMessages[2].parts[0].text, "how are you");
console.log("PASS T3");

console.log("T4: abort strategy with both sides changed");
const currentBoth = {
  claudeEntries: [
    ...baseClaude,
    claudeEntry("user", "u2", "2026-07-26T10:00:02Z", "claude q", "a1"),
    claudeEntry("assistant", "a2", "2026-07-26T10:00:03Z", "claude a", "u2"),
  ],
  opencodeMessages: [
    ...baseOpenCode.opencode,
    ocMsg("user", "msg_u3", 1785060004000, "openc q", "msg_a1"),
    ocMsg("assistant", "msg_a3", 1785060005000, "openc a", "msg_u3"),
  ],
};
let threw = false;
try {
  mergeSync(currentBoth, baseOpenCode, "abort", { directory: "/tmp", opencodeId: "ses_test" });
} catch (err) {
  threw = true;
  assert.ok(err.message.includes("Both sides have new turns"));
}
assert.ok(threw, "abort strategy should throw when both sides changed");
console.log("PASS T4");

console.log("T5: timestamp merge interleaves both sides correctly");
const m5 = mergeSync(currentBoth, baseOpenCode, "timestamp", { directory: "/tmp", opencodeId: "ses_test" });
assert.equal(m5.opencodeMessages.length, 6);
assert.equal(m5.claudeEntries.length, 6);
const texts = m5.opencodeMessages.map((m) => m.parts[0].text);
assert.deepEqual(texts, ["hello", "hi there", "claude q", "claude a", "openc q", "openc a"]);
console.log("PASS T5");

console.log("T6: OpenCode export drops baseline messages (server/live export bug)");
const currentOpenCodePartial = {
  claudeEntries: baseClaude,
  opencodeMessages: [
    ocMsg("user", "msg_u3", 1785060004000, "openc q", "msg_a1"),
    ocMsg("assistant", "msg_a3", 1785060005000, "openc a", "msg_u3"),
  ],
};
const m6 = mergeSync(currentOpenCodePartial, baseOpenCode, "timestamp", { directory: "/tmp", opencodeId: "ses_test" });
assert.equal(m6.opencodeMessages.length, 4, "OpenCode merge should preserve baseline + new turns");
assert.equal(m6.claudeEntries.length, 4, "Claude merge should preserve baseline + new turns");
const texts6 = m6.opencodeMessages.map((m) => m.parts[0].text);
assert.deepEqual(texts6, ["hello", "hi there", "openc q", "openc a"]);
console.log("PASS T6");

console.log("T7: merged turns keep the original session ids");
const m7 = mergeSync(currentBoth, baseOpenCode, "timestamp", { directory: "/tmp", opencodeId: "ses_test" });
assert.ok(m7.claudeEntries.every((e) => e.sessionId === "claude_test"), "all Claude entries keep the original session id");
assert.ok(m7.opencodeMessages.every((m) => m.info.sessionID === "ses_test"), "all OpenCode messages keep the original session id");
console.log("PASS T7");

console.log("\nALL SYNC TESTS PASSED");
