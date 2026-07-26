import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readSessionFromDatabase } from "../src/opencode-reader.js";

let DatabaseSync;
try {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  ({ DatabaseSync } = require("node:sqlite"));
} catch {
  // node:sqlite is not available; skip database tests.
}

if (!DatabaseSync) {
  console.log("SKIP: node:sqlite not available");
  process.exit(0);
}

const tmpDb = path.join(os.tmpdir(), `agentbridge-opencode-reader-test-${Date.now()}.db`);

function setupDb() {
  const db = new DatabaseSync(tmpDb);
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      directory TEXT NOT NULL,
      version TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `);
  db.prepare(
    "INSERT INTO session (id, title, directory, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)"
  ).run("ses_test", "Test", "/tmp/test", "1", 1000, 2000);
  db.prepare(
    "INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)"
  ).run("msg_1", "ses_test", 1000, JSON.stringify({ role: "user", time: { created: 1000 }, agent: "build", model: { providerID: "anthropic", modelID: "unknown" } }));
  db.prepare(
    "INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)"
  ).run("msg_2", "ses_test", 2000, JSON.stringify({ role: "assistant", parentID: "msg_1", time: { created: 2000, completed: 2000 }, modelID: "unknown", providerID: "anthropic", mode: "build", agent: "build", path: { cwd: "/tmp/test", root: "/tmp/test" }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }));
  db.prepare(
    "INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)"
  ).run("prt_1", "msg_1", "ses_test", 1000, JSON.stringify({ type: "text", text: "hello" }));
  db.prepare(
    "INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)"
  ).run("prt_2", "msg_2", "ses_test", 2000, JSON.stringify({ type: "text", text: "hi there" }));
  db.close();
}

setupDb();

console.log("T1: readSessionFromDatabase reconstructs session from SQLite");
const session = readSessionFromDatabase("ses_test", tmpDb);
assert.ok(session, "should return a session");
assert.equal(session.info.id, "ses_test");
assert.equal(session.info.title, "Test");
assert.equal(session.messages.length, 2);
assert.equal(session.messages[0].info.role, "user");
assert.equal(session.messages[0].info.id, "msg_1");
assert.equal(session.messages[0].parts[0].text, "hello");
assert.equal(session.messages[1].info.role, "assistant");
assert.equal(session.messages[1].parts[0].text, "hi there");
console.log("PASS T1");

console.log("T2: readSessionFromDatabase returns null for unknown session");
assert.strictEqual(readSessionFromDatabase("ses_unknown", tmpDb), null);
console.log("PASS T2");

fs.unlinkSync(tmpDb);
console.log("\nALL OPENCODE-READER TESTS PASSED");
