// src/writers/opencode-import.js
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Run `opencode import <file>` on a converted payload. Returns stdout. */
export function importIntoOpenCode(payload, { cwd } = {}) {
  const tmpFile = path.join(os.tmpdir(), `agentbridge-import-${Date.now()}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify(payload));
  try {
    const out = execFileSync("opencode", ["import", tmpFile], {
      cwd: cwd ?? process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Only clean up on success - keep the file around on failure for debugging.
    fs.unlinkSync(tmpFile);
    return out.toString().trim();
  } catch (err) {
    const stderr = err.stderr?.toString() ?? "";
    const stdout = err.stdout?.toString() ?? "";
    throw new Error(
      `opencode import failed: ${stderr || stdout || err.message}\n` +
        `(payload kept at ${tmpFile} for debugging)`
    );
  }
}
