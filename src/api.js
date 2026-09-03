import crypto from "node:crypto";
import fs from "node:fs/promises";

import { CLI_CLIENT_TOOL_NAMES } from "./tools.js";

function id() {
  return crypto.randomUUID();
}

function textOf(message) {
  return (message.parts || [])
    .filter((part) => part.type === "text")
    .map((part) => part.text || "")
    .join("");
}

async function responseError(response) {
  const body = await response.text();
  let message = body || `${response.status} ${response.statusText}`;
  try {
    message = JSON.parse(body).error || message;
  } catch {
    // Plain-text server errors are already useful.
  }
  return new Error(`Nexara API: ${message}`);
}

export async function createThread(auth, title = "New chat") {
  const user = await auth.user();
  if (!user) throw new Error("You are not signed in. Run `nexara login` first.");
  const { data, error } = await auth.getClient()
    .from("threads")
    .insert({ user_id: user.id, title: title.slice(0, 80) || "New chat", origin: "cli" })
    .select("id, title, updated_at")
    .single();
  if (!error && data) return data;
  // The production database may not have the thread-origin column yet —
  // PostgREST reports it as 42703 (SQL) or PGRST204 (schema cache on INSERT).
  if (!(error?.code === "42703" || error?.code === "PGRST204") || !/origin/i.test(error.message || "")) {
    throw new Error(error?.message || "Could not create a Nexara conversation.");
  }
  const legacy = await auth.getClient()
    .from("threads")
    .insert({ user_id: user.id, title: title.slice(0, 80) || "New chat" })
    .select("id, title, updated_at")
    .single();
  if (legacy.error || !legacy.data) throw new Error(legacy.error?.message || "Could not create a Nexara conversation.");
  return legacy.data;
}

export async function listThreads(auth, limit = 20) {
  const user = await auth.user();
  if (!user) throw new Error("You are not signed in.");
  const { data, error } = await auth.getClient()
    .from("threads")
    .select("id, title, updated_at, origin")
    .eq("origin", "cli")
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (!error) return data ?? [];
  if (!(error?.code === "42703" || error?.code === "PGRST204") || !/origin/i.test(error.message || "")) {
    throw new Error(error.message);
  }
  const legacy = await auth.getClient()
    .from("threads")
    .select("id, title, updated_at")
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (legacy.error) throw new Error(legacy.error.message);
  return legacy.data ?? [];
}

export async function loadThread(auth, threadId) {
  const user = await auth.user();
  if (!user) throw new Error("You are not signed in.");
  const { data: thread, error: threadError } = await auth.getClient()
    .from("threads")
    .select("id, title, updated_at, origin")
    .eq("id", threadId)
    .eq("origin", "cli")
    .maybeSingle();
  let loadedThread = thread;
  if (threadError) {
    if (!(threadError?.code === "42703" || threadError?.code === "PGRST204") || !/origin/i.test(threadError.message || "")) {
      throw new Error(threadError.message);
    }
    const legacy = await auth.getClient()
      .from("threads")
      .select("id, title, updated_at")
      .eq("id", threadId)
      .maybeSingle();
    if (legacy.error) throw new Error(legacy.error.message);
    loadedThread = legacy.data;
  }
  if (!loadedThread) throw new Error("Conversation not found.");
  const { data: rows, error } = await auth.getClient()
    .from("messages")
    .select("id, role, parts, client_id, created_at")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return {
    thread: loadedThread,
    messages: (rows ?? []).map((row) => ({
      id: row.client_id || row.id,
      role: row.role,
      parts: row.parts ?? [],
    })),
  };
}

function consumeDataLine(raw, state, onStatus, onText, onToolCall, onToolResult, onSource, onFinish) {
  const line = raw.trim();
  if (!line || line.startsWith(":")) return;
  const payload = line.startsWith("data:") ? line.slice(5).trim() : line;
  if (!payload || payload === "[DONE]") return;

  let event;
  try {
    event = JSON.parse(payload);
  } catch {
    // Older data-stream variants can send a quoted text delta.
    if (payload.startsWith('"')) {
      try {
        const text = JSON.parse(payload);
        state.text += text;
        onText(text);
      } catch {
        // Ignore non-JSON protocol comments.
      }
    }
    return;
  }

  const metadata = event.metadata || event.messageMetadata || {};
  if (event.type === "start") {
    if (metadata.model) state.model = metadata.model;
    onStatus?.("waiting");
  } else if (event.type === "text-delta" || event.type === "text" || event.type === "textDelta") {
    const delta = event.delta ?? event.text ?? event.value ?? "";
    if (delta) {
      state.text += delta;
      onText(delta);
    }
  } else if (event.type === "reasoning-delta" || event.type === "reasoning") {
    onStatus?.("thinking");
  } else if (event.type === "tool-input-start") {
    onStatus?.(`tool:${event.toolName || "tool"}`);
  } else if (event.type === "tool-input-available") {
    const name = String(event.toolName || "");
    onStatus?.(`tool:${name || "tool"}`);
    if (CLI_CLIENT_TOOL_NAMES.has(name) && !state.nativeCall) {
      state.nativeCall = {
        name,
        arguments: event.input && typeof event.input === "object" ? event.input : {},
        toolCallId: event.toolCallId || null,
      };
      onToolCall?.(state.nativeCall);
    }
  } else if (event.type === "tool-output-available") {
    onToolResult?.({
      name: event.toolName || "tool",
      toolCallId: event.toolCallId || null,
      output: event.output,
    });
  } else if (event.type === "source-url" || event.type === "source-document") {
    const source = event.url || event.source?.url || event.source;
    if (source) {
      state.sources.push(source);
      onSource?.(source);
    }
  } else if (event.type === "finish") {
    if (metadata.model) state.model = metadata.model;
    onFinish?.(event);
    if (metadata.usage) {
      const usage = metadata.usage;
      const input = Number(usage.inputTokens) || 0;
      const output = Number(usage.outputTokens) || 0;
      if (input + output > 0) state.lastUsage = { inputTokens: input, outputTokens: output };
    }
  } else if (event.type === "error" || event.type === "finish-error") {
    throw new Error(event.errorText || event.error || "The Nexara stream failed.");
  } else if (metadata.usage && event.type) {
    // The finish chunk carries the provider's REAL token counts (the same
    // numbers billing uses). Stash them so /status shows exact context.
    const usage = metadata.usage;
    const input = Number(usage.inputTokens) || 0;
    const output = Number(usage.outputTokens) || 0;
    if (input + output > 0) state.lastUsage = { inputTokens: input, outputTokens: output };
  }
}

export async function sendChat({
  auth,
  appUrl,
  threadId,
  messages,
  model,
  reasoningEffort,
  mode,
  goal,
  onStatus,
  onText,
  onToolCall,
  onToolResult,
  onSource,
  onFinish,
  signal,
  quiet = false,
}) {
  const token = await auth.accessToken();
  if (!token) throw new Error("Your Nexara session expired. Run `nexara login` again.");
  const body = {
    messages,
    threadId,
    model,
    ...(typeof reasoningEffort === "string" ? { reasoningEffort } : {}),
  };
  if (mode) body.mode = mode;
  if (goal) body.goal = goal;
  const response = await fetch(`${appUrl.replace(/\/+$/, "")}/api/chat`, {
    method: "POST",
    headers: {
      Accept: "text/event-stream",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      // The CLI advertises itself as an agent so the server sends its compact
      // local tool set. ask_question is answered by the terminal loop below.
      "x-nexara-agent": "cli",
    },
    signal,
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await responseError(response);
  if (!response.body) throw new Error("Nexara returned an empty response.");

  // The server's automatic context guard may have compacted the oldest
  // messages to fit the model's context window — it signals that through
  // these headers so the CLI can swap its local transcript too.
  const compacted = response.headers.get("x-nexara-compacted") === "1";
  const summary = compacted ? decodeURIComponent(response.headers.get("x-nexara-summary") || "") : null;

  const state = { text: "", nativeCall: null, lastUsage: null, sources: [], model: null };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const writeText = onText ?? ((text) => process.stdout.write(text));
  let buffer = "";
  // The caller owns the chat turn header. Adding a leading newline here made
  // the assistant response feel detached from its prompt and created a
  // visible pause before the first streamed token.
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) consumeDataLine(line, state, onStatus, writeText, onToolCall, onToolResult, onSource, onFinish);
    if (done) break;
  }
  if (buffer) consumeDataLine(buffer, state, onStatus, writeText, onToolCall, onToolResult, onSource, onFinish);
  // The CLI owns the final response renderer. Do not emit a bare newline here:
  // doing so leaves an empty gap before the formatted assistant message.

  return {
    id: id(),
    role: "assistant",
    parts: [{ type: "text", text: state.text }],
    text: state.text,
    compacted,
    summary,
    // Real provider usage for this turn (null when the stream carried none).
    usage: state.lastUsage ?? null,
    nativeCall: state.nativeCall,
    sources: state.sources,
    model: state.model,
  };
}

export function userMessage(text, files = []) {
  const parts = [];
  if (text) parts.push({ type: "text", text });
  for (const file of files) {
    parts.push({
      type: "file",
      mediaType: file.mediaType,
      url: file.dataUrl,
      filename: file.filename,
    });
  }
  return { id: id(), role: "user", parts };
}

export function messageText(message) {
  return textOf(message);
}

/**
 * Transcribes a recorded audio file through the Nexara app's server-side
 * speech-to-text proxy (nvidia/parakeet-tdt-0.6b-v3 on OpenRouter), so the
 * CLI never needs the API key itself.
 */
export async function transcribeAudio({ appUrl, token, filePath }) {
  const data = await fs.readFile(filePath);
  const form = new FormData();
  form.append("file", new Blob([data], { type: "audio/wav" }), "voice.wav");
  const response = await fetch(`${appUrl.replace(/\/+$/, "")}/api/transcribe`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error || `Transcription failed (${response.status}).`);
  }
  return (body?.text ?? "").trim();
}
