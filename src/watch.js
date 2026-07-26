// src/watch.js
//
// Phase 2 stretch goal: near-real-time auto-sync for a session pair.
//
// Watches the Claude session JSONL file with fs.watch and polls OpenCode's
// session list every `interval` ms. When either side changes, it debounces
// briefly and runs a sync. Conflicts (both sides changed) are handled by the
// chosen strategy: timestamp merge (default) or skip + warn (abort).

import fs from "node:fs";
import { syncSession } from "./sync.js";
import { exportSession } from "./opencode-reader.js";

function hashOpenCode(s) {
  if (!s || !s.messages) return "";
  const lines = [];
  for (const m of s.messages) {
    lines.push(m.info?.id ?? "?");
    for (const p of m.parts ?? []) {
      lines.push(`${p.type}:${p.text ?? ""}`);
    }
  }
  return lines.join("\n");
}

export function watchSession({ claudeFile, claudeId, opencodeId, ledgerDir, dir, strategy, interval, provider, agent, onEvent }) {
  let lastClaudeMtime = 0;
  let lastOpenCodeSnapshot = "";
  let pendingTimer = null;
  let running = false;
  let watcher = null;
  let pollTimer = null;
  let stopped = false;

  const event = (type, message) => {
    if (onEvent) onEvent(type, message);
  };

  const getClaudeMtime = () => {
    try {
      return fs.statSync(claudeFile).mtimeMs;
    } catch {
      return 0;
    }
  };

  const getOpenCodeSnapshot = () => {
    try {
      const s = exportSession(opencodeId);
      return hashOpenCode(s);
    } catch {
      return "";
    }
  };

  const runSync = () => {
    if (running) return;
    running = true;
    event("sync", "Detecting changes...");
    const result = syncSession({
      ledgerDir,
      dir,
      claudeId,
      opencodeId,
      strategy,
      dryRun: false,
      provider,
      agent,
    });
    running = false;
    if (result.exitCode) {
      event("error", result.error || "Sync failed");
      return;
    }
    if (result.message) {
      event("sync", result.message);
    }
    // Refresh baseline after a successful sync.
    lastClaudeMtime = getClaudeMtime();
    lastOpenCodeSnapshot = getOpenCodeSnapshot();
  };

  const scheduleSync = () => {
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      runSync();
    }, 500);
  };

  const checkChanges = () => {
    if (stopped) return;
    const claudeMtime = getClaudeMtime();
    const openCodeSnapshot = getOpenCodeSnapshot();
    const claudeChanged = claudeMtime > lastClaudeMtime;
    const openCodeChanged = openCodeSnapshot !== lastOpenCodeSnapshot;

    if (claudeChanged || openCodeChanged) {
      lastClaudeMtime = claudeMtime;
      if (openCodeChanged) lastOpenCodeSnapshot = openCodeSnapshot;
      if (claudeChanged) event("change", "Claude session file changed");
      if (openCodeChanged) event("change", "OpenCode session updated");
      scheduleSync();
    }
  };

  // Initial baseline.
  lastClaudeMtime = getClaudeMtime();
  lastOpenCodeSnapshot = getOpenCodeSnapshot();

  watcher = fs.watch(claudeFile, (eventType) => {
    if (eventType === "change") {
      checkChanges();
    }
  });

  pollTimer = setInterval(checkChanges, interval);

  return {
    stop() {
      stopped = true;
      if (watcher) watcher.close();
      if (pollTimer) clearInterval(pollTimer);
      if (pendingTimer) clearTimeout(pendingTimer);
    },
  };
}

export function waitForInterrupt() {
  return new Promise((resolve) => {
    process.once("SIGINT", () => {
      console.log("\nStopping watch mode.");
      resolve();
    });
  });
}
