import assert from "node:assert";
import { convertToClaude } from "../src/opencode-to-claude.js";
import { writeClaudeSession } from "../src/claude-writer.js";
import { parseSessionFile, toConversation, summarizeSession } from "../src/claude-reader.js";
import { convertToOpenCode } from "../src/converter.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// --- Synthetic OpenCode session covering the main part types ---
const openCodeSession = {
  info: {
    id: "ses_test000000000000000000000000",
    title: "Test session",
    directory: "/tmp/agentbridge-test",
    time: { created: 1785000000000, updated: 1785000001000 },
  },
  messages: [
    {
      info: {
        id: "msg_1",
        sessionID: "ses_test000000000000000000000000",
        role: "user",
        time: { created: 1785000000000 },
        agent: "build",
        model: { providerID: "anthropic", modelID: "claude-opus-4-8" },
      },
      parts: [{ id: "p1", sessionID: "ses_test000000000000000000000000", messageID: "msg_1", type: "text", text: "List files" }],
    },
    {
      info: {
        id: "msg_2",
        sessionID: "ses_test000000000000000000000000",
        role: "assistant",
        time: { created: 1785000000500, completed: 1785000001000 },
        parentID: "msg_1",
        modelID: "claude-opus-4-8",
        providerID: "anthropic",
        mode: "build",
        agent: "build",
        path: { cwd: "/tmp/agentbridge-test", root: "/tmp/agentbridge-test" },
        cost: 0,
        tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [
        { id: "p2", sessionID: "ses_test000000000000000000000000", messageID: "msg_2", type: "reasoning", text: "I should use Bash." },
        {
          id: "p3",
          sessionID: "ses_test000000000000000000000000",
          messageID: "msg_2",
          type: "tool",
          callID: "toolu_abc123",
          tool: "Bash",
          state: {
            status: "completed",
            input: { command: "ls" },
            output: "README.md\nsrc",
            title: "Bash",
            metadata: {},
            time: { start: 1785000000600, end: 1785000000700 },
          },
        },
      ],
    },
    {
      info: {
        id: "msg_3",
        sessionID: "ses_test000000000000000000000000",
        role: "assistant",
        time: { created: 1785000001100, completed: 1785000001200 },
        parentID: "msg_2",
        modelID: "claude-opus-4-8",
        providerID: "anthropic",
        mode: "build",
        agent: "build",
        path: { cwd: "/tmp/agentbridge-test", root: "/tmp/agentbridge-test" },
        cost: 0,
        tokens: { input: 20, output: 8, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [
        { id: "p4", sessionID: "ses_test000000000000000000000000", messageID: "msg_3", type: "text", text: "There are two files." },
      ],
    },
  ],
};

console.log("T1: convertToClaude produces JSONL entries");
const entries = convertToClaude(openCodeSession, { directory: "/tmp/agentbridge-test" });
assert.equal(entries.length, 4, "expected 4 entries: user, assistant, tool-result user, assistant");
assert.equal(entries[0].type, "user");
assert.equal(entries[1].type, "assistant");
assert.equal(entries[2].type, "user");
assert.equal(entries[3].type, "assistant");
assert.equal(entries[1].message.content[0].type, "thinking");
assert.equal(entries[1].message.content[1].type, "tool_use");
assert.equal(entries[1].message.content[1].id, "toolu_abc123");
assert.equal(entries[2].message.content[0].type, "tool_result");
assert.equal(entries[2].message.content[0].tool_use_id, "toolu_abc123");
assert.equal(entries[2].message.content[0].content, "README.md\nsrc");
assert.equal(entries[2].toolUseResult, "README.md\nsrc");
assert.equal(entries[2].parentUuid, entries[1].uuid);
assert.equal(entries[3].parentUuid, entries[2].uuid);
console.log("PASS T1");

console.log("T2: deterministic / idempotent");
const entries2 = convertToClaude(openCodeSession, { directory: "/tmp/agentbridge-test" });
assert.equal(JSON.stringify(entries), JSON.stringify(entries2));
console.log("PASS T2");

console.log("T3: writeClaudeSession round-trips through claude-reader");
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ab-test-"));
const { filePath } = writeClaudeSession(entries, "/tmp/agentbridge-test", { baseDir: path.join(tmpHome, ".claude", "projects") });
const parsed = parseSessionFile(filePath);
assert.equal(parsed.length, 4);
const convo = toConversation(parsed);
assert.equal(convo.length, 4);
console.log("PASS T3", filePath);

console.log("T4: reverse -> forward round-trip preserves conversation shape");
// Take the Claude entries we just wrote, convert them back to OpenCode
const forward = convertToOpenCode(convo, { directory: "/tmp/agentbridge-test", title: "Round-trip" });
assert.equal(forward.messages.length, 3, "tool-result user entry should be folded away");
assert.ok(forward.messages[0].info.role === "user");
assert.ok(forward.messages[1].info.role === "assistant");
const toolPart = forward.messages[1].parts.find((p) => p.type === "tool");
assert.ok(toolPart, "tool part should exist");
assert.equal(toolPart.state.status, "completed");
assert.equal(toolPart.state.output, "README.md\nsrc");
assert.ok(forward.messages[2].info.role === "assistant");
console.log("PASS T4");

console.log("\nALL REVERSE TESTS PASSED");

// Cleanup
fs.rmSync(tmpHome, { recursive: true, force: true });
