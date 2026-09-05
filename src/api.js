import crypto from "node:crypto";
import fs from "node:fs/promises";

import { CLI_CLIENT_TOOL_NAMES } from "./tools.js";
import { withTimeout } from "./auth.js";

function id() {
  return crypto.randomUUID();
}

// See consumeDataLine's text/reasoning accumulation below.
export const MAX_ACCUMULATED_TEXT_BYTES = 4_000_000;

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
  if (response.status === 402 && /not enough compute|top.?up more/i.test(message)) {
    message = "Compute limit reached for this model. Choose another model or wait for your Compute allowance to reset.";
  }
  const error = new Error(`Nexara API: ${message}`);
  error.status = response.status;
  error.retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
  return error;
}

export async function createThread(auth, title = "New chat") {
  const user = await auth.user();
  if (!user) throw new Error("You are not signed in. Run `nexara login` first.");
  const { data, error } = await auth.getClient()
    .from("threads")
    .insert({ user_id: user.id, title: title.slice(0, 80) || "New chat", origin: "cli" })
    .select("id, title, updated_at")
    .single()
    .abortSignal(AbortSignal.timeout(20_000));
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
    .single()
    .abortSignal(AbortSignal.timeout(20_000));
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
    .limit(limit)
    .abortSignal(AbortSignal.timeout(20_000));
  if (!error) return data ?? [];
  if (!(error?.code === "42703" || error?.code === "PGRST204") || !/origin/i.test(error.message || "")) {
    throw new Error(error.message);
  }
  const legacy = await auth.getClient()
    .from("threads")
    .select("id, title, updated_at")
    .order("updated_at", { ascending: false })
    .limit(limit)
    .abortSignal(AbortSignal.timeout(20_000));
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
    .maybeSingle()
    .abortSignal(AbortSignal.timeout(20_000));
  let loadedThread = thread;
  if (threadError) {
    if (!(threadError?.code === "42703" || threadError?.code === "PGRST204") || !/origin/i.test(threadError.message || "")) {
      throw new Error(threadError.message);
    }
    const legacy = await auth.getClient()
      .from("threads")
      .select("id, title, updated_at")
      .eq("id", threadId)
      .maybeSingle()
      .abortSignal(AbortSignal.timeout(20_000));
    if (legacy.error) throw new Error(legacy.error.message);
    loadedThread = legacy.data;
  }
  if (!loadedThread) throw new Error("Conversation not found.");
  const { data: rows, error } = await auth.getClient()
    .from("messages")
    .select("id, role, parts, client_id, created_at")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: true })
    .abortSignal(AbortSignal.timeout(20_000));
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

function parseToolInput(value) {
  if (value && typeof value === "object") return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

export function consumeDataLine(raw, state, onStatus, onText, onToolCall, onToolResult, onSource, onFinish, onReasoning) {
  const line = raw.trim();
  if (!line || line.startsWith(":")) return;
  const payload = line.startsWith("data:") ? line.slice(5).trim() : line;
  if (!payload) return;
  if (payload === "[DONE]") {
    // The classic OpenAI-style SSE terminator. This server's own stream
    // normally finishes via an explicit "finish" event, but a gateway
    // fallback or older stream variant ending with only [DONE] should still
    // count as a complete response -- otherwise a perfectly good answer gets
    // thrown away as STREAM_TERMINATED and retried/failed for no reason.
    state.finished = true;
    return;
  }

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

  const type = String(event.type || event.kind || "").toLowerCase();
  const metadata = event.metadata || event.messageMetadata || state.metadata || {};
  if (type === "message-metadata") {
    state.metadata = event.messageMetadata || event.metadata || event;
    if (state.metadata.model) state.model = state.metadata.model;
    return;
  }
  if (type === "start") {
    if (metadata.model) state.model = metadata.model;
    onStatus?.("waiting");
  } else if (type === "start-step") {
    onStatus?.("working");
  } else if (type === "text-delta" || type === "text" || type === "textdelta") {
    const delta = event.delta ?? event.text ?? event.value ?? "";
    if (delta) {
      // No provider-side bug (a runaway repetition loop, a malfunctioning
      // gateway) should be able to grow this without bound for the whole
      // life of the stream -- the CLI still renders/holds this string in
      // memory as one piece.
      if (state.text.length < MAX_ACCUMULATED_TEXT_BYTES) state.text += delta;
      onText(delta);
    }
  } else if (type === "reasoning-start") {
    onStatus?.("thinking");
  } else if (type === "reasoning-delta" || type === "reasoning") {
    const delta = event.delta ?? event.text ?? event.value ?? "";
    if (delta) {
      if (state.reasoning.length < MAX_ACCUMULATED_TEXT_BYTES) state.reasoning += delta;
      onReasoning?.(delta);
    }
    onStatus?.("thinking");
  } else if (type === "tool-input-start") {
    state.toolInputs ??= new Map();
    if (event.toolCallId) state.toolInputs.set(event.toolCallId, "");
    onStatus?.(`tool:${event.toolName || event.name || event.tool?.name || "tool"}`);
  } else if (type === "tool-input-delta") {
    state.toolInputs ??= new Map();
    const toolCallId = event.toolCallId || "default";
    state.toolInputs.set(toolCallId, `${state.toolInputs.get(toolCallId) || ""}${event.delta || event.inputText || ""}`);
    onStatus?.(`tool:${event.toolName || "tool"}`);
  } else if (type === "tool-input-available" || type === "tool-call") {
    // `toolName` is the current UI-message wire name. Older gateways and
    // relay versions used `name`, and some emitted a nested tool object. Keep
    // all three compatible so a valid client tool call is never silently lost.
    const name = String(event.toolName || event.name || event.tool?.name || "");
    onStatus?.(`tool:${name || "tool"}`);
    // A single assistant step can request several client tools at once (the
    // model called Read+Read, or Read+Search, in parallel). Capturing only
    // the first and silently ignoring the rest left the model waiting
    // forever on a result the CLI never sent back for the others.
    if (CLI_CLIENT_TOOL_NAMES.has(name) && (!event.toolCallId || !state.nativeCalls.some((call) => call.toolCallId === event.toolCallId))) {
      const call = {
        name,
        arguments: parseToolInput(event.input ?? event.arguments ?? event.tool?.input ?? state.toolInputs?.get(event.toolCallId)),
        toolCallId: event.toolCallId || null,
      };
      state.nativeCalls.push(call);
      onToolCall?.(call);
    }
  } else if (type === "tool-output-available" || type === "tool-result") {
    onToolResult?.({
      name: event.toolName || event.name || event.tool?.name || "tool",
      toolCallId: event.toolCallId || null,
      output: event.output,
    });
  } else if (type === "source-url" || type === "source-document") {
    const source = event.url || event.source?.url || event.source;
    if (source) {
      state.sources.push(source);
      onSource?.(source);
    }
  } else if (type === "finish-step") {
    onStatus?.("finalizing");
  } else if (type === "finish") {
    state.finished = true;
    if (metadata.model) state.model = metadata.model;
    onFinish?.(event);
    if (metadata.usage || event.usage) {
      const usage = metadata.usage || event.usage;
      const input = Number(usage.inputTokens) || 0;
      const output = Number(usage.outputTokens) || 0;
      if (input + output > 0) state.lastUsage = { inputTokens: input, outputTokens: output };
    }
  } else if (type === "error" || type === "finish-error" || type === "tool-output-error") {
    const detail = event.errorText || event.error || event.message || event.delta;
    throw new Error(typeof detail === "string" ? detail : "The Nexara stream failed.");
  } else if ((metadata.usage || event.usage) && type) {
    // The finish chunk carries the provider's REAL token counts (the same
    // numbers billing uses). Stash them so /status shows exact context.
    const usage = metadata.usage || event.usage;
    const input = Number(usage.inputTokens) || 0;
    const output = Number(usage.outputTokens) || 0;
    if (input + output > 0) state.lastUsage = { inputTokens: input, outputTokens: output };
  }
}

export async function sendChat({
  auth,
  appUrl,
  threadId,
  cwd,
  messages,
  model,
  reasoningEffort,
  mode,
  goal,
  continueFrom,
  onStatus,
  onText,
  onToolCall,
  onToolResult,
  onSource,
  onFinish,
  onReasoning,
  signal,
  quiet = false,
}) {
  const token = await auth.accessToken({ signal });
  if (!token) throw new Error("Your Nexara session expired. Run `nexara login` again.");
  const body = {
    messages,
    threadId,
    model,
    ...(typeof continueFrom === "string" && continueFrom.trim() ? { continueFrom } : {}),
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
      // Local tools execute relative to this exact directory. Keep the model's
      // workspace context aligned with the client instead of making it infer a
      // project layout from conversation history. Prefer the caller's tracked
      // cwd (state.cwd) over process.cwd() -- /resume can point tool
      // execution at a different saved-session workspace than the directory
      // the process actually started in, and the two must not disagree.
      "x-nexara-cwd": cwd || process.cwd(),
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
  const encodedSummary = response.headers.get("x-nexara-summary") || "";
  let summary = null;
  if (compacted && encodedSummary) {
    try {
      summary = decodeURIComponent(encodedSummary);
    } catch {
      // A malformed optional summary header must not turn a valid streamed
      // response into a client-side failure.
      summary = encodedSummary;
    }
  }

  const state = { text: "", reasoning: "", nativeCalls: [], lastUsage: null, sources: [], model: null, finished: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const writeText = onText ?? ((text) => process.stdout.write(text));
  let buffer = "";
  // The caller owns the chat turn header. Adding a leading newline here made
  // the assistant response feel detached from its prompt and created a
  // visible pause before the first streamed token.
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) consumeDataLine(line, state, onStatus, writeText, onToolCall, onToolResult, onSource, onFinish, onReasoning);
      if (done) break;
    }
    if (buffer) consumeDataLine(buffer, state, onStatus, writeText, onToolCall, onToolResult, onSource, onFinish, onReasoning);
    if (!state.finished) {
      const error = new Error("The response connection ended before the model finished.");
      error.code = "STREAM_TERMINATED";
      throw error;
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    if (/terminated|prematurely|network|fetch failed|socket|connection/i.test(detail)) {
      const wrapped = new Error("The response connection was terminated before the model finished. Please try again.");
      wrapped.code = "STREAM_TERMINATED";
      wrapped.cause = error;
      throw wrapped;
    }
    throw error;
  }
  // The CLI owns the final response renderer. Do not emit a bare newline here:
  // doing so leaves an empty gap before the formatted assistant message.

  return {
    id: id(),
    role: "assistant",
    parts: [
      ...(state.reasoning ? [{ type: "reasoning", text: state.reasoning }] : []),
      { type: "text", text: state.text },
    ],
    text: state.text,
    reasoning: state.reasoning,
    compacted,
    summary,
    // Real provider usage for this turn (null when the stream carried none).
    usage: state.lastUsage ?? null,
    // nativeCall is kept for any code that still expects a single call; the
    // agent loop uses nativeCalls so parallel tool calls all get executed.
    nativeCall: state.nativeCalls[0] || null,
    nativeCalls: state.nativeCalls,
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
    signal: AbortSignal.timeout(90_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error || `Transcription failed (${response.status}).`);
  }
  return (body?.text ?? "").trim();
}
