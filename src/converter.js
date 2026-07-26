// src/converter.js
//
// Converts a Claude Code conversation (see claude-reader.js) into the JSON
// shape that `opencode import` accepts:
//
//   {
//     "info": Session,
//     "messages": [ { "info": Message, "parts": Part[] }, ... ]
//   }
//
// This shape was NOT taken from public docs - it was reverse-verified by
// installing opencode@1.18.5 locally, round-tripping synthetic sessions
// through `opencode import` / `opencode export`, and reading opencode's own
// generated SDK types (@opencode-ai/sdk/dist/gen/types.gen.d.ts) for the
// per-field shapes of Session, UserMessage, AssistantMessage and Part.
// If opencode changes this shape in a future version, re-run that check
// (see README) before trusting this file again.

import crypto from "node:crypto";

// IDs (and the session's created/updated timestamps) are derived
// deterministically from Claude Code's own uuids/timestamps rather than
// randomly generated or read from the wall clock. That makes
// `agentbridge fork` idempotent: forking the *same*, *unchanged* Claude
// session twice produces byte-identical output, so the git ledger records
// "nothing changed" instead of a spurious new commit, and `opencode import`
// updates the same OpenCode session in place instead of creating a
// duplicate every time you re-run it.
function deriveId(prefix, ...parts) {
  const hash = crypto.createHash("sha256").update(parts.join(":")).digest("hex");
  return `${prefix}_${hash.slice(0, 24)}`;
}

function toEpochMs(isoTimestamp, fallback) {
  const t = isoTimestamp ? Date.parse(isoTimestamp) : NaN;
  return Number.isFinite(t) ? t : fallback ?? Date.now();
}

/** Normalize Claude's message.content into an array of content blocks. */
function contentBlocks(message) {
  if (!message) return [];
  if (typeof message.content === "string") {
    return message.content.length ? [{ type: "text", text: message.content }] : [];
  }
  return Array.isArray(message.content) ? message.content : [];
}

/**
 * Extract a plain-text rendering of a tool_result content block's payload,
 * since OpenCode's ToolPart wants a string `output`.
 */
function stringifyToolResult(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "string" ? c : c?.text ?? JSON.stringify(c)))
      .join("\n");
  }
  return JSON.stringify(content);
}

/**
 * Convert a linear Claude Code conversation (already filtered to
 * user/assistant, non-sidechain, non-meta entries) into OpenCode's
 * import JSON.
 *
 * @param {object[]} entries - from claude-reader.toConversation()
 * @param {object} opts
 * @param {string} opts.directory - project directory to attach the session to
 * @param {string} opts.title - session title
 * @param {string} [opts.providerID] - OpenCode provider id to attribute assistant turns to (default "anthropic")
 * @param {string} [opts.agent] - OpenCode agent name (default "build")
 */
export function convertToOpenCode(entries, opts) {
  const { directory, title, providerID = "anthropic", agent = "build", opencodeSessionId } = opts;

  const claudeSessionId = entries.find((e) => e.sessionId)?.sessionId ?? "unknown-session";
  // During sync, the caller can override with the existing OpenCode session id
  // so the new turns are written into the same OpenCode session.
  const sessionId = opencodeSessionId || deriveId("ses", claudeSessionId);

  const timestamps = entries.map((e) => toEpochMs(e.timestamp)).filter(Number.isFinite);
  const created = timestamps.length ? Math.min(...timestamps) : Date.now();
  const updated = timestamps.length ? Math.max(...timestamps) : created;

  // FIFO queue of "tool_use id awaiting a result" - used as a fallback when
  // a tool result isn't explicitly tagged with tool_use_id (older/plainer
  // toolUseResult entries).
  const pendingToolUseIds = [];
  const toolResultById = new Map(); // tool_use_id -> { output, isError }

  // First pass: harvest every tool_result we can find, keyed by tool_use_id
  // when possible, else paired positionally (FIFO) with the earliest tool_use
  // still awaiting a result. We must walk assistant entries here too, so that
  // a tool_use's id lands in the pending queue *before* we reach the later
  // user entry that carries an untagged result for it. (An earlier version
  // only populated the queue in the second pass below, so this fallback never
  // fired and untagged results were silently dropped.)
  for (const entry of entries) {
    const blocks = contentBlocks(entry.message);

    if (entry.type === "assistant") {
      for (const block of blocks) {
        if (block.type === "tool_use") pendingToolUseIds.push(block.id);
      }
      continue;
    }
    if (entry.type !== "user") continue;

    for (const block of blocks) {
      if (block.type === "tool_result") {
        toolResultById.set(block.tool_use_id, {
          output: stringifyToolResult(block.content),
          isError: Boolean(block.is_error),
        });
      }
    }
    // Some Claude Code versions attach the structured result directly to the
    // entry instead of (or in addition to) a tagged content block. Pair it
    // with the oldest tool_use that doesn't already have a (tagged) result.
    // A tagged result always wins, since it is set unconditionally above.
    if (entry.toolUseResult !== undefined) {
      let pendingId;
      do {
        pendingId = pendingToolUseIds.shift();
      } while (pendingId !== undefined && toolResultById.has(pendingId));
      if (pendingId !== undefined && !toolResultById.has(pendingId)) {
        toolResultById.set(pendingId, {
          output: stringifyToolResult(entry.toolUseResult),
          isError: typeof entry.toolUseResult === "string" && /^error/i.test(entry.toolUseResult),
        });
      }
    }
  }

  const messages = [];
  let previousId = null;

  for (const entry of entries) {
    const role = entry.type; // "user" | "assistant"
    const blocks = contentBlocks(entry.message);
    const entryKey = entry.uuid ?? `${role}-${entry.timestamp}`;
    const msgId = deriveId("msg", sessionId, entryKey);
    const createdMs = toEpochMs(entry.timestamp, created);

    const parts = [];
    let partIndex = 0;
    const nextPartId = () => deriveId("prt", msgId, String(partIndex++));

    for (const block of blocks) {
      if (block.type === "text" && block.text) {
        parts.push({
          id: nextPartId(),
          sessionID: sessionId,
          messageID: msgId,
          type: "text",
          text: block.text,
        });
      } else if (block.type === "thinking" && block.thinking) {
        parts.push({
          id: nextPartId(),
          sessionID: sessionId,
          messageID: msgId,
          type: "reasoning",
          text: block.thinking,
          time: { start: createdMs },
        });
      } else if (block.type === "tool_use") {
        const result = toolResultById.get(block.id);
        parts.push({
          id: nextPartId(),
          sessionID: sessionId,
          messageID: msgId,
          type: "tool",
          callID: block.id,
          tool: block.name,
          state: result
            ? {
                status: result.isError ? "error" : "completed",
                input: block.input ?? {},
                ...(result.isError
                  ? { error: result.output }
                  : { output: result.output, title: block.name, metadata: {} }),
                time: { start: createdMs, end: createdMs },
              }
            : {
                // No matching result found in the transcript (e.g. the tool
                // call never finished). Mark it pending rather than invent one.
                status: "pending",
                input: block.input ?? {},
                raw: JSON.stringify(block.input ?? {}),
              },
        });
      }
      // tool_result blocks are consumed above, not rendered as their own part
      // (OpenCode folds a tool's result into the ToolPart's `state`, it
      // doesn't have a separate "tool result" part type).
    }

    // Skip any turn that produced no renderable parts - emitting one shows up
    // as a blank bubble in OpenCode's UI. This covers several real cases:
    //   - Claude's synthetic "here's your tool result" user turn (the result
    //     is folded into the ToolPart's state above, not a separate message);
    //   - assistant turns whose only content is a thinking block with its text
    //     stripped to "" (encrypted/redacted reasoning kept only as a
    //     `signature`) - real sessions contain these in bulk;
    //   - otherwise-empty user/assistant turns.
    // We deliberately do NOT advance previousId when skipping, so the next
    // assistant's parentID chains to the last message we actually emitted
    // rather than to a message id that never appears in `messages`.
    if (parts.length === 0) {
      continue;
    }

    if (role === "user") {
      messages.push({
        info: {
          id: msgId,
          sessionID: sessionId,
          role: "user",
          time: { created: createdMs },
          agent,
          model: {
            providerID,
            modelID: entry.message?.model ?? "unknown",
          },
        },
        parts,
      });
    } else {
      const usage = entry.message?.usage ?? {};
      messages.push({
        info: {
          id: msgId,
          sessionID: sessionId,
          role: "assistant",
          time: { created: createdMs, completed: createdMs },
          parentID: previousId ?? sessionId,
          modelID: entry.message?.model ?? "unknown",
          providerID,
          mode: agent,
          agent,
          path: { cwd: directory, root: directory },
          cost: 0,
          tokens: {
            input: usage.input_tokens ?? 0,
            output: usage.output_tokens ?? 0,
            reasoning: 0,
            cache: {
              read: usage.cache_read_input_tokens ?? 0,
              write: usage.cache_creation_input_tokens ?? 0,
            },
          },
        },
        parts,
      });
    }

    previousId = msgId;
  }

  const info = {
    id: sessionId,
    slug: slugify(title),
    title,
    version: "imported-from-claude-code",
    directory,
    time: { created, updated },
  };

  return { info, messages };
}

function slugify(title) {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "session"
  );
}
