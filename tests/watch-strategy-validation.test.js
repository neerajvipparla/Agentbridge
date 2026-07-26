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
