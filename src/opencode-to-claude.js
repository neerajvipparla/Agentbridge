// src/opencode-to-claude.js
//
// Converts an OpenCode session (the `opencode export` JSON shape, which is the
// same shape `opencode import` accepts) into a Claude Code JSONL transcript.
//
// This is the reverse of `src/converter.js`. Where the forward converter folds a
// tool_use + tool_result pair into a single OpenCode `tool` part, this module
// expands each `tool` part back into a Claude assistant `tool_use` block plus a
// synthetic user entry carrying the matching `tool_result` block (and a
// `toolUseResult` fallback for older Claude Code readers).

import crypto from "node:crypto";

// Deterministic IDs are what make reverse-forking idempotent: importing the
// same OpenCode session twice produces the same Claude session id, the same
// entry uuids, and byte-identical JSONL, so the git ledger sees no diff.
function deriveUuid(...parts) {
  const hash = crypto.createHash("sha256").update(parts.join(":")).digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join("-");
}

function toIso(ms) {
  return new Date(ms).toISOString();
}

/**
 * Convert an OpenCode export JSON object into an array of Claude Code JSONL
 * entries.
 *
 * @param {object} session - `opencode export <id>` output
 * @param {object} opts
 * @param {string} [opts.directory] - cwd to stamp on each entry (defaults to the session's own directory)
 * @param {string} [opts.model] - Claude model string to use when OpenCode didn't record one
 * @param {string} [opts.version] - version marker written into each entry
 */
export function convertToClaude(session, opts = {}) {
  const {
    directory,
    model = "claude-opus-4-8",
    version = "imported-from-opencode",
    sessionId: sessionIdOverride,
  } = opts;

  const opencodeSessionId = session?.info?.id;
  if (!opencodeSessionId) {
    throw new Error("OpenCode session is missing info.id");
  }

  // Generate a fresh, deterministic Claude session UUID rather than reusing the
  // OpenCode `ses_...` id (the formats are intentionally different). Re-importing
  // the same OpenCode session produces the same Claude id, so this stays
  // idempotent.
  // During sync, the caller can override with the existing Claude session id so
  // the new turns are written into the same Claude transcript.
  const sessionId = sessionIdOverride || deriveUuid(opencodeSessionId);
  const cwd = directory || session.info?.directory || process.cwd();

  const entries = [];
  let previousUuid = null;

  for (const msg of session.messages ?? []) {
    const info = msg.info;
    if (!info || !info.id || !info.role) {
      // Defensive: skip malformed message rows rather than crash the whole fork.
      continue;
    }

    const msgUuid = deriveUuid(opencodeSessionId, info.id);
    const timestamp = toIso(info.time?.completed ?? info.time?.created ?? Date.now());

    const contentBlocks = [];
    const toolUses = [];

    for (const part of msg.parts ?? []) {
      if (part.type === "text" && part.text) {
        contentBlocks.push({ type: "text", text: part.text });
      } else if (part.type === "reasoning" && part.text) {
        contentBlocks.push({ type: "thinking", thinking: part.text });
      } else if (part.type === "tool") {
        // Preserve the original call id if OpenCode has it; fall back to a
        // deterministic id so the matching tool_result below is still paired.
        const callId = part.callID || deriveUuid(opencodeSessionId, info.id, part.id || "tool", "call");
        contentBlocks.push({
          type: "tool_use",
          id: callId,
          name: part.tool,
          input: part.state?.input ?? {},
        });
        toolUses.push({ part, resolvedCallId: callId });
      }
    }

    const entry = {
      type: info.role,
      uuid: msgUuid,
      parentUuid: previousUuid,
      sessionId,
      timestamp,
      isSidechain: false,
      isMeta: false,
      cwd,
      version,
      message: {
        role: info.role,
        content: contentBlocks.length ? contentBlocks : "",
      },
    };

    if (info.role === "assistant") {
      entry.message.model = info.modelID || model;
      entry.message.usage = {
        input_tokens: info.tokens?.input ?? 0,
        output_tokens: info.tokens?.output ?? 0,
      };
    }

    entries.push(entry);
    previousUuid = msgUuid;

    // Claude Code represents a finished tool call as a separate user entry
    // containing one or more tool_result blocks. Recreate that here.
    if (info.role === "assistant" && toolUses.length > 0) {
      const resultUuid = deriveUuid(opencodeSessionId, info.id, "tool-result");
      const resultTimestamp = toIso(info.time?.completed ?? info.time?.created ?? Date.now());
      const resultBlocks = toolUses.map((tu) => {
        const status = tu.part.state?.status;
        return {
          type: "tool_result",
          tool_use_id: tu.resolvedCallId,
          content: status === "error" ? (tu.part.state?.error || "error") : (tu.part.state?.output ?? ""),
          is_error: status === "error",
        };
      });

      const resultEntry = {
        type: "user",
        uuid: resultUuid,
        parentUuid: previousUuid,
        sessionId,
        timestamp: resultTimestamp,
        isSidechain: false,
        isMeta: false,
        cwd,
        version,
        message: {
          role: "user",
          content: resultBlocks,
        },
      };

      // For a single tool result, also attach the raw fallback OpenCode's own
      // forward converter sometimes relies on.
      if (toolUses.length === 1) {
        const st = toolUses[0].part.state;
        resultEntry.toolUseResult = st?.status === "error" ? (st?.error || "error") : (st?.output ?? "");
      }

      entries.push(resultEntry);
      previousUuid = resultUuid;
    }
  }

  return entries;
}
