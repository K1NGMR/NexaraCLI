import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { emitKeypressEvents } from "node:readline";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { createAuth } from "./auth.js";
import { createThread, listThreads, loadThread, MAX_ACCUMULATED_TEXT_BYTES, messageText, sendChat, userMessage } from "./api.js";
import { loadConfig, saveConfig } from "./config.js";
import { createTerminalEditor } from "./terminal-editor.js";
import { printQr } from "./qr.js";
import { listLocalSessions, loadLocalSession, localSessionPath, saveLocalSession, SESSION_DIR } from "./sessions.js";
import {
  CLI_LOCAL_TOOL_NAMES,
  backgroundSummary,
  clearBackgroundProcesses,
  executeCliTool,
  isMutatingTool,
  permissionModeLabel,
  resolveWorkspacePath,
  toolAllowedByMode,
  toolPaths,
} from "./tools.js";
import {
  CURRENT_VERSION,
  isAutoUpdateEnabled,
  manualUpdate,
  scheduleAutoUpdate,
  setAutoUpdateEnabled,
} from "./update.js";

// Keep base64-encoded request bodies below common serverless request limits.
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_FILE_BYTES = 15 * 1024 * 1024;
// The per-file caps above bound one attachment, but nothing bounded how many
// of them could ride in the same request -- several max-size attachments
// together could still blow well past a serverless request-body limit, and
// the whole chat request would fail with no clear explanation why.
const MAX_TOTAL_ATTACHMENT_BYTES = 12 * 1024 * 1024;
const MAX_ATTACHMENTS = 8;
const IMAGE_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".bmp", "image/bmp"],
  [".svg", "image/svg+xml"],
]);
// Text/code files are sent as text/plain and read directly by the server.
const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "xml", "yml", "yaml", "toml", "ini", "log",
  "js", "jsx", "ts", "tsx", "mjs", "cjs", "py", "java", "kt", "go", "rs", "rb", "php",
  "c", "cpp", "h", "cs", "swift", "sh", "bash", "sql", "html", "css", "scss",
]);
// Context windows mirror Nexara Web and Nexara Windows. Keeping the CLI
// catalog here means model names, locked entries, and context meters stay
// consistent across every client.
const MODEL_CONTEXT = new Map([
  ["router/openrouter-free", 131_072],
  ["router/autorouter", 131_072],
  ["openai/gpt-oss-120b", 131_072],
  // GPT-5.3 Codex Spark — free + unlimited, ad-funded (web adsterra-config.ts
  // AD_FUNDED_MODEL_IDS). Provider-documented params: max_tokens, temperature,
  // top_p, stop, frequency_penalty, presence_penalty, seed, stream, tools,
  // tool_choice, response_format, structured_outputs, reasoning,
  // include_reasoning. Context/max-output per the gateway's catalog (128k, 65,536).
  ["openai/gpt-5.3-codex-spark", 128_000],
  ["openai/gpt-5.6-luna", 1_000_000],
  ["openai/gpt-5.6-terra", 1_000_000],
  ["moonshotai/kimi-k2.6", 262_144],
  ["moonshotai/kimi-k2.5", 262_144],
  ["google/gemini-3.6-flash", 1_000_000],
  ["google/gemini-3.5-flash", 1_000_000],
  ["google/gemini-3.1-pro", 1_000_000],
  ["google/gemini-3-flash", 1_000_000],
  ["google/gemini-2.5-flash", 1_000_000],
  ["google/gemini-2.5-pro", 1_000_000],
  ["minimax/minimax-m2", 204_800],
  ["minimax/minimax-m2.1-highspeed", 204_800],
  ["minimax/minimax-m2.1", 204_800],
  ["minimax/minimax-m2.5-highspeed", 204_800],
  ["minimax/minimax-m2.5", 204_800],
  ["minimax/minimax-m2.7-highspeed", 204_800],
  ["minimax/minimax-m2.7", 204_800],
  ["minimax/minimax-m3", 1_000_000],
  ["mistralai/ministral-3b", 128_000],
  ["mistralai/ministral-8b", 256_000],
  ["mistralai/ministral-14b", 256_000],
  ["mistralai/devstral-medium", 256_000],
  ["mistralai/codestral-2508", 256_000],
  ["mistralai/mistral-small-2603", 256_000],
  ["mistralai/mistral-medium-3.5", 256_000],
  ["mistralai/mistral-large-2512", 256_000],
  ["inclusion-ai/ling-3.0-flash", 260_096],
  ["stepfun/step-3.7-flash", 256_000],
  ["poolside/laguna-xs.2", 131_072],
  ["nvidia/nemotron-3-nano-30b-a3b", 256_000],
  ["nvidia/nemotron-nano-9b-v2", 128_000],
  ["meta/llama-3.3-70b-instruct", 131_072],
  ["meta/llama-3.2-1b-instruct", 16_384],
  ["meta/llama-3.2-3b-instruct", 16_384],
  ["meta/llama-3.1-8b-instruct", 16_384],
  ["deepseek/deepseek-v4-flash-0731", 1_000_000],
  ["xiaomi/mimo-v2.5-pro:free", 128_000],
  ["xiaomi/mimo-v2.5:free", 128_000],
  ["x-ai/grok-4.5", 500_000],
  ["nvidia/nemotron-3-nano", 1_000_000],
  ["nvidia/nemotron-3-super", 1_000_000],
  ["nvidia/nemotron-3-ultra", 1_000_000],
  ["qwen/qwen3.8-max", 1_000_000],
  ["qwen/qwen3.7-max", 1_000_000],
  ["qwen/qwen3.7-plus", 1_000_000],
  ["qwen/qwen3.6-max-preview", 256_000],
  ["qwen/qwen3.6-plus", 1_000_000],
  ["qwen/qwen3.6-27b", 256_000],
  ["qwen/qwen3.6-35b-a3b", 256_000],
  ["qwen/qwen3.5-plus", 1_000_000],
  ["qwen/qwen3.5-397b-a17b", 256_000],
  ["qwen/qwen3.5-omni-plus", 128_000],
  ["qwen/qwen3.5-flash", 1_000_000],
  ["qwen/qwen3.5-omni-flash", 128_000],
  ["qwen/qwen3-coder-plus", 1_000_000],
  ["qwen/qwen3-max", 256_000],
  ["qwen/qwen3-vl-plus", 256_000],
  ["qwen/qwen3-omni-flash", 128_000],
  ["qwen/qwen-plus-2025-07-28", 1_000_000],
  ["stealth/ox-alpha-free", 1_000_000],
  ["z-ai/glm-4.5-air", 131_072],
  ["z-ai/glm-4.5", 131_072],
  ["z-ai/glm-4.6", 200_000],
  ["z-ai/glm-4.7", 200_000],
  ["z-ai/glm-5", 200_000],
  ["z-ai/glm-5-turbo", 200_000],
  ["z-ai/glm-5.1", 200_000],
  ["z-ai/glm-5.2", 1_000_000],
  ["z-ai/glm-5.3", 1_000_000],
  ["z-ai/glm-5.3-flash", 1_000_000],
  ["sensenova/sensenova-6.7-flash-lite", 262_144],
  ["sensenova/sensenova-6.8-flash-lite", 262_144],
  ["deepseek/deepseek-v3.2", 131_072],
  ["deepseek/deepseek-chat-v3.1", 163_840],
  ["deepseek/deepseek-v4-flash", 1_000_000],
  ["deepseek/deepseek-v4-pro", 1_000_000],
  ["nvidia/llama-3.3-nemotron-super-49b", 131_072],
  ["nvidia/nemotron-3-nano-omni", 256_000],
]);
const LOCKED_MODELS = new Set();
const REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const REASONING_EFFORT_OUTPUT_ESTIMATES = { low: 1024, medium: 2048, high: 4096, xhigh: 8192, max: 16384 };
const REASONING_EFFORT_LABELS = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra High", max: "Max" };
function normalizeReasoningEffort(value) {
  const normalized = String(value ?? "").toLowerCase().replace(/\s+/g, "_");
  return normalized === "extra_high" ? "xhigh" : normalized;
}
const MODEL_PRICING = new Map([
  ["router/openrouter-free", { input: 0, output: 0 }],
  ["openai/gpt-5.6-luna", { input: 0.2, output: 1.05 }],
  ["openai/gpt-5.6-terra", { input: 2.05, output: 11.75 }],
  ["minimax/minimax-m3", { input: 0.3, output: 1.2 }],
  ["deepseek/deepseek-v4-flash-0731", { input: 0.08, output: 0.14 }],
  ["xiaomi/mimo-v2.5-pro:free", { input: 0.43, output: 0.87 }],
  ["xiaomi/mimo-v2.5:free", { input: 0.43, output: 0.87 }],
  ["moonshotai/kimi-k2.6", { input: 0.95, output: 4 }],
  ["moonshotai/kimi-k2.5", { input: 0.57, output: 2.85 }],
  ["google/gemini-3.6-flash", { input: 1.5, output: 7.5 }],
  ["google/gemini-3.5-flash", { input: 1.5, output: 9 }],
  ["google/gemini-3.1-pro", { input: 2, output: 12 }],
  ["google/gemini-3-flash", { input: 0.5, output: 3 }],
  ["google/gemini-2.5-flash", { input: 0.3, output: 2.5 }],
  ["google/gemini-2.5-pro", { input: 1.25, output: 10 }],
]);
const COMPUTE_PER_DOLLAR = 1_250_000;
const MODEL_IMAGE_INPUT = new Set([
  "google/gemini-3.6-flash",
  "google/gemini-3.5-flash",
  "google/gemini-3.1-pro",
  "google/gemini-3-flash",
  "google/gemini-2.5-flash",
  "google/gemini-2.5-pro",
]);

function formatComputeEstimate(providerCost) {
  return `${Math.max(0, Math.round(providerCost * COMPUTE_PER_DOLLAR)).toLocaleString()} Compute`;
}

function formatComputeRate(providerDollarsPerMillion) {
  return `${Math.max(0, Math.round(providerDollarsPerMillion * COMPUTE_PER_DOLLAR)).toLocaleString()} Compute`;
}

function reasoningEffortComputeEstimate(model, effort, inputTokens) {
  const pricing = MODEL_PRICING.get(model);
  if (!pricing) return 0;
  const providerCost = (inputTokens * pricing.input + REASONING_EFFORT_OUTPUT_ESTIMATES[effort] * pricing.output) / 1_000_000;
  return providerCost * COMPUTE_PER_DOLLAR;
}

function printEffortEstimates(model, inputTokens) {
  const pricing = MODEL_PRICING.get(model);
  if (!pricing) return;
  const estimates = [...REASONING_EFFORTS]
    .map((effort) => `${REASONING_EFFORT_LABELS[effort]} ~${Math.round(reasoningEffortComputeEstimate(model, effort, inputTokens)).toLocaleString()} Compute`)
    .join(" · ");
  console.log(color.dim(`Estimated Compute before sending (${formatTokens(inputTokens)} input tokens): ${estimates}`));
  console.log(color.dim("Estimate uses an illustrative response budget; actual Compute usage is reported by the gateway."));
}

const CJK_RE = /[\u3000-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/g;

function estimateTokens(text) {
  if (!text) return 0;
  const cjk = (text.match(CJK_RE) || []).length;
  return Math.ceil(cjk + (text.length - cjk) / 4);
}

function formatTokens(count) {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1000) {
    const value = count / 1000;
    return `${value >= 100 ? Math.round(value) : value.toFixed(1)}k`;
  }
  return String(count);
}

function contextOf(messages) {
  let used = 0;
  for (const message of messages) {
    for (const part of message.parts || []) {
      if (part.type === "text" && part.text) used += estimateTokens(part.text);
      // Attachments: estimate from the data URL payload (~4 chars/token) so
      // a large file/image no longer hides behind a flat "+8".
      if (part.type === "file" && typeof part.url === "string") {
        const comma = part.url.indexOf(",");
        const payload = comma >= 0 ? part.url.length - comma - 1 : 0;
        used += Math.max(8, Math.ceil(payload / 4));
      } else if (part.type === "file") {
        used += 8;
      }
    }
  }
  return used;
}

/**
 * Exact context after the last completed turn, when the stream reported the
 * provider's real usage. inputTokens is precisely what the model received
 * (system + tools + history); its reply adds outputTokens going forward.
 * Falls back to null when this session has no real numbers yet.
 */
function lastRealContext(state) {
  const usage = state.lastUsage;
  if (!usage) return null;
  return (Number(usage.inputTokens) || 0) + (Number(usage.outputTokens) || 0);
}

let MODELS = [
  ["router/autorouter", "AutoRouter (recommended)"],
  ["router/openrouter-free", "OpenRouter Free Route"],
  ["openai/gpt-oss-120b", "GPT-OSS-120B"],
  ["openai/gpt-5.6-luna", "GPT-5.6 Luna"],
  ["openai/gpt-5.6-terra", "GPT-5.6 Terra"],
  ["moonshotai/kimi-k2.6", "Kimi K2.6"],
  ["moonshotai/kimi-k2.5", "Kimi K2.5"],
  ["google/gemini-3.6-flash", "Gemini 3.6 Flash (Vision)"],
  ["google/gemini-3.5-flash", "Gemini 3.5 Flash (Vision)"],
  ["google/gemini-3.1-pro", "Gemini 3.1 Pro (Vision)"],
  ["google/gemini-3-flash", "Gemini 3 Flash (Vision)"],
  ["google/gemini-2.5-flash", "Gemini 2.5 Flash (Vision)"],
  ["google/gemini-2.5-pro", "Gemini 2.5 Pro (Vision)"],
  ["minimax/minimax-m2", "MiniMax M2"],
  ["minimax/minimax-m2.1-highspeed", "MiniMax M2.1 High-Speed"],
  ["minimax/minimax-m2.1", "MiniMax M2.1"],
  ["minimax/minimax-m2.5-highspeed", "MiniMax M2.5 High-Speed"],
  ["minimax/minimax-m2.5", "MiniMax M2.5"],
  ["minimax/minimax-m2.7-highspeed", "MiniMax M2.7 High-Speed"],
  ["minimax/minimax-m2.7", "MiniMax M2.7"],
  ["minimax/minimax-m3", "MiniMax M3"],
  ["mistralai/ministral-3b", "Ministral 3B"],
  ["mistralai/ministral-8b", "Ministral 8B"],
  ["mistralai/ministral-14b", "Ministral 14B"],
  ["mistralai/devstral-medium", "Devstral Medium"],
  ["mistralai/codestral-2508", "Codestral 25.08"],
  ["mistralai/mistral-small-2603", "Mistral Small 26.03"],
  ["mistralai/mistral-medium-3.5", "Mistral Medium 3.5"],
  ["mistralai/mistral-large-2512", "Mistral Large 3"],
  ["inclusion-ai/ling-3.0-flash", "Ling 3.0 Flash"],
  ["stepfun/step-3.7-flash", "Step 3.7 Flash"],
  ["poolside/laguna-xs.2", "Laguna XS.2"],
  ["nvidia/nemotron-3-nano-30b-a3b", "Nemotron 3 Nano 30B A3B"],
  ["nvidia/nemotron-nano-9b-v2", "Nemotron Nano 9B V2"],
  ["meta/llama-3.3-70b-instruct", "Llama 3.3 70B Instruct"],
  ["meta/llama-3.2-1b-instruct", "Llama 3.2 1B Instruct"],
  ["meta/llama-3.2-3b-instruct", "Llama 3.2 3B Instruct"],
  ["meta/llama-3.1-8b-instruct", "Llama 3.1 8B Instruct"],
  ["deepseek/deepseek-v4-flash-0731", "DeepSeek V4 Flash 07.31"],
  ["xiaomi/mimo-v2.5-pro:free", "Xiaomi Mimo V2.5 Pro"],
  ["xiaomi/mimo-v2.5:free", "Xiaomi Mimo V2.5"],
  ["x-ai/grok-4.5", "Grok 4.5"],
  ["nvidia/nemotron-3-nano", "Nemotron 3 Nano"],
  ["nvidia/nemotron-3-super", "Nemotron 3 Super"],
  ["nvidia/nemotron-3-ultra", "Nemotron 3 Ultra"],
  ["qwen/qwen3.8-max", "Qwen 3.8 Max"],
  ["qwen/qwen3.7-max", "Qwen 3.7 Max"],
  ["qwen/qwen3.7-plus", "Qwen 3.7 Plus"],
  ["qwen/qwen3.6-max-preview", "Qwen 3.6 Max (Preview)"],
  ["qwen/qwen3.6-plus", "Qwen 3.6 Plus"],
  ["qwen/qwen3.6-27b", "Qwen 3.6 27B"],
  ["qwen/qwen3.6-35b-a3b", "Qwen 3.6 35B A3B"],
  ["qwen/qwen3.5-plus", "Qwen 3.5 Plus"],
  ["qwen/qwen3.5-397b-a17b", "Qwen 3.5 397B A17B"],
  ["qwen/qwen3.5-omni-plus", "Qwen 3.5 Omni Plus"],
  ["qwen/qwen3.5-flash", "Qwen 3.5 Flash"],
  ["qwen/qwen3.5-omni-flash", "Qwen 3.5 Omni Flash"],
  ["qwen/qwen3-coder-plus", "Qwen3 Coder Plus"],
  ["qwen/qwen3-max", "Qwen3 Max"],
  ["qwen/qwen3-vl-plus", "Qwen3 VL Plus"],
  ["qwen/qwen3-omni-flash", "Qwen3 Omni Flash"],
  ["qwen/qwen-plus-2025-07-28", "Qwen Plus 07.28"],
  ["stealth/ox-alpha-free", "Ox Alpha"],
  ["z-ai/glm-4.5-air", "GLM 4.5 Air"],
  ["z-ai/glm-4.5", "GLM 4.5"],
  ["z-ai/glm-4.6", "GLM 4.6"],
  ["z-ai/glm-4.7", "GLM 4.7"],
  ["z-ai/glm-5", "GLM 5"],
  ["z-ai/glm-5-turbo", "GLM 5 Turbo"],
  ["z-ai/glm-5.1", "GLM 5.1"],
  ["z-ai/glm-5.2", "GLM 5.2"],
  ["z-ai/glm-5.3", "GLM 5.3"],
  ["z-ai/glm-5.3-flash", "GLM 5.3 Flash"],
  ["sensenova/sensenova-6.7-flash-lite", "SenseNova 6.7 Flash-Lite"],
  ["sensenova/sensenova-6.8-flash-lite", "SenseNova 6.8 Flash-Lite"],
  ["deepseek/deepseek-v3.2", "DeepSeek V3.2"],
  ["deepseek/deepseek-chat-v3.1", "DeepSeek Chat V3.1"],
  ["deepseek/deepseek-v4-flash", "DeepSeek V4 Flash"],
  ["deepseek/deepseek-v4-pro", "DeepSeek V4 Pro"],
  ["nvidia/llama-3.3-nemotron-super-49b", "Llama 3.3 Nemotron Super 49B"],
  ["nvidia/nemotron-3-nano-omni", "Nemotron 3 Nano Omni"],
];
const MODEL_ALIASES = new Map([
  ["auto", "router/autorouter"],
  ["autorouter", "router/autorouter"],
  ["router", "router/autorouter"],
  ["openrouter-free", "router/openrouter-free"],
  ["free-route", "router/openrouter-free"],
  ["gpt-oss", "openai/gpt-oss-120b"],
  ["minimax", "minimax/minimax-m2.7-highspeed"],
  ["minimax-m2", "minimax/minimax-m2"],
  ["minimax-m2.1", "minimax/minimax-m2.1"],
  ["minimax-m2.5", "minimax/minimax-m2.5"],
  ["m2.7", "minimax/minimax-m2.7-highspeed"],
  ["m3", "minimax/minimax-m3"],
  ["mimo", "xiaomi/mimo-v2.5-pro:free"],
  ["mimo-pro", "xiaomi/mimo-v2.5-pro:free"],
  ["mimo-v2.5", "xiaomi/mimo-v2.5:free"],
  ["ministral", "mistralai/ministral-8b"],
  ["ministral-3b", "mistralai/ministral-3b"],
  ["ministral-14b", "mistralai/ministral-14b"],
  ["devstral", "mistralai/devstral-medium"],
  ["codestral", "mistralai/codestral-2508"],
  ["mistral-small", "mistralai/mistral-small-2603"],
  ["mistral-medium", "mistralai/mistral-medium-3.5"],
  ["mistral-large", "mistralai/mistral-large-2512"],
  ["ling", "inclusion-ai/ling-3.0-flash"],
  ["step-3.7", "stepfun/step-3.7-flash"],
  ["laguna", "poolside/laguna-xs.2"],
  ["nemotron-nano", "nvidia/nemotron-nano-9b-v2"],
  ["llama", "meta/llama-3.1-8b-instruct"],
  ["deepseek", "deepseek/deepseek-v4-flash"],
  ["deepseek-v3", "deepseek/deepseek-v3.2"],
  ["deepseek-v4-flash", "deepseek/deepseek-v4-flash"],
  ["deepseek-v4-pro", "deepseek/deepseek-v4-pro"],
  ["grok", "x-ai/grok-4.5"],
  ["grok-4.5", "x-ai/grok-4.5"],
  ["luna", "openai/gpt-5.6-luna"],
  ["gpt-5.6-luna", "openai/gpt-5.6-luna"],
  ["terra", "openai/gpt-5.6-terra"],
  ["gpt-5.6-terra", "openai/gpt-5.6-terra"],
  ["kimi", "moonshotai/kimi-k2.6"],
  ["kimi-k2.6", "moonshotai/kimi-k2.6"],
  ["kimi-k2.5", "moonshotai/kimi-k2.5"],
  ["gemini", "google/gemini-3.6-flash"],
  ["gemini-3.6-flash", "google/gemini-3.6-flash"],
  ["gemini-3.5-flash", "google/gemini-3.5-flash"],
  ["gemini-3.1-pro", "google/gemini-3.1-pro"],
  ["gemini-3-flash", "google/gemini-3-flash"],
  ["gemini-2.5-flash", "google/gemini-2.5-flash"],
  ["gemini-2.5-pro", "google/gemini-2.5-pro"],
  ["qwen", "qwen/qwen3.7-max"],
  ["qwen3.7", "qwen/qwen3.7-max"],
  ["qwen-coder", "qwen/qwen3-coder-plus"],
  ["glm", "z-ai/glm-5.2"],
  ["glm-5", "z-ai/glm-5"],
  ["glm-5.2", "z-ai/glm-5.2"],
  ["glm-5.3", "z-ai/glm-5.3"],
  ["glm-5.3-flash", "z-ai/glm-5.3-flash"],
  ["sensenova", "sensenova/sensenova-6.8-flash-lite"],
  ["sensenova-6.7", "sensenova/sensenova-6.7-flash-lite"],
  ["sensenova-6.8", "sensenova/sensenova-6.8-flash-lite"],
]);

// The website is the source of truth for model availability and capabilities.
// Keep the bundled catalog as an offline fallback, but refresh it from the
// sanitized server catalog whenever the CLI starts. This prevents new models,
// vision support, reasoning options, and pricing from drifting between apps.
async function refreshModelCatalog(appUrl) {
  try {
    const response = await fetch(`${String(appUrl || "").replace(/\/+$/, "")}/api/models`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return false;
    const payload = await response.json();
    const remote = Array.isArray(payload?.models) ? payload.models : [];
    const usable = remote.filter((model) => typeof model?.id === "string" && typeof model?.name === "string");
    if (usable.length < 2) return false;
    MODELS = usable.map((model) => [model.id, model.name]);
    MODEL_CONTEXT.clear();
    MODEL_IMAGE_INPUT.clear();
    MODEL_PRICING.clear();
    for (const model of usable) {
      if (Number.isFinite(model.contextWindow) && model.contextWindow > 0) MODEL_CONTEXT.set(model.id, model.contextWindow);
      if (model.imageInput === true) MODEL_IMAGE_INPUT.add(model.id);
      if (Number.isFinite(model.creditInputPricePerM) && Number.isFinite(model.creditOutputPricePerM)) {
        MODEL_PRICING.set(model.id, { input: model.creditInputPricePerM, output: model.creditOutputPricePerM });
      }
    }
    return true;
  } catch {
    // Offline startup remains usable with the bundled fallback catalog.
    return false;
  }
}

const SLASH_COMMANDS = [
  "/help", "/model", "/models", "/effort", "/attach", "/image", "/think", "/research",
  "/perplexity", "/plan", "/honest", "/goal", "/new", "/resume", "/threads", "/clear",
  "/compact", "/config", "/permission", "/permissions", "/tools", "/mcp", "/skills", "/plugins", "/agents", "/background", "/tasks", "/logs",
  "/stop", "/download", "/open", "/reveal", "/doctor", "/login", "/update", "/status", "/quit", "/exit",
];

const SLASH_COMMAND_DESCRIPTIONS = new Map([
  ["/help", "Show commands, shortcuts, login, and automation options."],
  ["/model", "Choose the AI model for this session or set a new default."],
  ["/models", "Print the complete model catalog and Compute rates."],
  ["/effort", "Set reasoning effort: low, medium, high, extra high, or max."],
  ["/attach", "Attach an image, PDF, or text/code file to your next prompt."],
  ["/image", "Attach an image or clear the files waiting for your next prompt."],
  ["/think", "Send a prompt in deep-thinking mode."],
  ["/research", "Search, investigate, and report findings for a prompt."],
  ["/perplexity", "Use search-first mode and include supporting sources."],
  ["/plan", "Plan and validate a project before execution."],
  ["/honest", "Ask for a direct answer with minimal padding."],
  ["/goal", "Work autonomously toward a goal across multiple turns."],
  ["/new", "Start a fresh saved conversation."],
  ["/resume", "Resume the last saved local conversation or choose a thread ID."],
  ["/threads", "Browse conversations saved on this computer."],
  ["/clear", "Clear local context and start a fresh thread."],
  ["/compact", "Summarize the conversation to free context space."],
  ["/config", "Show the local Nexara configuration path."],
  ["/permission", "Choose Always ask, Approve for me, Sandboxed, or Full access."],
  ["/permissions", "Alias for /permission."],
  ["/tools", "Show the tools available to the CLI agent."],
  ["/mcp", "Show MCP configuration and connected server hints."],
  ["/skills", "Show workspace skills available to the CLI agent."],
  ["/plugins", "Show workspace plugins available to the CLI agent."],
  ["/agents", "Show local subagents and their current state."],
  ["/background", "Show background commands and their output state."],
  ["/tasks", "Show active task and background-process activity."],
  ["/logs", "Show output from a background command."],
  ["/stop", "Stop a background command or subagent."],
  ["/download", "Show artifacts saved from the current session."],
  ["/open", "Open a local file with its system application."],
  ["/reveal", "Reveal a local file in Explorer or Finder."],
  ["/doctor", "Check the CLI, account, workspace, and API configuration."],
  ["/login", "Sign in again or switch the active Nexara account."],
  ["/update", "Check for and install a newer CLI version."],
  ["/status", "Show account, model, thread, and context state."],
  ["/quit", "Exit Nexara."],
  ["/exit", "Exit Nexara."],
]);

// Keep human-friendly styling in interactive terminals, but never leak ANSI
// control sequences into pipes, CI logs, or users who explicitly opt out.
// This follows the convention used by mature CLIs: `NO_COLOR` wins, while
// `FORCE_COLOR=1` is available for snapshots and intentionally styled pipes.
const colorEnabled = process.env.NO_COLOR === undefined
  && process.env.TERM !== "dumb"
  && (Boolean(output.isTTY) || process.env.FORCE_COLOR === "1");
const ansi = (code, text) => colorEnabled ? `\u001b[${code}m${text}\u001b[0m` : String(text);
const rgb = (red, green, blue) => (text) => ansi(`38;2;${red};${green};${blue}`, text);
// The CLI uses Nexara's warm dark-surface palette: cream text, coral action,
// teal for healthy state, and amber for attention. It deliberately avoids the
// generic blue/cyan terminal look.
const color = {
  coral: rgb(204, 120, 92),
  coralActive: rgb(169, 88, 62),
  cream: rgb(250, 249, 245),
  muted: rgb(160, 157, 150),
  lightGray: rgb(195, 195, 195),
  teal: rgb(93, 184, 166),
  amber: rgb(232, 165, 90),
  red: rgb(198, 69, 69),
  dim: (text) => ansi("2", text),
  italicMuted: (text) => ansi("3;38;2;160;157;150", text),
  italicCream: (text) => ansi("3;38;2;250;249;245", text),
  green: rgb(93, 184, 114),
  yellow: rgb(212, 160, 23),
  // Compatibility aliases retained while commands transition to the palette.
  cyan: rgb(88, 166, 255),
  white: rgb(250, 249, 245),
  blue: rgb(88, 166, 255),
  magenta: rgb(204, 120, 92),
  // Kept as aliases for older rendering paths, but deliberately mapped to
  // Nexara's warm coral/cream system instead of the old neon green terminal
  // treatment.
  neon: rgb(204, 120, 92),
  terminalWhite: rgb(250, 249, 245),
};
const ANSI_RE = /\u001b\[[0-9;]*m/g;
const ACTIVITY_FRAMES = ["✦", "✧", "❖", "✧", "✦", "⋆", "✧", "·"];
const PROCESSING_FRAMES = ["✦", "✧", "·", "✧"];
const THINKING_FRAMES = ["◐", "◓", "◑", "◒"];
const COMPOSER_INPUT_ROWS = 1;
// The fixed-composer session patches output.write (see realContentRows below)
// to count every newline-terminated write as real, permanent transcript
// content, so it can re-derive the gap that keeps the composer pinned to the
// bottom. That counter has to exclude ephemeral chrome that gets fully wiped
// off screen again (the composer footer itself already does, via the
// function-local "paintingBox" flag) -- but selectModelInteractive,
// selectPermissionInteractive, and selectQuestionInteractive are plain
// top-level functions with no access to that local flag, and their box
// redraws/cleanup are full of embedded newlines. Every arrow-key press while
// browsing one of those pickers was silently inflating realContentRows by a
// full box's worth of "rows" that vanish the moment the picker closes. Once
// inflated enough, later turns believed there was far more real content
// above than actually exists, clamped their placement to the very bottom of
// the transcript region, and started overwriting old rows without clearing
// them first -- the "leftover fragment of an old message" corruption. This
// module-level flag lets those picker functions opt the same way in, from
// outside the session's own closure.
let suppressRealContentRowCount = false;
// Small "copy" affordance shown beside a committed message and in the turn
// footer. Kept to a single BMP glyph so it renders in Windows Terminal.
const COPY_GLYPH = "⧉";

function diagnostic(text) {
  process.stderr.write(`${text}\n`);
}

// Reasoning summaries arrive as plain markdown ("**Planning the layout**")
// but the reasoning panel is rendered as flat muted/italic text, not passed
// through renderTerminalMarkdown like the final answer -- so the raw ** was
// showing up literally instead of turning into emphasis. Rather than pull in
// the full block-level renderer (headings/lists/fences make no sense for a
// stream of short reasoning titles), just drop the emphasis markers so the
// text reads as plain prose, matching what the markers were meant to convey.
function stripInlineMarkdownEmphasis(text) {
  return String(text || "")
    .replace(/\*\*\*(.+?)\*\*\*/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1$2")
    .replace(/__(.+?)__/g, "$1");
}

function activityText(status) {
  if (String(status).startsWith("tool:")) return `Using ${String(status).slice(5)}…`;
  return ({
    waiting: "Processing shared Nexara context…",
    connecting: "Connecting to Nexara…",
    thinking: "Thinking…",
    writing: "Writing response…",
    processing: "Processing shared context…",
    complete: "Done",
  })[status] || String(status || "Working…");
}

// The model's reasoning is buffered as it streams (see onReasoning below) but
// was previously only ever shown as a static "(click to expand)" placeholder
// during the turn -- the actual thought never appeared unless the user found
// and pressed the toggle key. This renders a live, single-line tail of
// whatever has streamed in so far, right in the activity line, with no
// interaction required. Collapses whitespace/newlines to one line since the
// activity line has exactly one row to work with; the full multi-line
// reasoning is still available afterward via Thinking/toggleThinking.
function livePreviewLine(prefix, text, maxWidth, fallback) {
  const flattened = String(text || "").replace(/\s+/g, " ").trim();
  if (!flattened) return fallback;
  const budget = Math.max(8, maxWidth - visibleLength(prefix));
  // Show the TAIL, not the head -- the most recent token is what's actually
  // in progress right now, same reason a log tail beats a log head.
  const tail = flattened.length > budget ? `…${flattened.slice(-(budget - 1))}` : flattened;
  return `${prefix}${tail}`;
}

function thinkingPreviewLine(text, maxWidth) {
  return livePreviewLine("Thinking: ", stripInlineMarkdownEmphasis(text), maxWidth, "Thinking…");
}

// A live truncated tail of the response as it streams in -- shown in place
// of a static "Writing response" label so the AI visibly appears to type
// instead of going silent and then dumping the whole answer at once. This
// intentionally stays a single plain-text line rather than incrementally
// rendering markdown into the transcript: markdown (an unclosed code fence,
// a list that's still growing) can only be rendered correctly once the full
// block is known, and the transcript's absolute-cursor system needs the
// final row count up front -- both would have to be reinvented to stream
// formatted output safely. The full, correctly rendered answer still gets
// printed once, exactly as before, right after this preview is cleared.
function writingPreviewLine(text, maxWidth) {
  return livePreviewLine("", text, maxWidth, "Writing response");
}

function composerActivityLine(state) {
  const status = String(state.composerActivity || "");
  if (!status) return null;
  const frame = Number(state.composerActivityFrame || 0);
  if (status === "thinking") {
    const preview = thinkingPreviewLine(state.thinkingText, Math.max(20, Math.min(60, terminalWidth() - 20)));
    return `${color.amber(THINKING_FRAMES[frame % THINKING_FRAMES.length])} ${color.muted(preview)}`;
  }
  if (status === "writing") {
    const preview = writingPreviewLine(state.streamedText, Math.max(20, Math.min(60, terminalWidth() - 20)));
    return `${color.coral(PROCESSING_FRAMES[frame % PROCESSING_FRAMES.length])} ${color.muted(preview)}`;
  }
  const label = activityText(status);
  return `${color.coral(PROCESSING_FRAMES[frame % PROCESSING_FRAMES.length])} ${color.muted(label)}`;
}

function setComposerActivity(state, status) {
  if (!state.interactive) return;
  state.composerActivity = status || null;
  state.composerActivityFrame = 0;
  state.refreshComposer?.();
}

function startComposerActivityAnimation(state) {
  if (!state.interactive || !input.isTTY || !output.isTTY) return () => {};
  state.composerActivity = "processing";
  state.composerActivityFrame = 0;
  const timer = setInterval(() => {
    state.composerActivityFrame = Number(state.composerActivityFrame || 0) + 1;
    state.refreshComposer?.();
  }, 360);
  return () => {
    clearInterval(timer);
    state.composerActivity = null;
    state.composerActivityFrame = 0;
  };
}

function createActivityLine({ quiet = false, streamJson = false, getCursorOffset = () => 0, getCursorCol = () => 0, stableComposer = false, transcript = null, getThinkingPreview = null, getWritingPreview = null } = {}) {
  const startedAt = Date.now();
  let status = "waiting";
  let frame = 0;
  let visible = false;
  let timer = null;
  const machine = (event) => {
    if (streamJson) process.stdout.write(`${JSON.stringify(event)}\n`);
  };
  // While reasoning is in progress, show a live tail of it instead of the
  // static "Thinking…" label -- the whole point is to see the thought as it
  // happens, not just know that thinking is happening. Falls back to the
  // static label for any other status, or if the caller has no preview.
  const activityLineText = (maxWidth) => {
    if (status === "thinking" && getThinkingPreview) return thinkingPreviewLine(getThinkingPreview(), maxWidth);
    if (status === "writing" && getWritingPreview) return writingPreviewLine(getWritingPreview(), maxWidth);
    return activityText(status);
  };
  // Moving up `offset` rows to redraw the activity line, then back down
  // `offset` rows, only restores the ROW -- cursor-down keeps whatever
  // column the activity line's own text left it at, not the column readline
  // had. Without this, the input caret visibly jumps to a different column
  // every time this redraws, which is exactly what it looked like while a
  // turn was in flight.
  const restoreCol = () => {
    const col = Math.max(0, Number(getCursorCol()) || 0);
    return col ? `\r\u001b[${col}C` : "\r";
  };
  const render = () => {
    if (quiet || streamJson || !output.isTTY) return;
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    const glyph = ACTIVITY_FRAMES[frame % ACTIVITY_FRAMES.length];
    const paint = [color.coral, color.amber, color.teal, color.coral][frame % 4];
    // Preferred path: a reserved transcript row, painted in place at an
    // absolute address, so the live status sits where the answer will land.
    if (transcript?.begin?.()) {
      const inline = `  ${paint(glyph)} ${color.muted(activityLineText(Math.max(20, terminalWidth() - 10)))} ${color.dim(`${seconds}s`)}`;
      if (transcript.paint?.(inline)) {
        visible = true;
        return;
      }
    }
    // Fallback: readline owns the active composer row, so a relative move
    // above it makes readline's cursor model stale. Interactive sessions
    // without a reserved row keep the state in the fixed footer instead.
    if (stableComposer) return;
    visible = true;
    const line = `\r\u001b[2K  ${paint(glyph)} ${color.muted(activityLineText(Math.max(20, terminalWidth() - 10)))} ${color.dim(`${seconds}s`)}`;
    const offset = Math.max(0, Number(getCursorOffset()) || 0);
    if (offset) output.write(`\u001b[${offset}A${line}\u001b[${offset}B${restoreCol()}`);
    else output.write(line);
  };
  if (!quiet && !streamJson && output.isTTY) {
    timer = setInterval(() => {
      frame += 1;
      render();
    }, 120);
  }
  return {
    set(next) {
      status = next || "working";
      const elapsedMs = Date.now() - startedAt;
      machine({ type: "status", status, elapsedMs });
      machine({ type: "progress", status, elapsedMs });
      render();
    },
    clear() {
      if (timer) clearInterval(timer);
      timer = null;
      transcript?.end?.();
      if (visible && output.isTTY && !streamJson && !stableComposer) {
        const offset = Math.max(0, Number(getCursorOffset()) || 0);
        if (offset) output.write(`\u001b[${offset}A\r\u001b[2K\u001b[${offset}B${restoreCol()}`);
        else output.write("\r\u001b[2K");
      }
      visible = false;
    },
    render,
    event: machine,
  };
}

const DOUBLE_ESCAPE_WINDOW_MS = 850;

function isEscapeKey(str, key = {}) {
  const name = String(key.name || "").toLowerCase();
  const sequence = key.sequence || str || "";
  return name === "escape" || sequence === "\u001b";
}

// Node's readline key names are not consistent across Windows Terminal,
// ConHost, and application-keypad mode. Keep picker navigation in one place so
// /model, /permission, and slash completion all understand normal arrows,
// VT100 arrows, modified CSI arrows, Home/End, PageUp/PageDown, and the
// physical numpad 8/2 keys. `allowNumpadDigits` is intentionally opt-in: a
// typed `2` in `/model2` must remain text, while a raw picker has no text line
// and can safely treat keypad digits as navigation.
function navigationAction(str, key = {}, { allowNumpadDigits = false } = {}) {
  const name = String(key.name || "").toLowerCase();
  const sequence = String(key.sequence || str || "");
  const csi = sequence.match(/\u001b\[[0-9;?]*([A-HF])$/)?.[1] || "";
  const application = sequence.match(/\u001bO([ABHF])$/)?.[1] || "";
  const direction = csi || application;
  const isDigit = (value) => allowNumpadDigits && (name === value || sequence === value);
  if (name === "up" || name === "k" || direction === "A" || isDigit("8")) return "up";
  if (name === "down" || name === "j" || direction === "B" || isDigit("2")) return "down";
  if (name === "pageup" || sequence === "\u001b[5~") return "pageup";
  if (name === "pagedown" || sequence === "\u001b[6~") return "pagedown";
  if (name === "home" || direction === "H" || sequence === "\u001b[1~") return "home";
  if (name === "end" || direction === "F" || sequence === "\u001b[4~") return "end";
  return null;
}

async function selectQuestionInteractive(question) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") return null;

  let selected = 0;
  let scrollTop = 0;
  const chosen = new Set();
  const viewport = Math.max(3, Math.min(question.options.length, pickerTerminalHeight() - 9));
  const ensureVisible = () => {
    if (selected < scrollTop) scrollTop = selected;
    if (selected >= scrollTop + viewport) scrollTop = selected - viewport + 1;
  };
  const fit = (value, width) => {
    const plain = String(value || "");
    return shorten(plain, Math.max(1, width));
  };
  const render = () => {
    ensureVisible();
    // Never demand a wider box than the real terminal has -- a floor here
    // forced lines to physically wrap in a narrower window, and finish()'s
    // cleanup below moves by LOGICAL row count, so those extra wrapped rows
    // desynced it and left part of the box behind on screen after closing.
    const width = terminalWidth();
    const inner = width - 7;
    const hint = question.multiSelect
      ? "↑/↓ or numpad 8/2 move · Space toggle · Enter select · Esc cancel"
      : "↑/↓ or numpad 8/2 move · Enter select · Esc cancel";
    const lines = [
      `  ${color.coral("╭")}${color.coral("─".repeat(width - 4))}${color.coral("╮")}`,
      `  ${color.coral("│")} ${color.cream(fit(question.question, inner))}${" ".repeat(Math.max(0, inner - visibleLength(fit(question.question, inner))))} ${color.coral("│")}`,
      `  ${color.coral("│")} ${color.muted(fit(hint, inner))}${" ".repeat(Math.max(0, inner - visibleLength(fit(hint, inner))))} ${color.coral("│")}`,
      `  ${color.coral("├")}${color.coral("─".repeat(width - 4))}${color.coral("┤")}`,
    ];
    for (let offset = 0; offset < viewport; offset += 1) {
      const index = scrollTop + offset;
      const option = question.options[index];
      if (!option) {
        lines.push(`  ${color.coral("│")}${" ".repeat(width - 2)}${color.coral("│")}`);
        continue;
      }
      const active = index === selected;
      const checked = chosen.has(index);
      const marker = question.multiSelect ? (checked ? color.teal("☑") : color.dim("☐")) : active ? color.coral("›") : color.dim("·");
      const label = active ? color.cream(option.label) : color.muted(option.label);
      const description = option.description ? color.dim(` — ${option.description}`) : "";
      const content = fit(`  ${marker} ${label}${description}`, inner);
      lines.push(`  ${color.coral("│")} ${content}${" ".repeat(Math.max(0, inner - visibleLength(content)))} ${color.coral("│")}`);
    }
    const footer = `${scrollTop ? "↑ more above · " : ""}${scrollTop + viewport < question.options.length ? "↓ more below" : "ready"}`;
    lines.push(`  ${color.coral("├")}${color.coral("─".repeat(width - 4))}${color.coral("┤")}`);
    lines.push(`  ${color.coral("│")} ${color.muted(footer)}${" ".repeat(Math.max(0, inner - visibleLength(footer)))} ${color.coral("│")}`);
    lines.push(`  ${color.coral("╰")}${color.coral("─".repeat(width - 4))}${color.coral("╯")}`);
    return lines;
  };

  emitKeypressEvents(input);
  const previousRawMode = input.isRaw;
  input.setRawMode(true);
  input.resume();
  suppressRealContentRowCount = true;
  let lines = render();
  // The very first draw can land with the cursor mid-line (e.g. right after
  // the "/model" text the user just typed, or after clearComposerFooter's
  // cursor-restore in fixed-composer mode) -- unlike redraw()/finish() below,
  // which reset every row with an explicit carriage return, this had none,
  // so the box top row got appended after leftover column content instead of
  // starting fresh. On a narrow terminal that pushed the row past its width
  // and wrapped it into an extra physical row lines.length never counted, so
  // finish()'s cursor-up-by-(lines.length-1) stopped one row short of the
  // real top and left a fragment (often just the top border) on screen after
  // the picker closed. Forcing a carriage return before every row guarantees
  // each one starts at column 0, exactly like the redraw/cleanup paths below.
  output.write(`\u001b[?25l\r${lines.join("\n\r")}`);

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value, error = null) => {
      if (settled) return;
      settled = true;
      input.removeListener("keypress", onKeypress);
      input.setRawMode(Boolean(previousRawMode));
      output.write(`\u001b[${lines.length - 1}A${lines.map(() => "\u001b[2K\r").join("\n")}\u001b[?25h\r\n`);
      suppressRealContentRowCount = false;
      if (error) reject(error);
      else resolve(value);
    };
    const redraw = () => {
      output.write(`\u001b[${lines.length - 1}A`);
      lines = render();
      output.write(lines.map((line) => `\u001b[2K\r${line}`).join("\n"));
    };
    const move = (delta) => {
      selected = Math.max(0, Math.min(question.options.length - 1, selected + delta));
      redraw();
    };
    const onKeypress = (str, key = {}) => {
      const name = String(key.name || "").toLowerCase();
      const sequence = key.sequence || str || "";
      const action = navigationAction(str, key, { allowNumpadDigits: true });
      if (key.ctrl && name === "c") { finish(null, new Error("Aborted with Ctrl+C")); return; }
      if (isEscapeKey(str, key)) { finish(null); return; }
      if (action === "up") { move(-1); return; }
      if (action === "down") { move(1); return; }
      if (action === "pageup") { move(-viewport); return; }
      if (action === "pagedown") { move(viewport); return; }
      if (action === "home") { selected = 0; redraw(); return; }
      if (action === "end") { selected = question.options.length - 1; redraw(); return; }
      if (question.multiSelect && (name === "space" || sequence === " ")) {
        if (chosen.has(selected)) chosen.delete(selected); else chosen.add(selected);
        redraw();
        return;
      }
      if (name === "return" || name === "enter" || sequence === "\r" || sequence === "\n") {
        const indices = question.multiSelect && chosen.size ? [...chosen].sort((a, b) => a - b) : [selected];
        finish(indices.map((index) => question.options[index].label));
      }
    };
    input.on("keypress", onKeypress);
  });
}

function installEscapeExit() {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") return () => {};
  emitKeypressEvents(input);
  let lastEscapeAt = 0;
  let resetTimer = null;
  let active = true;
  const remove = () => {
    if (!active) return;
    active = false;
    input.removeListener("keypress", onKeypress);
    if (resetTimer) clearTimeout(resetTimer);
  };
  const registerEscape = () => {
    const now = Date.now();
    if (now - lastEscapeAt <= DOUBLE_ESCAPE_WINDOW_MS) {
      remove();
      if (input.isRaw) input.setRawMode(false);
      // The mouse protocol may be enabled while a live Thinking line is
      // visible. Since process.exit skips the interactive cleanup finally
      // block, explicitly restore terminal mouse/cursor state before leaving.
      output.write("\r\n\u001b[?1006l\u001b[?1000l\u001b[?25h");
      restoreTerminalScreen();
      // process.exit also skips whatever would normally stop RunInBackground
      // commands and subagents on exit -- left running, they hold ports and
      // files that break the next `nexara` invocation in this workspace.
      clearBackgroundProcesses();
      process.exit(0);
      return;
    }
    lastEscapeAt = now;
    if (resetTimer) clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      lastEscapeAt = 0;
      resetTimer = null;
    }, DOUBLE_ESCAPE_WINDOW_MS);
  };
  const onKeypress = (str, key = {}) => {
    const sequence = key.sequence || str || "";
    for (let index = 0; index < sequence.length; index += 1) {
      if (sequence[index] !== "\u001b") continue;
      const next = sequence[index + 1];
      // A terminal arrow/function-key sequence begins with ESC+[ or ESC+O;
      // only count standalone Escape bytes, including combined double-Esc.
      if (next === "[" || next === "O") continue;
      registerEscape();
    }
  };
  input.on("keypress", onKeypress);
  return remove;
}

function displayPath(directory = process.cwd()) {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  if (home && directory.toLowerCase().startsWith(home.toLowerCase())) {
    return `~${directory.slice(home.length)}`;
  }
  return directory;
}

function visibleLength(text) {
  return String(text).replace(ANSI_RE, "").length;
}

function terminalWidth() {
  const columns = Number(output.columns) || 80;
  // Leave a two-column safety margin. Terminals wrap a line written exactly
  // to the last column, which turns in-place picker redraws into new rows.
  return Math.max(20, columns - 2);
}

let alternateScreenActive = false;

// The alternate screen buffer ([?1049h) used to be the default here so
// exiting could cleanly restore whatever was on screen before Nexara
// started. The cost, discovered the hard way: most terminal emulators
// (Windows Terminal included) give the alt screen NO scrollback at all, so
// there was no way to scroll up and reread anything earlier in a long
// conversation -- for a chat tool, that matters far more than a tidy exit.
// Staying in the primary buffer costs nothing else: the scroll-region +
// absolute-cursor system below (transcriptBottom/prepareTranscript etc.)
// operates on whatever buffer is active and looks identical either way.
// NEXARA_ALT_SCREEN=1 opts back into the old no-scrollback behavior for
// anyone who prefers a clean restore over scrollback.
let usingAltScreenBuffer = false;
function enterTerminalScreen() {
  if (!input.isTTY || !output.isTTY) return;
  if (alternateScreenActive) return;
  if (process.env.NEXARA_ALT_SCREEN === "1") {
    output.write("\u001b[?1049h\u001b[2J\u001b[H\u001b[?25l");
    usingAltScreenBuffer = true;
  } else {
    output.write("\u001b[2J\u001b[H\u001b[?25l");
    usingAltScreenBuffer = false;
  }
  alternateScreenActive = true;
}

function restoreTerminalScreen() {
  if (!alternateScreenActive) return;
  alternateScreenActive = false;
  // Restore the shell buffer, then erase the command line position that the
  // TUI inherited. Without this final line cleanup, Windows Terminal can
  // leave fragments of the launch command or typed input behind the prompt.
  const exitAltScreen = usingAltScreenBuffer ? "\u001b[?1049l" : "";
  output.write(`\u001b[?1006l\u001b[?1000l\u001b[?2004l\u001b[?1004l${exitAltScreen}\u001b[?25h\u001b[0m\r\u001b[2K\r\n`);
}

function clearTerminalForSession() {
  if (!input.isTTY || !output.isTTY || process.env.NEXARA_NO_CLEAR === "1") return;
  // Clear only the visible viewport; preserve the user's terminal scrollback.
  // Also reset mouse tracking left behind by an older/crashed CLI process.
  output.write("\u001b[r\u001b[0m\u001b[?1006l\u001b[?1000l\u001b[2J\u001b[H");
}

function shorten(text, width) {
  if (visibleLength(text) <= width) return text;
  const plain = String(text).replace(ANSI_RE, "");
  return `${plain.slice(0, Math.max(1, width - 1))}…`;
}

function panelLine(text, innerWidth) {
  const content = shorten(text, innerWidth);
  return `  ${color.muted("│")} ${content}${" ".repeat(Math.max(0, innerWidth - visibleLength(content)))} ${color.muted("│")}`;
}

function printPanel(lines, { accent = color.coral } = {}) {
  const width = terminalWidth();
  // Two leading spaces plus the framed content must fit inside the terminal;
  // keeping this calculation centralized prevents border spill on Windows
  // Terminal, where an extra column is especially noticeable.
  const innerWidth = width - 6;
  console.log(`  ${accent("╭")}${accent("─".repeat(width - 4))}${accent("╮")}`);
  for (const line of lines) console.log(panelLine(line, innerWidth));
  console.log(`  ${accent("╰")}${accent("─".repeat(width - 4))}${accent("╯")}`);
}

function chip(label, value, accent = color.coral) {
  return `${accent(` ${label.toUpperCase()} `)} ${color.cream(value)}`;
}

function contextBar(percent, segments = 18) {
  const filled = Math.max(0, Math.min(segments, Math.round((percent / 100) * segments)));
  return `${color.coral("━".repeat(filled))}${color.muted("─".repeat(segments - filled))}`;
}

function notice(message, tone = "teal") {
  const marker = tone === "red" ? "×" : tone === "amber" ? "!" : "✓";
  const paint = color[tone] || color.teal;
  console.log(`  ${paint(marker)} ${message}`);
}

function composerNotice(state, message, tone = "teal") {
  // A live readline prompt owns the rows below the transcript. Printing over
  // it and then redrawing the footer can erase the message entirely, making a
  // provider failure look like the model simply stopped.
  state.clearComposer?.();
  notice(message, tone);
  state.mountComposer?.();
}

function isRetryableGenerationError(error) {
  if (!error || error.name === "AbortError") return false;
  if (error.retryable === true || error.code === "STREAM_TERMINATED") return true;
  const status = Number(error.status);
  if ([408, 425, 429].includes(status) || status >= 500) return true;
  return /rate.?limit|temporar|timeout|timed out|terminated|premature|network|fetch failed|socket|connection reset|overloaded|empty response/i.test(String(error.message || error));
}

function toolArgumentPreview(name, args = {}) {
  const value = args.command || args.file_path || args.path || args.pattern || args.query || args.url || args.message;
  if (typeof value === "string" && value.trim()) return shorten(value.trim(), Math.max(24, terminalWidth() - 25));
  if (name === "CheckPort" && args.port) return `${args.host || "127.0.0.1"}:${args.port}`;
  if (name === "ask_question") return `${Array.isArray(args.questions) ? args.questions.length : 1} question${Array.isArray(args.questions) && args.questions.length === 1 ? "" : "s"}`;
  return "";
}

function formatToolName(name) {
  const clean = String(name || "tool").trim();
  const mapping = {
    ReadFile: "Read",
    WriteFile: "Write",
    EditFile: "Edit",
    ListFiles: "List",
    SearchFiles: "Search",
    RunCommand: "Bash",
    CheckPort: "CheckPort",
    ask_question: "AskQuestion",
    TodoWrite: "TodoWrite",
  };
  return mapping[clean] || clean;
}

function formatPathWithTilde(filepath, cwd) {
  if (typeof filepath !== "string" || !filepath.trim()) return "";
  let str = filepath.trim();
  try {
    const home = os.homedir();
    if (home && (str.startsWith(home) || str.toLowerCase().startsWith(home.toLowerCase()))) {
      str = "~" + str.slice(home.length);
    } else if (cwd && (str.startsWith(cwd) || str.toLowerCase().startsWith(cwd.toLowerCase()))) {
      const rel = str.slice(cwd.length).replace(/^[/\\]+/, "");
      if (rel) str = rel;
    }
  } catch {}
  return str.replaceAll("\\", "/");
}

function formatToolParamSummary(name, args = {}, cwd = "") {
  const pathVal = args.file_path || args.path || args.filePath || args.dir || args.target;
  if (pathVal && typeof pathVal === "string") {
    return formatPathWithTilde(pathVal, cwd);
  }
  if (args.command && typeof args.command === "string") {
    return shorten(args.command.trim().replaceAll("\n", " "), 60);
  }
  if (args.pattern && typeof args.pattern === "string") {
    return args.pattern.trim();
  }
  if (args.query && typeof args.query === "string") {
    return args.query.trim();
  }
  if (args.url && typeof args.url === "string") {
    return args.url.trim();
  }
  if (name === "CheckPort" && args.port) {
    return `${args.host || "127.0.0.1"}:${args.port}`;
  }
  const fallback = toolArgumentPreview(name, args);
  return fallback ? formatPathWithTilde(fallback, cwd) : "";
}

function printModelChangeMessage(modelName, effort = "", state = null) {
  if (state) state.prepareTranscript?.(2);
  const effortLabel = effort ? ` (${REASONING_EFFORT_LABELS[effort] || effort})` : "";
  console.log(`  ${color.blue("> /model")}`);
  console.log(`  ${color.blue("  ⎿  ")}${color.lightGray(`Model set to ${modelName}${effortLabel}`)}`);
  if (state) (state.scheduleMountComposer || state.mountComposer)?.();
}

function printToolCall(call, { cwd = "", streamJson = false, state = null } = {}) {
  if (streamJson || !call) return;
  if (state) {
    setComposerActivity(state, null);
    state.prepareTranscript?.(1);
  }

  const name = call.name || "tool";
  const args = call.arguments || {};
  const toolNameYellow = color.yellow(formatToolName(name));
  const paramStr = formatToolParamSummary(name, args, cwd);
  const paramFormatted = paramStr ? `(${paramStr})` : "";

  console.log(`  ${color.blue("●")} ${toolNameYellow}${paramFormatted}`);

  if (state) (state.scheduleMountComposer || state.mountComposer)?.();
}

function printToolResult(name, result, { args = {}, cwd = "", error = false, streamJson = false, state = null } = {}) {
  const text = String(result || "").trim();
  if (streamJson) return;
  if (state) {
    setComposerActivity(state, null);
    state.prepareTranscript?.(error && text ? 2 : 1);
  }

  const circle = error ? color.red("●") : color.blue("●");
  const toolNameYellow = color.yellow(formatToolName(name));
  const paramStr = formatToolParamSummary(name, args, cwd);
  const paramFormatted = paramStr ? `(${paramStr})` : "";
  const expandHint = color.dim(" (ctrl+o to expand)");

  if (error) {
    console.log(`  ${circle} ${toolNameYellow}${paramFormatted}${expandHint}`);
    if (text) {
      const firstLine = text.split(/\r?\n/)[0] || text;
      console.log(`  ${color.blue("  ⎿  ")}${color.red(firstLine)}`);
    }
  }

  if (state) {
    state.lastToolResults ??= [];
    state.lastToolResults.push({ name, paramStr, result: text, error, expanded: false });
    (state.scheduleMountComposer || state.mountComposer)?.();
  }
}

function toggleExpandLastToolResult(state) {
  if (!state?.lastToolResults || !state.lastToolResults.length) return;
  const last = state.lastToolResults[state.lastToolResults.length - 1];
  last.expanded = !last.expanded;
  state.clearComposer?.();
  if (last.expanded) {
    console.log(`\n  ${last.error ? color.red("●") : color.blue("●")} ${color.yellow(formatToolName(last.name))}${last.paramStr ? `(${last.paramStr})` : ""} ${color.dim("(expanded)")}`);
    const lines = wrapChatText(last.result, Math.max(32, terminalWidth() - 9));
    for (const line of lines) {
      console.log(`       ${color.dim(line)}`);
    }
    console.log("");
  } else {
    console.log(`  ${color.dim("(collapsed)")}`);
  }
  state.mountComposer?.();
}

function normalizeCliTodos(rawTodos) {
  if (!Array.isArray(rawTodos)) return [];
  return rawTodos
    .slice(0, 40)
    .map((todo) => {
      const content = String(todo?.content ?? todo?.title ?? "").trim();
      const status = String(todo?.status ?? "pending").trim().toLowerCase();
      if (!content || !["pending", "in_progress", "completed", "cancelled"].includes(status)) return null;
      return { content, status };
    })
    .filter(Boolean);
}

function applyCliTodoUpdate(current, rawTodos, mode = "replace") {
  const next = normalizeCliTodos(rawTodos);
  if (String(mode).toLowerCase() !== "add") return next;
  const merged = Array.isArray(current) ? current.map((todo) => ({ ...todo })) : [];
  for (const todo of next) {
    const existing = merged.find((item) => item.content === todo.content);
    if (existing) existing.status = todo.status;
    else merged.push(todo);
  }
  return merged;
}

function todoStatusGlyph(status) {
  if (status === "completed") return color.teal("✓");
  if (status === "in_progress") return color.coral("●");
  if (status === "cancelled") return color.red("×");
  return color.muted("○");
}

function todoSummary(todos) {
  const total = todos.length;
  const completed = todos.filter((todo) => todo.status === "completed").length;
  const active = todos.filter((todo) => todo.status === "in_progress").length;
  if (!total) return "no tasks";
  return `${completed}/${total} complete${active ? ` · ${active} in progress` : ""}`;
}

function todoStatusLabel(status) {
  return ({
    in_progress: "IN PROGRESS",
    pending: "NEXT UP",
    completed: "COMPLETED",
    cancelled: "CANCELLED",
  })[status] || "NEXT UP";
}

function todoProgressBar(todos, width = 18) {
  const completed = todos.filter((todo) => todo.status === "completed").length;
  const filled = todos.length ? Math.round((completed / todos.length) * width) : 0;
  return `${color.teal("━".repeat(filled))}${color.dim("─".repeat(Math.max(0, width - filled)))}`;
}

function printTodoList(todos, { compact = false, state = null } = {}) {
  if (!Array.isArray(todos) || !todos.length) return;
  const width = Math.max(36, terminalWidth() - 4);
  const innerWidth = width - 4; // width inside border vertical bars

  // Build every line of the box as a clean string first
  const boxLines = [];
  const heading = compact ? "TASK BOARD" : "TASK BOARD UPDATED";
  const topBar = `  ${color.dim("╭─")} ${color.cream(heading)} ${color.dim("─".repeat(Math.max(1, innerWidth - heading.length - 2)))}${color.dim("╮")}`;
  boxLines.push(topBar);

  const summaryStr = `${todoSummary(todos)}  ${todoProgressBar(todos)}`;
  const summaryPad = Math.max(0, innerWidth - visibleLength(summaryStr));
  boxLines.push(`  ${color.dim("│")} ${color.muted(todoSummary(todos))}  ${todoProgressBar(todos)}${" ".repeat(summaryPad)}${color.dim("│")}`);

  const midBar = `  ${color.dim("├─")} ${color.dim("WORKSTREAMS")} ${color.dim("─".repeat(Math.max(1, innerWidth - 13)))}${color.dim("┤")}`;
  boxLines.push(midBar);

  const groups = ["in_progress", "pending", "completed", "cancelled"];
  for (const status of groups) {
    const entries = todos.map((todo, index) => ({ todo, index })).filter(({ todo }) => todo.status === status);
    if (!entries.length) continue;
    const statusColor = status === "completed" ? color.teal
      : status === "in_progress" ? color.coral
        : status === "cancelled" ? color.red : color.amber;
    
    const headerStr = `${todoStatusLabel(status)} · ${entries.length}`;
    const headerPad = Math.max(0, innerWidth - (todoStatusLabel(status).length + 3 + String(entries.length).length));
    boxLines.push(`  ${color.dim("│")} ${statusColor(todoStatusLabel(status))} ${color.dim(`· ${entries.length}`)}${" ".repeat(headerPad)}${color.dim("│")}`);

    for (const { todo, index } of entries) {
      const rows = wrapChatText(todo.content, Math.max(20, innerWidth - 11));
      const marker = todoStatusGlyph(todo.status);
      rows.forEach((row, rowIndex) => {
        const prefixVisibleLen = rowIndex === 0 ? 8 : 10;
        const prefixStr = rowIndex === 0
          ? `${marker} ${color.muted(String(index + 1).padStart(2, "0"))} ${color.dim("│")} `
          : "          ";
        const contentLen = visibleLength(row);
        const rowPad = Math.max(0, innerWidth - prefixVisibleLen - contentLen);
        boxLines.push(`  ${color.dim("│")} ${prefixStr}${color.cream(row)}${" ".repeat(rowPad)}${color.dim("│")}`);
      });
    }
  }

  const footerBar = `  ${color.dim("╰─")} ${color.dim("Updated by Nexara")} ${color.dim("─".repeat(Math.max(1, innerWidth - 20)))}${color.dim("╯")}`;
  boxLines.push(footerBar);

  if (state) {
    state.prepareTranscript?.(boxLines.length);
  }
  for (const line of boxLines) {
    console.log(line);
  }
  if (state) {
    (state.scheduleMountComposer || state.mountComposer)?.();
  }
}

function outputToolEvent(state, event) {
  if (state.outputFormat !== "stream-json") return;
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function effectivePermissionMode(state) {
  return state.config.permissionMode || "ask";
}

// Tool output (file contents, command output, error text) is embedded in a
// plain <tool_result> text wrapper the model is instructed to read as
// structured output. It is not parsed as real XML, but a file or command
// output containing the literal closing tag could still look like it ends
// the tool result early, right before attacker- or accident-supplied text
// that reads as a new instruction. Neutralize any embedded close tag so the
// wrapper this call created is the only one that can close it.
function escapeToolResultBody(text) {
  return String(text ?? "").replace(/<\/tool_result>/gi, "<\\/tool_result>");
}

function toolRuleMatches(rule, name) {
  const pattern = String(rule || "").trim();
  const toolName = String(name || "");
  if (!pattern) return false;
  if (pattern === toolName) return true;
  return pattern.endsWith("*") && toolName.startsWith(pattern.slice(0, -1));
}

function isToolConfigured(state, name) {
  const toolName = String(name || "");
  const denied = Array.isArray(state.config.disallowedTools) && state.config.disallowedTools.some((rule) => toolRuleMatches(rule, toolName));
  if (denied) return false;
  return true;
}

export function toolAccessDecision(state, name) {
  if (!isToolConfigured(state, name)) return { action: "deny", reason: "blocked by disallowed-tools" };
  // Non-mutating tools (Read, List, Search, Glob, ...) must clear before the
  // read-only/plan gate below -- otherwise those modes deny every tool,
  // including safe reads, which defeats their entire purpose (investigate
  // without being able to change anything).
  if (!isMutatingTool(name)) return { action: "allow" };
  const mode = effectivePermissionMode(state);
  if (mode === "read-only" || mode === "plan") return { action: "deny", reason: permissionModeLabel(mode) };
  if (Array.isArray(state.config.allowedTools) && state.config.allowedTools.some((rule) => toolRuleMatches(rule, name))) return { action: "allow" };
  if (toolAllowedByMode(name, mode)) return { action: "allow" };
  return { action: "ask" };
}

function normalizeQuestionInput(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const rawQuestions = Array.isArray(source.questions) ? source.questions : [source];
  const questions = rawQuestions.slice(0, 3).map((question, index) => {
    const item = question && typeof question === "object" ? question : {};
    const options = Array.isArray(item.options) && item.options.length >= 2
      ? item.options.slice(0, 6).map((option) => typeof option === "string" ? { label: option } : option)
      : [{ label: "Continue with best judgment" }, { label: "Tell Nexara what to use" }];
    return {
      header: String(item.header || `Question ${index + 1}`).slice(0, 24),
      question: String(item.question || item.prompt || item.title || "What should Nexara use before continuing?").trim(),
      options: options.map((option) => ({ label: String(option?.label || option?.name || option?.value || "Continue"), description: option?.description ? String(option.description) : "" })),
      multiSelect: item.multiSelect === true,
    };
  });
  return questions;
}

async function askTerminalQuestion(state, rawInput) {
  const questions = normalizeQuestionInput(rawInput);
  outputToolEvent(state, { type: "question", questions });
  if (!state.askQuestion) return "The CLI could not open an interactive question prompt; continue with sensible defaults.";
  // Every other tool event unmounts the fixed composer rail before printing
  // and remounts it after (see the tool-call/tool-result sites below). This
  // one printed straight to the transcript with the rail still mounted and
  // the scroll region still confined, so the question/options text landed
  // on the rail's own rows instead of scrolling into the transcript — the
  // "only one line visible, question and options gone" bug.
  state.clearComposer?.();
  const answers = [];
  for (const question of questions) {
    const selected = state.askChoice
      ? await state.askChoice(question)
      : (await state.askQuestion(`${color.coral("  ›")} Choose a number or type your answer: `)).trim().split(",").map((item) => {
        const index = Number(item.trim()) - 1;
        return Number.isInteger(index) && question.options[index] ? question.options[index].label : item.trim();
      }).filter(Boolean);
    answers.push(`${question.header}: ${(selected || []).join(", ") || "Continue with best judgment"}`);
  }
  state.mountComposer?.();
  return answers.join("\n");
}

async function requestToolApproval(state, name, args, { outsidePaths = [] } = {}) {
  if (!state.askApproval) return false;
  const preview = toolArgumentPreview(name, args);
  const outside = outsidePaths.length ? `\n    Outside workspace: ${outsidePaths.join(", ")}` : "";
  outputToolEvent(state, { type: "approval-request", name, input: args, outsidePaths });
  const answer = (await state.askApproval(
    `${name}${preview ? ` · ${preview}` : ""}${outside}\n    Allow this action? [y]es / [n]o / [a]lways allow this tool: `,
  )).trim().toLowerCase();
  if (answer === "a" || answer === "always") {
    const current = Array.isArray(state.config.allowedTools) ? state.config.allowedTools : [];
    if (!current.includes(name)) state.config = { ...state.config, ...saveConfig({ allowedTools: [...current, name] }) };
    return true;
  }
  return answer === "y" || answer === "yes";
}

async function runClientTool(state, call, signal) {
  const name = String(call?.name || "");
  const args = call?.arguments && typeof call.arguments === "object" ? call.arguments : {};
  if (name === "ask_question") return askTerminalQuestion(state, args);
  const decision = toolAccessDecision(state, name);
  if (decision.action === "deny") {
    const message = `Tool ${name} was denied (${decision.reason}).`;
    printToolResult(name, message, { error: true, args, cwd: state.cwd, streamJson: state.outputFormat === "stream-json", state });
    return message;
  }
  const outsidePaths = toolPaths(name, args, state.cwd).filter((value) => value);
  // Approvals are remembered per exact (tool, paths) combination -- not as a
  // single session-wide switch -- so re-reading/re-running the SAME outside
  // action doesn't re-prompt every turn, without silently widening access to
  // a DIFFERENT outside path the user never actually approved.
  const outsideActionKey = outsidePaths.length ? `${name}:${outsidePaths.join("|")}` : null;
  const outsideAlreadyApproved = Boolean(outsideActionKey && state.approvedOutsideActions?.has(outsideActionKey));
  const outsideApprovalRequired = outsidePaths.length > 0
    && effectivePermissionMode(state) !== "full"
    && !state.allowOutsidePaths
    && !outsideAlreadyApproved;
  if (decision.action === "ask" || outsideApprovalRequired) {
    const approved = await requestToolApproval(state, name, args, { outsidePaths });
    if (!approved) {
      const message = `Tool ${name} was denied by the user.`;
      printToolResult(name, message, { error: true, args, cwd: state.cwd, streamJson: state.outputFormat === "stream-json", state });
      return message;
    }
    if (outsideApprovalRequired && outsideActionKey && effectivePermissionMode(state) !== "sandboxed") {
      state.approvedOutsideActions ??= new Set();
      state.approvedOutsideActions.add(outsideActionKey);
    }
  }
  if (signal?.aborted) {
    const message = `Tool ${name} was cancelled before it started.`;
    printToolResult(name, message, { error: true, args, cwd: state.cwd, streamJson: state.outputFormat === "stream-json", state });
    return message;
  }
  try {
    const result = await executeCliTool(name, args, { cwd: state.cwd, allowOutside: outsidePaths.length > 0, signal });
    if (name === "TodoWrite") {
      state.todos = applyCliTodoUpdate(state.todos, args.todos, args.mode);
      if (state.outputFormat !== "stream-json") printTodoList(state.todos, { state });
      outputToolEvent(state, { type: "todo-update", todos: state.todos });
    }
    printToolResult(name, result, { args, cwd: state.cwd, streamJson: state.outputFormat === "stream-json", state });
    return result;
  } catch (error) {
    const message = `Tool ${name} failed: ${error instanceof Error ? error.message : String(error)}`;
    printToolResult(name, message, { error: true, args, cwd: state.cwd, streamJson: state.outputFormat === "stream-json", state });
    return message;
  }
}

async function saveServerArtifact(state, name, output) {
  let value = output && typeof output === "object" ? output : null;
  if (!value && typeof output === "string") {
    try {
      const parsed = JSON.parse(output);
      value = parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      // Human-readable server tool results do not contain an artifact payload.
    }
  }
  if (!value || typeof value.dataUrl !== "string" || !value.dataUrl.startsWith("data:")) return null;
  const match = value.dataUrl.match(/^data:([^;,]+);base64,(.+)$/s);
  if (!match) return null;
  const extension = match[1] === "application/pdf" ? ".pdf" : match[1].startsWith("image/") ? `.${match[1].slice(6).replace("jpeg", "jpg")}` : ".bin";
  const filename = String(value.filename || `${name}-${Date.now()}${extension}`).replace(/[^a-z0-9._-]+/gi, "-");
  const directory = path.join(state.cwd, ".nexara-artifacts");
  await fs.mkdir(directory, { recursive: true });
  const filePath = path.join(directory, filename || `${name}-${Date.now()}${extension}`);
  await fs.writeFile(filePath, Buffer.from(match[2], "base64"));
  return filePath;
}

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function animateText(text, paint = color.muted) {
  if (!input.isTTY || !output.isTTY || process.env.NEXARA_NO_ANIMATION === "1") {
    console.log(paint(text));
    return;
  }
  for (const character of text) {
    output.write(paint(character));
    await pause(12);
  }
  output.write("\n");
}

async function printBanner(config, user = null, { resumed = false } = {}) {
  // OpenCode's current shell reserves the canvas for the welcome surface and
  // keeps workspace/account metadata in the footer. The transcript renderer
  // owns everything after this point.
}

function printNewConversationIntro() {
  const width = Math.max(42, terminalWidth());
  const center = (value) => {
    const padding = Math.max(0, Math.floor((width - visibleLength(value)) / 2));
    return `${" ".repeat(padding)}${value}`;
  };
  console.log();
  // Keep the OpenCode home composition, but use a legible Nexara label
  // instead of the decorative block-glyph wordmark.
  console.log(center(color.cream("Nexara")));
  console.log(center(color.muted("the open source coding agent")));
  console.log();
  console.log(center(color.dim('Ask anything… "Fix a TODO in the codebase"')));
  console.log();
}

function printLoginScreen() {
  console.log();
  printPanel([
    `${color.coral("✦")} ${color.cream("Sign in to Nexara")}`,
    color.muted("Your account, models, and saved threads."),
    "",
    `${color.coral("1")}  ${color.cream("Continue with Google")}`,
    `${color.coral("2")}  ${color.cream("Scan a QR code")}`,
  ]);
  console.log(color.dim("  Select a method below. Your credentials stay inside the CLI sign-in flow.\n"));
}

async function confirmWorkspace(config) {
  if (!input.isTTY || !output.isTTY) return true;
  const directory = path.resolve(process.cwd());
  const trusted = Array.isArray(config.trustedDirectories) && config.trustedDirectories.some((entry) => entry.toLowerCase() === directory.toLowerCase());
  if (trusted || process.env.NEXARA_SKIP_WORKSPACE_TRUST === "1") return true;

  console.log();
  console.log(color.amber("  Accessing workspace:"));
  console.log();
  console.log(`  ${color.cream(directory)}`);
  console.log();
  console.log(color.muted("  Quick safety check: Is this a project you created or one you trust?"));
  console.log(color.muted("  Nexara can use files you explicitly attach from this folder."));
  console.log();
  const selected = await selectWorkspaceTrust();
  if (!selected) {
    console.log(color.yellow("\n  Workspace not trusted. Nexara is exiting."));
    return false;
  }
  const directories = Array.isArray(config.trustedDirectories) ? config.trustedDirectories : [];
  saveConfig({ trustedDirectories: [...new Set([...directories, directory])] });
  console.log(color.teal("\n  ✓ Workspace trusted for future Nexara sessions.\n"));
  console.log();
  return true;
}

async function selectWorkspaceTrust() {
  const options = [
    { label: "No, exit", description: "Leave this workspace and close Nexara." },
    { label: "Yes, I trust this folder", description: "Remember this folder for future sessions." },
  ];
  let selected = 0;

  const render = () => {
    const lines = options.map((option, index) => {
      const active = index === selected;
      const marker = active ? color.coral("›") : color.dim("·");
      const label = active ? color.cream(option.label) : color.muted(option.label);
      const description = active ? color.muted(` — ${option.description}`) : "";
      return `  ${marker} ${label}${description}`;
    });
    lines.push(color.dim("  ↑/↓ or numpad 8/2 to move · Enter to select · Esc twice to exit"));
    return lines;
  };

  if (typeof input.setRawMode !== "function") {
    const rl = readline.createInterface({ input, output });
    try {
      const answer = (await rl.question(`  ${color.coral("› ")}`)).trim().toLowerCase();
      return answer === "y" || answer === "yes" || answer === "2";
    } finally {
      rl.close();
    }
  }

  emitKeypressEvents(input);
  const previousRawMode = input.isRaw;
  input.setRawMode(true);
  input.resume();
  suppressRealContentRowCount = true;
  output.write("\u001b[?25l");
  let lines = render();
  output.write(lines.join("\r\n"));

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value, error = null) => {
      if (settled) return;
      settled = true;
      input.removeListener("keypress", onKeypress);
      input.setRawMode(Boolean(previousRawMode));
      output.write("\r\n\u001b[?25h");
      suppressRealContentRowCount = false;
      if (error) reject(error);
      else resolve(value);
    };
    const redraw = () => {
      output.write(`\u001b[${lines.length - 1}A`);
      lines = render();
      output.write(lines.map((line) => `\u001b[2K\r${line}`).join("\r\n"));
    };
    const onKeypress = (str, key = {}) => {
      const name = String(key.name || "").toLowerCase();
      const sequence = key.sequence || str || "";
      const up = name === "up" || name === "k" || name === "8" || sequence === "\u001b[A" || sequence === "\u001bOA";
      const down = name === "down" || name === "j" || name === "2" || sequence === "\u001b[B" || sequence === "\u001bOB";
      const previous = name === "left" || name === "4" || sequence === "\u001b[D" || sequence === "\u001bOD";
      const next = name === "right" || name === "6" || sequence === "\u001b[C" || sequence === "\u001bOC";
      if (key.ctrl && name === "c") {
        finish(false, new Error("Aborted with Ctrl+C"));
        return;
      }
      if (isEscapeKey(str, key)) return;
      if (name === "return" || name === "enter" || sequence === "\r" || sequence === "\n") {
        finish(selected === 1);
        return;
      }
      if (name === "y" || str === "y" || str === "Y") {
        selected = 1;
        redraw();
        return;
      }
      if (name === "n" || str === "n" || str === "N") {
        selected = 0;
        redraw();
        return;
      }
      if (up || previous) {
        selected = (selected + options.length - 1) % options.length;
        redraw();
      } else if (down || next) {
        selected = (selected + 1) % options.length;
        redraw();
      }
    };
    input.on("keypress", onKeypress);
  });
}

function wrapChatText(text, width = Math.max(24, terminalWidth() - 6)) {
  const rows = [];
  for (const sourceLine of String(text || "").split(/\r?\n/)) {
    if (!sourceLine) {
      rows.push("");
      continue;
    }
    let remaining = sourceLine;
    while (remaining.length > width) {
      let cut = remaining.lastIndexOf(" ", width);
      if (cut < Math.floor(width * 0.55)) cut = width;
      rows.push(remaining.slice(0, cut));
      remaining = remaining.slice(cut).replace(/^\s+/, "");
    }
    rows.push(remaining);
  }
  return rows;
}

function userTurnLine(text) {
  return `${color.coral("›")} ${color.cream(text)}`;
}

// Blank rows printed BEFORE the "You" line, so a new prompt never visually
// runs into the end of the previous assistant response above it -- kept as
// one constant so userTurnRows() (which prepareTranscript() uses to reserve
// exactly the right number of rows) can never drift out of sync with what
// printUserTurn() actually writes.


function userTurnRows(text, files = []) {
  const width = Math.max(20, terminalWidth());
  const wrappedLines = wrapChatText(text, Math.max(16, width - 6));
  return 1 + wrappedLines.length + (files.length ? 1 : 0) + 1;
}

function printUserTurn(text, files = [], timestamp = null) {
  const width = Math.max(20, terminalWidth());
  console.log();
  const lines = wrapChatText(text, Math.max(16, width - 6));
  lines.forEach((line, index) => {
    const trailer = index === lines.length - 1 ? ` ${color.dim(COPY_GLYPH)}` : "";
    console.log(`  ${color.cream(line)}${trailer}`);
  });
  if (files.length) {
    console.log(`    ${color.muted("Attached")} ${files.map((file) => color.coral(file.filename)).join(color.muted(" · "))}`);
  }
}

function printAssistantHeader(state, mode) {
  const model = modelLabel(state?.config?.selectedModel);
  console.log();
  console.log(`  ${color.coral("Nexara")} ${color.dim(`· ${model}`)}`);
}

function printConversationHistory(state) {
  const messages = Array.isArray(state.messages) ? state.messages : [];
  for (const message of messages) {
    const role = String(message?.role || "").toLowerCase();
    const text = messageText(message).trim();
    // Tool results are implementation context, not chat bubbles. Rendering
    // them on resume makes the transcript look like a log dump and pushes the
    // actual conversation away from the top of the viewport.
    if (role === "user" && /^<tool_result\b/i.test(text)) continue;
    if (role === "user") {
      const files = (message.parts || [])
        .filter((part) => part?.type === "file")
        .map((part) => ({ filename: part.filename || "attachment" }));
      if (text) printUserTurn(text, files, message.created_at || message.createdAt || null);
      continue;
    }
    if (role !== "assistant") continue;
    if (!text && message.nativeCall) {
      printToolCall(message.nativeCall);
      continue;
    }
    if (!text) continue;
    printAssistantHeader(state);
    const reasoning = stripInlineMarkdownEmphasis((message.parts || [])
      .filter((part) => part?.type === "reasoning" || part?.type === "thinking")
      .map((part) => part.text || part.content || "")
      .join("\n")
      .trim());
    if (reasoning) {
      console.log(`  ${color.cream("▾ Thinking")}`);
      process.stdout.write(`${reasoning.split(/\r?\n/).map((line) => `    ${color.italicMuted(line)}`).join("\n")}\n\n`);
    }
    process.stdout.write(`${indentAssistantText(wrapRenderedTerminalMarkdown(renderTerminalMarkdown(text, { colorize: false })))}\n`);
  }
  if (messages.some((message) => String(message?.role || "").toLowerCase() === "user" || String(message?.role || "").toLowerCase() === "assistant")) {
    console.log(color.dim("  ── live transcript ──"));
  }
}

function printTurnComplete(startedAt) {
  const elapsedSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
  // A quiet right-aligned meta rail (copy · duration · scroll) instead of a
  // left-aligned "Completed in Ns" sentence, so the answer itself stays the
  // only thing reading as content in the transcript.
  const meta = `${COPY_GLYPH} • ${elapsedSeconds}s • ▵▿`;
  const pad = Math.max(1, terminalWidth() - meta.length);
  console.log(`${" ".repeat(pad)}${color.dim(meta)}`);
}

function printSessionFooter(state) {
  const activity = composerActivityLine(state);
  let statusText;
  if (activity) {
    statusText = activity;
  } else {
    const used = lastRealContext(state) ?? contextOf(state.messages || []);
    const windowSize = MODEL_CONTEXT.get(state.config.selectedModel) ?? 128_000;
    const percent = Math.min(100, Math.round((used / windowSize) * 100));
    const lead = state.busy ? color.coral("●") : color.teal("●");
    const label = state.busy ? "Working" : "Ready";
    statusText = `${lead} ${color.muted(label)} ${color.dim("·")} ${color.muted(`${percent}% context`)} ${color.dim("·")} ${color.muted(modelLabel(state.config.selectedModel))}`;
  }
  const width = Math.max(24, terminalWidth());
  const model = modelLabel(state.config.selectedModel);
  const status = state.busy
    ? `${model}  ·  working`
    : `${model}  ·  unlimited`;
  const fittedStatus = shorten(status, width - 2);
  const statusLine = `${fittedStatus}${" ".repeat(Math.max(0, width - visibleLength(fittedStatus)))}`;
  const border = "─".repeat(width);
  // Full-width model strip and a plain rectangular composer mirror the
  // PowerShell reference while retaining the CLI's live activity details.
  process.stdout.write(`${ansi("48;2;24;23;21;38;2;250;249;245", statusLine)}\n`);
  process.stdout.write(`${color.terminalWhite("┌")}${color.terminalWhite(border)}${color.terminalWhite("┐")}\n`);
  return 2;
}

function renderTerminalInlineMarkdown(value, colorize = true) {
  const paint = (fn, text) => colorize ? fn(text) : text;
  const tokens = [];
  const stash = (valueToKeep) => {
    const token = `\u0000${tokens.length}\u0000`;
    tokens.push(valueToKeep);
    return token;
  };
  let line = String(value || "").replace(/\\([\\`*_[\]{}()#+.!>-])/g, "$1");
  line = line.replace(/`([^`\n]+)`/g, (_match, code) => stash(paint(color.teal, code)));
  line = line.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, (_match, label, url) => stash(`${paint(color.teal, label)} ${paint(color.dim, `(${url})`)}`));
  line = line.replace(/(\*\*|__)(.+?)\1/g, (_match, _marker, content) => stash(colorize ? ansi("1;38;2;250;249;245", content) : content));
  line = line.replace(/~~(.+?)~~/g, (_match, content) => stash(paint(color.dim, content)));
  line = line.replace(/(?<!\w)(\*|_)([^*_\n]+)\1(?!\w)/g, (_match, _marker, content) => stash(colorize ? ansi("3;38;2;160;157;150", content) : content));
  // If a model sends an unmatched emphasis marker, never expose the raw
  // Markdown punctuation as part of the user-facing answer.
  line = line.replace(/\*\*|__/g, "");
  // Restore protected code/link spans last so punctuation in identifiers such
  // as __init__ is never interpreted as Markdown.
  return line.replace(/\u0000(\d+)\u0000/g, (_match, index) => tokens[Number(index)] || "");
}

function renderTerminalMarkdown(text, { colorize = true } = {}) {
  const paint = (fn, value) => colorize ? fn(value) : value;
  const lines = String(text || "").replace(/\r\n?/g, "\n").replace(ANSI_RE, "").split("\n");
  const rendered = [];
  let inFence = false;
  let fenceChar = "`";
  let fenceLanguage = "";
  for (const sourceLine of lines) {
    const fence = sourceLine.match(/^\s*(`{3,}|~{3,})\s*([^ ]*)?.*$/);
    if (fence) {
      const char = fence[1][0];
      if (!inFence) {
        inFence = true;
        fenceChar = char;
        fenceLanguage = String(fence[2] || "").trim();
        rendered.push(`  ${paint(color.muted, `┌─ ${fenceLanguage || "code"}`)}`);
      } else if (char === fenceChar) {
        inFence = false;
        rendered.push(`  ${paint(color.muted, "└─")}`);
      } else {
        rendered.push(`  ${paint(color.muted, "│")} ${paint(color.cream, sourceLine)}`);
      }
      continue;
    }
    if (inFence) {
      rendered.push(`  ${paint(color.muted, "│")} ${paint(color.cream, sourceLine)}`);
      continue;
    }
    if (!sourceLine.trim()) {
      rendered.push("");
      continue;
    }
    const heading = sourceLine.match(/^\s*#{1,6}\s+(.+?)\s*#*\s*$/);
    if (heading) {
      rendered.push(`${paint(color.coral, "▸")} ${paint(color.cream, renderTerminalInlineMarkdown(heading[1], colorize))}`);
      continue;
    }
    const quote = sourceLine.match(/^(\s*)>\s?(.*)$/);
    if (quote) {
      rendered.push(`${quote[1]}${paint(color.muted, "│")} ${renderTerminalInlineMarkdown(quote[2], colorize)}`);
      continue;
    }
    const list = sourceLine.match(/^(\s*)([-+*])\s+(.*)$/);
    if (list) {
      const checkbox = list[3].match(/^\[([ xX])\]\s+(.*)$/);
      const marker = checkbox
        ? checkbox[1].toLowerCase() === "x" ? paint(color.teal, "✓") : paint(color.muted, "○")
        : paint(color.coral, "•");
      const content = checkbox ? checkbox[2] : list[3];
      rendered.push(`${list[1]}${marker} ${renderTerminalInlineMarkdown(content, colorize)}`);
      continue;
    }
    const numbered = sourceLine.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
    if (numbered) {
      rendered.push(`${numbered[1]}${paint(color.coral, `${numbered[2]}.`)} ${renderTerminalInlineMarkdown(numbered[3], colorize)}`);
      continue;
    }
    if (/^\s*(?:---+|___+|\*\s*\*\s*\*+)\s*$/.test(sourceLine)) {
      rendered.push(`  ${paint(color.muted, "─".repeat(Math.max(12, Math.min(terminalWidth() - 6, 72))))}`);
      continue;
    }
    rendered.push(renderTerminalInlineMarkdown(sourceLine, colorize));
  }
  return rendered.join("\n").replace(/\n+$/, "");
}

function wrapRenderedTerminalMarkdown(text) {
  const width = Math.max(20, terminalWidth() - 2);
  return String(text || "").split("\n").flatMap((line) => {
    if (!line) return [""];
    if (visibleLength(line) <= width) return [line];
    // Markdown has already been rendered and may contain ANSI styling. Use a
    // plain-width wrap here rather than letting the terminal soft-wrap it,
    // which would break the transcript's visual rhythm and picker geometry.
    return wrapChatText(line.replace(ANSI_RE, ""), width);
  }).join("\n");
}

function indentAssistantText(text) {
  return String(text || "").split("\n").map((line) => line ? `  ${line}` : "").join("\n");
}

function modelLabel(id) {
  return MODELS.find(([modelId]) => modelId === id)?.[1] || id;
}

function resolveModel(value) {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  const alias = MODEL_ALIASES.get(normalized);
  if (alias) return LOCKED_MODELS.has(alias) ? null : alias;
  const exact = MODELS.find(([id]) => id.toLowerCase() === normalized);
  if (exact) return LOCKED_MODELS.has(exact[0]) ? null : exact[0];
  const byName = MODELS.find(([, label]) => label.toLowerCase() === normalized);
  if (byName) return LOCKED_MODELS.has(byName[0]) ? null : byName[0];
  const partial = MODELS.find(([id, label]) => `${id} ${label}`.toLowerCase().includes(normalized));
  return partial && !LOCKED_MODELS.has(partial[0]) ? partial[0] : null;
}

function printModels(selected, query = "") {
  const normalizedQuery = query.trim().toLowerCase();
  const models = normalizedQuery
    ? MODELS.filter(([id, label]) => `${id} ${label}`.toLowerCase().includes(normalizedQuery))
    : MODELS;
  console.log(`\n${color.cyan("Nexara models")}${normalizedQuery ? color.dim(` · matching “${query.trim()}”`) : ""}`);
  if (!models.length) {
    console.log(color.yellow("  No models matched. Try a provider, family, or model name."));
    return;
  }
  for (const [id, label] of models) {
    const locked = LOCKED_MODELS.has(id);
    const marker = id === selected ? color.green("●") : locked ? color.yellow("🔒") : "○";
    const pricing = MODEL_PRICING.get(id);
    const priceLabel = pricing ? color.dim(` — ${formatComputeRate(pricing.input)}/1M in · ${formatComputeRate(pricing.output)}/1M out`) : "";
    const imageLabel = MODEL_IMAGE_INPUT.has(id) ? color.cyan(" · Vision input") : "";
    console.log(`${marker} ${label} ${color.dim(`(${id})`)}${priceLabel}${imageLabel}${locked ? color.yellow(" — unavailable") : ""}`);
  }
  console.log(color.dim(`\n  ${models.length} model${models.length === 1 ? "" : "s"} · /model <name> to switch · Tab completes commands`));
  console.log();
}

const PROVIDER_LABELS = new Map([
  ["router", "Router"],
  ["openai", "OpenAI"],
  ["moonshotai", "Moonshot AI"],
  ["google", "Google"],
  ["minimax", "MiniMax"],
  ["mistralai", "Mistral AI"],
  ["inclusion-ai", "Inclusion AI"],
  ["stepfun", "StepFun"],
  ["poolside", "Poolside"],
  ["nvidia", "NVIDIA"],
  ["meta", "Meta"],
  ["deepseek", "DeepSeek"],
  ["xiaomi", "Xiaomi"],
  ["x-ai", "xAI"],
  ["qwen", "Qwen"],
  ["stealth", "Stealth"],
  ["z-ai", "Z.ai"],
  ["sensenova", "SenseNova"],
 ]);

// The catalog is maintained in the same broad order as Nexara Web. These
// overrides settle the few cases where a lexical version sort would put a
// smaller/fast model above the provider's flagship.
const MODEL_STRENGTH_OVERRIDES = new Map([
  ["router/autorouter", 1000], ["router/openrouter-free", 900],
  ["openai/gpt-5.6-terra", 1000], ["openai/gpt-5.6-luna", 950], ["openai/gpt-5.3-codex-spark", 900], ["openai/gpt-oss-120b", 850],
  ["google/gemini-3.1-pro", 1000], ["google/gemini-3.6-flash", 960], ["google/gemini-3.5-flash", 940], ["google/gemini-3-flash", 900], ["google/gemini-2.5-pro", 850], ["google/gemini-2.5-flash", 800],
  ["minimax/minimax-m3", 1000], ["minimax/minimax-m2.7", 950], ["minimax/minimax-m2.7-highspeed", 940], ["minimax/minimax-m2.5", 900], ["minimax/minimax-m2.5-highspeed", 890], ["minimax/minimax-m2.1", 850], ["minimax/minimax-m2.1-highspeed", 840], ["minimax/minimax-m2", 800],
  ["mistralai/mistral-large-2512", 1000], ["mistralai/mistral-medium-3.5", 950], ["mistralai/devstral-medium", 925], ["mistralai/codestral-2508", 900], ["mistralai/mistral-small-2603", 850], ["mistralai/ministral-14b", 800], ["mistralai/ministral-8b", 750], ["mistralai/ministral-3b", 700],
  ["nvidia/nemotron-3-ultra", 1000], ["nvidia/nemotron-3-super", 950], ["nvidia/nemotron-3-nano-30b-a3b", 900], ["nvidia/nemotron-3-nano", 880], ["nvidia/nvidia-nemotron-nano-9b-v2", 800], ["nvidia/nemotron-nano-9b-v2", 800], ["nvidia/llama-3.3-nemotron-super-49b", 850],
  ["qwen/qwen3.8-max", 1000], ["qwen/qwen3.7-max", 980], ["qwen/qwen3-max", 960], ["qwen/qwen3-coder-plus", 950], ["qwen/qwen3.7-plus", 930], ["qwen/qwen3.6-plus", 910], ["qwen/qwen3.5-plus", 890], ["qwen/qwen3.6-max-preview", 880], ["qwen/qwen3.5-397b-a17b", 870], ["qwen/qwen3.6-35b-a3b", 840], ["qwen/qwen3.6-27b", 820], ["qwen/qwen3-vl-plus", 800], ["qwen/qwen3.5-omni-plus", 780], ["qwen/qwen3.5-omni-flash", 760], ["qwen/qwen3-omni-flash", 740], ["qwen/qwen3.5-flash", 720], ["qwen/qwen-plus-2025-07-28", 700],
  ["z-ai/glm-5.3", 1000], ["z-ai/glm-5.3-flash", 980], ["z-ai/glm-5.2", 960], ["z-ai/glm-5.1", 940], ["z-ai/glm-5", 920], ["z-ai/glm-5-turbo", 900], ["z-ai/glm-4.7", 850], ["z-ai/glm-4.6", 830], ["z-ai/glm-4.5", 800], ["z-ai/glm-4.5-air", 700],
 ]);

function providerKey(modelId) {
  return String(modelId).split("/")[0] || "other";
}

function providerLabel(modelId) {
  const key = providerKey(modelId);
  return PROVIDER_LABELS.get(key) || key.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function modelStrength(modelId, index) {
  if (MODEL_STRENGTH_OVERRIDES.has(modelId)) return MODEL_STRENGTH_OVERRIDES.get(modelId);
  const id = String(modelId).toLowerCase();
  let score = 500 - index / 100;
  if (id.includes("ultra")) score += 100;
  if (id.includes("pro")) score += 80;
  if (id.includes("max")) score += 75;
  if (id.includes("large")) score += 70;
  if (id.includes("super")) score += 65;
  if (id.includes("plus")) score += 55;
  if (id.includes("coder")) score += 45;
  if (id.includes("flash") || id.includes("highspeed")) score -= 25;
  if (id.includes("nano") || id.includes("mini") || id.includes("air")) score -= 75;
  const billion = id.match(/(\d+)b\b/);
  if (billion) score += Math.min(80, Number(billion[1]) / 2);
  return score;
}

function modelPickerEntries(selected) {
  const grouped = new Map();
  MODELS.forEach(([id, label], index) => {
    const key = providerKey(id);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push({ id, label, index, locked: LOCKED_MODELS.has(id), selected: id === selected });
  });
  const providers = [...grouped.keys()].sort((a, b) => providerLabel(a).localeCompare(providerLabel(b)));
  return providers.flatMap((key) => [
    { type: "provider", key, label: providerLabel(key) },
    ...grouped.get(key).sort((a, b) => modelStrength(b.id, b.index) - modelStrength(a.id, a.index) || a.label.localeCompare(b.label)).map((model) => ({ type: "model", ...model })),
  ]);
}

function pickerTerminalHeight() {
  return Math.max(12, Number(output.rows) || 24);
}

const PERMISSION_OPTIONS = [
  {
    mode: "ask",
    label: "Always ask",
    description: "Ask before every file change, command, or other action.",
  },
  {
    mode: "auto",
    label: "Approve for me",
    description: "Allow safe edits and commands automatically; ask before destructive actions.",
  },
  {
    mode: "sandboxed",
    label: "Sandboxed",
    description: "Full access inside this project, including Bash and local servers; ask outside it.",
  },
  {
    mode: "full",
    label: "Full access",
    description: "Allow file access, edits, and commands everywhere without approval prompts.",
  },
];

async function selectPermissionInteractive(currentMode, cwd = process.cwd()) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    console.log(`Permission mode: ${color.cream(permissionModeLabel(currentMode))}`);
    PERMISSION_OPTIONS.forEach((option, index) => console.log(`  ${index + 1}. ${option.label} — ${option.description}`));
    return null;
  }

  let selected = Math.max(0, PERMISSION_OPTIONS.findIndex((option) => option.mode === currentMode));
  let scrollTop = 0;
  const viewport = Math.max(4, Math.min(8, pickerTerminalHeight() - 10));
  const ensureVisible = () => {
    if (selected < scrollTop) scrollTop = selected;
    if (selected >= scrollTop + viewport) scrollTop = selected - viewport + 1;
  };
  const render = () => {
    ensureVisible();
    // Never demand a wider box than the real terminal has -- a floor here
    // forced lines to physically wrap in a narrower window, and finish()'s
    // cleanup below moves by LOGICAL row count, so those extra wrapped rows
    // desynced it and left part of the box behind on screen after closing.
    const width = terminalWidth();
    const visible = PERMISSION_OPTIONS.slice(scrollTop, scrollTop + viewport);
    // Same reasoning applies to this floor: it must yield to width rather
    // than force the title line longer than the box can actually hold.
    const project = shorten(cwd, Math.max(0, width - 42));
    const title = `Permission mode · project sandbox: ${project}`;
    const hint = "↑/↓ or numpad 8/2 browse · Enter select · Esc cancel";
    const lines = [
      `  ${color.coral("╭")}${color.coral("─".repeat(width - 4))}${color.coral("╮")}`,
      `  ${color.coral("│")} ${color.cream("Select permission mode")} ${color.muted(`· ${title.split(" · ").slice(1).join(" · ")}`)}${" ".repeat(Math.max(0, width - 8 - visibleLength(title)))} ${color.coral("│")}`,
      `  ${color.coral("│")} ${color.muted(hint)}${" ".repeat(Math.max(0, width - 7 - visibleLength(hint)))} ${color.coral("│")}`,
      `  ${color.coral("├")}${color.coral("─".repeat(width - 4))}${color.coral("┤")}`,
    ];
    for (const [offset, option] of visible.entries()) {
      const absoluteIndex = scrollTop + offset;
      const active = absoluteIndex === selected;
      const marker = active ? color.coral("›") : option.mode === currentMode ? color.green("✓") : color.dim("·");
      const label = active ? color.cream(option.label) : color.muted(option.label);
      lines.push(`  ${color.coral("│")}   ${marker} ${label} ${color.dim(`(${option.mode})`)}`);
      const description = active ? color.muted(`     ${option.description}`) : color.dim(`     ${option.description}`);
      lines.push(`  ${color.coral("│")} ${shorten(description, width - 7)}${" ".repeat(Math.max(0, width - 7 - visibleLength(shorten(description, width - 7))))} ${color.coral("│")}`);
    }
    while (lines.length < viewport * 2 + 4) lines.push(`  ${color.coral("│")}${" ".repeat(width - 2)}${color.coral("│")}`);
    const activeOption = PERMISSION_OPTIONS[selected];
    const footer = `Current: ${activeOption.label} · ${scrollTop > 0 ? "↑ more above · " : ""}${scrollTop + viewport < PERMISSION_OPTIONS.length ? "↓ more below" : "ready"}`;
    lines.push(`  ${color.coral("├")}${color.coral("─".repeat(width - 4))}${color.coral("┤")}`);
    lines.push(`  ${color.coral("│")} ${color.muted(footer)}${" ".repeat(Math.max(0, width - 7 - visibleLength(footer)))} ${color.coral("│")}`);
    lines.push(`  ${color.coral("╰")}${color.coral("─".repeat(width - 4))}${color.coral("╯")}`);
    return lines;
  };

  emitKeypressEvents(input);
  const previousRawMode = input.isRaw;
  input.setRawMode(true);
  input.resume();
  suppressRealContentRowCount = true;
  let lines = render();
  // The very first draw can land with the cursor mid-line (e.g. right after
  // the "/model" text the user just typed, or after clearComposerFooter's
  // cursor-restore in fixed-composer mode) -- unlike redraw()/finish() below,
  // which reset every row with an explicit carriage return, this had none,
  // so the box top row got appended after leftover column content instead of
  // starting fresh. On a narrow terminal that pushed the row past its width
  // and wrapped it into an extra physical row lines.length never counted, so
  // finish()'s cursor-up-by-(lines.length-1) stopped one row short of the
  // real top and left a fragment (often just the top border) on screen after
  // the picker closed. Forcing a carriage return before every row guarantees
  // each one starts at column 0, exactly like the redraw/cleanup paths below.
  output.write(`\u001b[?25l\r${lines.join("\n\r")}`);

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value, error = null) => {
      if (settled) return;
      settled = true;
      input.removeListener("keypress", onKeypress);
      input.setRawMode(Boolean(previousRawMode));
      output.write(`\u001b[${lines.length - 1}A${lines.map(() => "\u001b[2K\r").join("\n")}\u001b[2K\u001b[${lines.length - 1}A\u001b[?25h`);
      suppressRealContentRowCount = false;
      if (error) reject(error);
      else resolve(value);
    };
    const redraw = () => {
      output.write(`\u001b[${lines.length - 1}A`);
      lines = render();
      output.write(lines.map((line) => `\u001b[2K\r${line}`).join("\n"));
    };
    const move = (delta) => {
      selected = Math.max(0, Math.min(PERMISSION_OPTIONS.length - 1, selected + delta));
      redraw();
    };
    const onKeypress = (str, key = {}) => {
      const name = String(key.name || "").toLowerCase();
      const sequence = key.sequence || str || "";
      const action = navigationAction(str, key, { allowNumpadDigits: true });
      if (key.ctrl && name === "c") { finish(null, new Error("Aborted with Ctrl+C")); return; }
      if (isEscapeKey(str, key)) { finish(null); return; }
      if (action === "up") { move(-1); return; }
      if (action === "down") { move(1); return; }
      if (action === "pageup") { move(-viewport); return; }
      if (action === "pagedown") { move(viewport); return; }
      if (action === "home") { selected = 0; redraw(); return; }
      if (action === "end") { selected = PERMISSION_OPTIONS.length - 1; redraw(); return; }
      if (name === "return" || name === "enter" || sequence === "\r" || sequence === "\n") {
        finish(PERMISSION_OPTIONS[selected].mode);
      }
    };
    input.on("keypress", onKeypress);
  });
}

async function selectModelInteractive(selected) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    printModels(selected);
    return null;
  }

  const entries = modelPickerEntries(selected);
  const allModelCount = entries.filter((entry) => entry.type === "model").length;
  const modelIndices = entries.map((entry, index) => entry.type === "model" && !entry.locked ? index : -1).filter((index) => index >= 0);
  let activeModel = Math.max(0, modelIndices.findIndex((index) => entries[index].id === selected));
  let scrollTop = 0;
  const viewport = Math.max(6, Math.min(18, pickerTerminalHeight() - 10));
  const selectedModelIndex = () => modelIndices[Math.max(0, Math.min(modelIndices.length - 1, activeModel))];
  const ensureVisible = () => {
    const index = selectedModelIndex();
    if (index < scrollTop) scrollTop = index;
    if (index >= scrollTop + viewport) scrollTop = index - viewport + 1;
  };
  const render = () => {
    ensureVisible();
    // Never demand a wider box than the real terminal has -- a floor here
    // forced lines to physically wrap in a narrower window, and finish()'s
    // cleanup below moves by LOGICAL row count, so those extra wrapped rows
    // desynced it and left part of the box (its top, since the cleanup then
    // moves up too few rows from the bottom) behind on screen after closing.
    // This is the exact "leftover model catalog" artifact.
    const width = terminalWidth();
    const visible = entries.slice(scrollTop, scrollTop + viewport);
    const lines = [
      `  ${color.coral("╭")}${color.coral("─".repeat(width - 4))}${color.coral("╮")}`,
      `  ${color.coral("│")} ${color.cream("Select model")} ${color.muted(`· ${allModelCount} models · providers A–Z`)}${" ".repeat(Math.max(0, width - 8 - visibleLength(`Select model · ${allModelCount} models · providers A–Z`)))} ${color.coral("│")}`,
      `  ${color.coral("│")} ${color.muted("↑/↓ or numpad 8/2 browse · PgUp/PgDn jump · Enter default · s session-only · Esc cancel")}${" ".repeat(Math.max(0, width - 5 - visibleLength("↑/↓ or numpad 8/2 browse · PgUp/PgDn jump · Enter default · s session-only · Esc cancel")))} ${color.coral("│")}`,
      `  ${color.coral("├")}${color.coral("─".repeat(width - 4))}${color.coral("┤")}`,
    ];
    for (const [offset, entry] of visible.entries()) {
      const absoluteIndex = scrollTop + offset;
      let content;
      if (entry.type === "provider") {
        content = `  ${color.coral("◆")} ${color.cream(entry.label)}`;
      } else {
        const active = absoluteIndex === selectedModelIndex();
        const marker = entry.locked ? color.amber("🔒") : active ? color.coral("›") : entry.selected ? color.green("✓") : color.dim("·");
        const pricing = MODEL_PRICING.get(entry.id);
        const price = pricing ? ` · ${formatComputeRate(pricing.input)} in · ${formatComputeRate(pricing.output)} out per 1M` : "";
        const vision = MODEL_IMAGE_INPUT.has(entry.id) ? " · vision" : "";
        const unavailable = entry.locked ? " · unavailable" : "";
        content = `  ${marker} ${active ? color.cream(entry.label) : entry.locked ? color.amber(entry.label) : color.muted(entry.label)} ${color.dim(`(${entry.id})`)}${color.dim(`${price}${vision}${unavailable}`)}`;
      }
      const fitted = shorten(content, width - 7);
      lines.push(`  ${color.coral("│")} ${fitted}${" ".repeat(Math.max(0, width - 7 - visibleLength(fitted)))} ${color.coral("│")}`);
    }
    while (lines.length < viewport + 4) lines.push(`  ${color.coral("│")}${" ".repeat(width - 2)}${color.coral("│")}`);
    const topHint = scrollTop > 0 ? "↑ more above" : "top";
    const bottomHint = scrollTop + viewport < entries.length ? "↓ more below" : "bottom";
    lines.push(`  ${color.coral("├")}${color.coral("─".repeat(width - 4))}${color.coral("┤")}`);
    lines.push(`  ${color.coral("│")} ${color.muted(`${topHint} · ${bottomHint} · ${providerLabel(entries[selectedModelIndex()].id)} · ${entries[selectedModelIndex()].label}`)}${" ".repeat(Math.max(0, width - 7 - visibleLength(`${topHint} · ${bottomHint} · ${providerLabel(entries[selectedModelIndex()].id)} · ${entries[selectedModelIndex()].label}`)))} ${color.coral("│")}`);
    lines.push(`  ${color.coral("╰")}${color.coral("─".repeat(width - 4))}${color.coral("╯")}`);
    return lines;
  };

  emitKeypressEvents(input);
  const previousRawMode = input.isRaw;
  input.setRawMode(true);
  input.resume();
  suppressRealContentRowCount = true;
  let lines = render();
  // The very first draw can land with the cursor mid-line (e.g. right after
  // the "/model" text the user just typed, or after clearComposerFooter's
  // cursor-restore in fixed-composer mode) -- unlike redraw()/finish() below,
  // which reset every row with an explicit carriage return, this had none,
  // so the box top row got appended after leftover column content instead of
  // starting fresh. On a narrow terminal that pushed the row past its width
  // and wrapped it into an extra physical row lines.length never counted, so
  // finish()'s cursor-up-by-(lines.length-1) stopped one row short of the
  // real top and left a fragment (often just the top border) on screen after
  // the picker closed. Forcing a carriage return before every row guarantees
  // each one starts at column 0, exactly like the redraw/cleanup paths below.
  output.write(`\u001b[?25l\r${lines.join("\n\r")}`);

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value, error = null) => {
      if (settled) return;
      settled = true;
      input.removeListener("keypress", onKeypress);
      input.setRawMode(Boolean(previousRawMode));
      output.write(`\u001b[${lines.length - 1}A${lines.map(() => "\u001b[2K\r").join("\n")}\u001b[2K\u001b[${lines.length - 1}A\u001b[?25h`);
      suppressRealContentRowCount = false;
      if (error) reject(error);
      else resolve(value);
    };
    const redraw = () => {
      output.write(`\u001b[${lines.length - 1}A`);
      lines = render();
      output.write(lines.map((line) => `\u001b[2K\r${line}`).join("\n"));
    };
    const move = (delta) => {
      activeModel = Math.max(0, Math.min(modelIndices.length - 1, activeModel + delta));
      redraw();
    };
    const onKeypress = (str, key = {}) => {
      const name = String(key.name || "").toLowerCase();
      const sequence = key.sequence || str || "";
      const action = navigationAction(str, key, { allowNumpadDigits: true });
      if (key.ctrl && name === "c") { finish(null, new Error("Aborted with Ctrl+C")); return; }
      if (isEscapeKey(str, key)) { finish(null); return; }
      if (action === "up") { move(-1); return; }
      if (action === "down") { move(1); return; }
      if (action === "pageup") { move(-viewport); return; }
      if (action === "pagedown") { move(viewport); return; }
      if (action === "home") { activeModel = 0; redraw(); return; }
      if (action === "end") { activeModel = modelIndices.length - 1; redraw(); return; }
      if (name === "return" || name === "enter" || sequence === "\r" || sequence === "\n") {
        finish({ model: entries[selectedModelIndex()].id, sessionOnly: false });
        return;
      }
      if (name === "s" || str === "s" || str === "S") {
        finish({ model: entries[selectedModelIndex()].id, sessionOnly: true });
      }
    };
    input.on("keypress", onKeypress);
  });
}

function slashCompleter(line) {
  if (!line.startsWith("/")) return [[], line];
  const matches = SLASH_COMMANDS.filter((command) => command.startsWith(line.toLowerCase()));
  return [matches.length ? matches : SLASH_COMMANDS, line];
}

function slashSuggestionMatches(line) {
  const value = String(line || "");
  if (!/^\/[^\s]*$/.test(value)) return [];
  const query = value.toLowerCase();
  return SLASH_COMMANDS
    .filter((command) => command.startsWith(query))
    .map((command) => ({ command, description: SLASH_COMMAND_DESCRIPTIONS.get(command) || "Run a Nexara command." }));
}

function renderSlashSuggestions(line, activeIndex = -1) {
  const matches = slashSuggestionMatches(line);
  if (!matches.length) return [];
  const limit = Math.max(3, Math.min(5, pickerTerminalHeight() - 14));
  const bounded = activeIndex < 0 ? -1 : Math.max(0, Math.min(matches.length - 1, activeIndex));
  const start = bounded < 0 ? 0 : Math.max(0, Math.min(bounded - limit + 1, matches.length - limit));
  const visible = matches.slice(start, start + limit);
  const commandWidth = 22;
  const rows = visible.map((entry, offset) => {
    const active = bounded >= 0 && start + offset === bounded;
    const command = entry.command.padEnd(commandWidth, " ");
    const commandText = active ? color.coral(command) : color.muted(command);
    const description = active ? color.cream(entry.description) : color.muted(entry.description);
    return `  ${commandText} ${description}`;
  });
  if (matches.length > limit) {
    rows.push(color.dim(`  ${start > 0 ? "↑ " : ""}${matches.length} matches · Tab to fill · Enter to run${start + limit < matches.length ? " ↓" : ""}`));
  }
  return rows;
}

function printHelp() {
  console.log(`
${color.cyan("Nexara CLI commands")}
  ${color.muted("Chat & models")}
  /help                         Show this help
  /model [name|id]              List or switch models
  /effort [level]               Set GPT-5.6 reasoning effort (low/medium/high/xhigh=Extra High/max)
  /models                       List every available model
  /attach <path>                Attach an image, PDF, or text/code file
  /image <path>                 Alias for /attach (images, PDFs, text files)
  /image clear                  Clear pending file attachments
  /think <prompt>               Use deep-thinking mode
  /research <prompt>            Use deep research mode
  /perplexity <prompt>          Search-first cited mode
  /plan <prompt>                Plan & validate a project (searches feasibility, profitability, risks)
  /honest <prompt>              Ask for a direct honest answer
  /goal <goal>                  Work autonomously toward a goal
  ${color.muted("Conversations")}
  /new                          Start a fresh saved conversation
  /resume [thread-id]           Resume a local conversation (or remote fallback)
  /threads                      List conversations saved on this computer
  /clear                        Clear local context and create a fresh thread
  /compact                      Summarize the conversation to free the context window
  ${color.muted("Workspace & automation")}
  /permission [mode]            Choose Always ask, Approve for me, Sandboxed, or Full access
  /permissions [mode]           Alias for /permission
  /tools                        Show the tools available to this CLI session
  /mcp                          Show local MCP configuration and connected server hints
  /skills                       Show workspace skills available to the CLI
  /plugins                      Show workspace plugins available to the CLI
  /agents                       Show local background agents/processes
  /background                   Show background commands
  /tasks                       Show task activity and background processes
  /logs <id>                    Show output from a background command
  /stop <id>                    Stop a background command
  /download                    Show artifacts saved in .nexara-artifacts
  /open <path>                  Open a local file with the system app
  /reveal <path>                Reveal a file in Explorer/Finder
  /doctor                       Diagnose CLI, workspace, account, and API setup
  /config                       Show config and local session paths
  ${color.muted("Account & exit")}
  /update                       Check for and install updates (when auto-update is off)
  /status                       Show account, model, and thread state
  /login                        Sign in again or switch account
  /quit                         Exit the CLI

${color.dim("Thinking: click the live Thinking indicator to expand the model's emitted reasoning.")}
${color.dim("Tip: type / and press Tab to autocomplete; use ↑/↓ or numpad arrows to browse.")}
${color.dim("Pipes: set NO_COLOR=1 for plain output, or use --output-format json|stream-json for automation.")}

${color.dim("Login options: nexara login, nexara login --google, nexara login --qr")}
${color.dim("Updates: nexara update (install now), nexara update --on / --off (toggle silent background updates)")}
${color.dim("Outside the REPL: nexara \"prompt\", --print, --output-format json|stream-json, --max-turns N, --max-budget COMPUTE")}
${color.dim("Automation flags: --allowed-tools A,B · --disallowed-tools A,B · --permission-mode ask|auto|sandboxed|full · --no-session-persistence")}
`);
}

function printAvailableTools() {
  console.log(`\n${color.coral("Nexara local tools")}`);
  console.log(color.muted("  Read-only"));
  console.log(`  ${["List", "Read", "Search", "Glob", "GitStatus", "GitLog", "GitDiff", "GitBranch", "GitBlame", "GitShow", "CurrentTime", "GetSystemInfo", "GetEnv", "GetFileInfo", "Diff", "WebFetch", "ListProcesses"].join(" · ")}`);
  console.log(color.muted("  Code intelligence"));
  console.log(`  ${["SymbolSearch", "FindReferences", "LocateDefinition", "CodeOutline", "ImportGraph", "ModuleExports", "DependencyTree", "DeadCodeScan", "TypeCheck", "LspDiagnostics"].join(" · ")}`);
  console.log(color.muted("  Workspace and terminal"));
  console.log(`  ${["Write", "Edit", "ApplyDiff", "RenameSymbol", "ScaffoldFile", "Bash", "RunInBackground", "BackgroundOutput", "StopBackground", "CheckPort", "Delete", "Mkdir", "Copy", "Move"].join(" · ")}`);
  console.log(color.muted("  Git, files, and delivery"));
  console.log(`  ${["GitCheckout", "GitCommit", "GitStash", "KillProcess", "Zip", "Unzip", "OpenFile", "RevealInExplorer", "OpenExternal", "TodoWrite"].join(" · ")}`);
  console.log(color.muted("  Delegation and integrations"));
  console.log(`  ${["SpawnAgent", "CheckSubagent", "StopSubagent", "ListSubagents", "McpList", "SkillList", "PluginList"].join(" · ")}`);
  console.log(color.muted("  Server tools"));
  console.log("  web_search · ask_question · create_pdf · create_image · edit_image");
  console.log(color.dim("\n  Mutating tools are approval-gated. Use /mcp, /skills, /plugins, and /agents to inspect the local automation surface.\n"));
}

async function printWorkspaceAutomation(kind, cwd) {
  const title = kind === "mcp" ? "MCP servers" : kind === "skills" ? "Workspace skills" : "Workspace plugins";
  const candidates = kind === "mcp"
    ? [".mcp.json", ".nexara/mcp.json", ".claude/mcp.json"]
    : kind === "skills"
      ? [".nexara/skills", ".claude/skills", ".codex/skills"]
      : [".nexara/plugins", ".claude/plugins", ".codex/plugins"];
  const found = [];
  for (const candidate of candidates) {
    const fullPath = path.join(cwd, candidate);
    const stat = await fs.stat(fullPath).catch(() => null);
    if (!stat) continue;
    if (stat.isDirectory()) {
      const entries = await fs.readdir(fullPath, { withFileTypes: true }).catch(() => []);
      found.push(`${candidate}  (${entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).join(", ") || "empty"})`);
    } else found.push(candidate);
  }
  console.log(`\n${color.coral(title)}`);
  if (!found.length) {
    console.log(color.dim(`  No workspace ${kind} manifests found in ${displayPath(cwd)}.`));
    if (kind === "mcp") console.log(color.dim("  Account-connected MCP tools, when enabled on Nexara, are attached server-side."));
  } else found.forEach((entry) => console.log(`  ${color.teal("✓")} ${entry}`));
  console.log();
}

function parseArgs(argv) {
  const options = {
    prompt: [], images: [], print: false, continue: false, google: false, qr: false,
    help: false, version: false, updateMode: null, outputFormat: "text", maxTurns: null,
    maxBudget: null, allowedTools: [], disallowedTools: [], permissionMode: null,
    noSessionPersistence: false,
  };
  // Subcommand flags for `nexara update`: toggle silent auto-updates or show
  // the install's update state. Kept out of the chat prompt path.
  if (argv[0] === "update") {
    if (argv[1] === "--on" || argv[1] === "--off" || argv[1] === "--status") {
      options.updateMode = argv[1].slice(2);
      argv = argv.filter((_, index) => index !== 1);
    }
  }
  const requiredValue = (index, flag, description) => {
    const value = argv[index + 1];
    if (!value || value.startsWith("-")) throw new Error(`${flag} requires ${description}.`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--version" || arg === "-v") options.version = true;
    else if (arg === "--print" || arg === "-p") options.print = true;
    else if (arg === "--continue" || arg === "-c") options.continue = true;
    else if (arg === "--google") options.google = true;
    else if (arg === "--qr") options.qr = true;
    else if (arg === "--model" || arg === "-m") {
      options.model = requiredValue(i, arg, "a model name or id");
      i += 1;
    } else if (arg === "--effort") {
      options.reasoningEffort = normalizeReasoningEffort(requiredValue(i, arg, "low, medium, high, xhigh (Extra High), or max"));
      if (!REASONING_EFFORTS.has(options.reasoningEffort)) throw new Error("--effort must be low, medium, high, xhigh (Extra High), or max.");
      i += 1;
    } else if (arg === "--output-format") {
      options.outputFormat = requiredValue(i, arg, "text, json, or stream-json").toLowerCase();
      if (!["text", "json", "stream-json"].includes(options.outputFormat)) throw new Error("--output-format must be text, json, or stream-json.");
      i += 1;
    } else if (arg === "--max-turns") {
      options.maxTurns = Number(requiredValue(i, arg, "a positive number"));
      if (!Number.isInteger(options.maxTurns) || options.maxTurns < 1) throw new Error("--max-turns must be a positive whole number.");
      i += 1;
    } else if (arg === "--max-budget") {
      options.maxBudget = Number(requiredValue(i, arg, "a Compute-unit amount"));
      if (!Number.isFinite(options.maxBudget) || options.maxBudget <= 0) throw new Error("--max-budget must be greater than zero.");
      i += 1;
    } else if (arg === "--allowed-tools") {
      options.allowedTools = requiredValue(i, arg, "a comma-separated tool list").split(",").map((value) => value.trim()).filter(Boolean);
      i += 1;
    } else if (arg === "--disallowed-tools") {
      options.disallowedTools = requiredValue(i, arg, "a comma-separated tool list").split(",").map((value) => value.trim()).filter(Boolean);
      i += 1;
    } else if (arg === "--permission-mode") {
      options.permissionMode = requiredValue(i, arg, "ask, auto, sandboxed, or full").toLowerCase();
      if (!["ask", "read-only", "plan", "allow-edits", "allow-commands", "auto", "sandboxed", "full"].includes(options.permissionMode)) throw new Error("Unknown permission mode.");
      i += 1;
    } else if (arg === "--no-session-persistence") {
      options.noSessionPersistence = true;
    } else if (arg === "--image" || arg === "-i") {
      options.images.push(requiredValue(i, arg, "an image path"));
      i += 1;
    } else if (arg === "--app-url") {
      options.appUrl = requiredValue(i, arg, "a URL");
      i += 1;
    } else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}. Run nexara --help.`);
    else options.prompt.push(arg);
  }
  return options;
}

async function readImage(filePath) {
  return readAttachment(filePath);
}

/** Reads an image, PDF, or text/code file into a sendable attachment. */
async function readAttachment(filePath) {
  // Strip surrounding quotes so /attach "C:\my file.png" works — the slash
  // handler splits on whitespace and keeps the quote characters verbatim.
  const unquoted = filePath.replace(/^"(.*)"$/s, "$1").replace(/^'(.*)'$/s, "$1");
  const resolved = path.resolve(unquoted);
  const extension = path.extname(resolved).toLowerCase();
  let mediaType = IMAGE_TYPES.get(extension);
  if (extension === ".pdf") mediaType = "application/pdf";
  else if (TEXT_EXTENSIONS.has(extension.slice(1))) mediaType = "text/plain";
  if (!mediaType) {
    throw new Error(
      `Unsupported file type: ${extension || "unknown"}. Use an image (PNG/JPEG/GIF/WebP), a PDF, or a text/code file.`,
    );
  }
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) throw new Error(`${filePath} is not a file.`);
  const maxBytes = mediaType.startsWith("image/") ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
  if (stat.size > maxBytes) {
    throw new Error(`${filePath} is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`);
  }
  const data = await fs.readFile(resolved);
  return { filename: path.basename(resolved), mediaType, bytes: stat.size, dataUrl: `data:${mediaType};base64,${data.toString("base64")}` };
}

function checkAttachmentBudget(files) {
  if (files.length > MAX_ATTACHMENTS) {
    throw new Error(`Too many attachments (${files.length}). Send at most ${MAX_ATTACHMENTS} per message.`);
  }
  const totalBytes = files.reduce((sum, file) => sum + (file.bytes || 0), 0);
  if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
    throw new Error(`Attachments total ${Math.round(totalBytes / 1024 / 1024)} MB, over the ${Math.round(MAX_TOTAL_ATTACHMENT_BYTES / 1024 / 1024)} MB combined limit per message. Remove one or send them in separate messages.`);
  }
  const encodedBytes = Math.ceil(totalBytes * 4 / 3);
  if (encodedBytes > 16 * 1024 * 1024) {
    throw new Error("Attachments exceed the encoded request limit. Remove an attachment or send them in separate messages.");
  }
}

async function requireLogin(auth, config) {
  const token = await auth.accessToken();
  if (!token) {
    throw new Error("Sign in first with `nexara login`. Your CLI uses the same Nexara account and shared limits as the website.");
  }
  return config;
}

async function login(config, auth, useGoogle = false, useQr = false) {
  if (!useGoogle && !useQr) {
    printLoginScreen();
    const methodRl = readline.createInterface({ input, output });
    let selectedGoogle = false;
    let selectedQr = false;
    try {
      const method = (await methodRl.question(`  ${color.cyan("How would you like to sign in?")} ${color.dim("[1] Google  [2] QR")}\n  › `)).trim().toLowerCase();
      selectedGoogle = method === "1" || method === "g" || method === "google";
      selectedQr = method === "2" || method === "q" || method === "qr";
    } finally {
      methodRl.close();
    }
    if (selectedGoogle) return login(config, auth, true, false);
    if (selectedQr) return login(config, auth, false, true);
  }
  if (useQr) {
    const user = await auth.loginWithQr(config.appUrl, (status) => {
      if (status.type === "code") {
        console.log("Scan this QR code with a phone already signed in to Nexara:");
        printQr(status.url);
      } else {
        diagnostic("Waiting for phone approval…");
      }
    });
    console.log(color.green(`Signed in as ${user.email || "your Nexara account"}.`));
    return;
  }
  if (useGoogle) {
    const user = await auth.loginWithGoogle();
    console.log(color.green(`Signed in as ${user.email || "your Google account"}.`));
    return;
  }
  throw new Error("Choose Google or QR sign-in. Email/password sign-in is not available in Nexara CLI.");
}

async function ensureSignedIn(config, auth, useGoogle = false, useQr = false) {
  // A cached access token can still be present after the Supabase session has
  // been revoked or expired. Checking only for a token let the interactive
  // composer start with an unusable session; the first prompt then stalled in
  // thread creation and every later prompt was queued behind it. Validate the
  // user before entering the chat UI so stale sessions go through sign-in.
  if (await auth.accessToken() && await auth.user()) return;
  console.log(color.cyan("You are not signed in. Sign in to Nexara to continue."));
  await login(config, auth, useGoogle, useQr);
}

function currentAccountId(config) {
  return config?.session?.user?.id || config?.session?.user?.email || null;
}

async function persistLocalSession(state, messages = state.messages) {
  if (state.config.noSessionPersistence || !state.threadId) return null;
  return saveLocalSession({
    threadId: state.threadId,
    title: state.sessionTitle || "New chat",
    cwd: state.cwd,
    model: state.config.selectedModel,
    reasoningEffort: state.config.selectedReasoningEffort,
    createdAt: state.sessionCreatedAt,
    accountId: currentAccountId(state.config),
    messages,
  }).catch(() => null);
}

async function ensureThread(state, title = "New chat") {
  if (state.threadId) return;
  const thread = await createThread(state.auth, title);
  state.threadId = thread.id;
  state.sessionTitle = thread.title || title;
  state.sessionCreatedAt = thread.created_at || new Date().toISOString();
  state.messages = [];
  if (!state.config.noSessionPersistence) state.config = { ...state.config, ...saveConfig({ lastThreadId: thread.id }) };
}

async function loadSavedThread(auth, threadId, accountId = null) {
  const local = await loadLocalSession(threadId, accountId);
  if (local) {
    return {
      local: true,
      thread: {
        id: local.threadId,
        title: local.title || "New chat",
        updated_at: local.updatedAt,
      },
      messages: local.messages,
      cwd: local.cwd,
      model: local.model,
      reasoningEffort: local.reasoningEffort,
      createdAt: local.createdAt,
    };
  }
  const remote = await loadThread(auth, threadId);
  return { local: false, ...remote };
}

export function usageCompute(model, usage) {
  if (!usage || typeof usage !== "object") return null;
  // Prefer the server's billed amount whenever it is present. Client-side
  // price tables are only a fallback because they can lag the gateway.
  for (const key of ["compute", "computeUnits", "billedCompute", "creditUnits"]) {
    const billed = Number(usage[key]);
    if (Number.isFinite(billed) && billed >= 0) return billed;
  }
  const pricing = MODEL_PRICING.get(model);
  if (!pricing) return null;
  const providerCost = ((Number(usage.inputTokens) || 0) * pricing.input + (Number(usage.outputTokens) || 0) * pricing.output) / 1_000_000;
  return Math.max(0, Math.round(providerCost * COMPUTE_PER_DOLLAR));
}

function compactLocalMessages(messages) {
  const rows = Array.isArray(messages) ? messages : [];
  if (rows.length <= 12) return rows;
  const summary = rows.slice(0, -12).map((message) => {
    const text = messageText(message).replace(/\s+/g, " ").trim();
    return `${message?.role || "message"}: ${text || "(non-text content)"}`;
  }).join("\n").slice(0, 24_000);
  return [
    { id: `local-summary-${Date.now()}`, role: "user", parts: [{ type: "text", text: `Local conversation summary (earlier messages):\n\n${summary}` }] },
    ...rows.slice(-12),
  ];
}

async function retryChatRequest(request, { onRetry, maxAttempts = 3 } = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      if (!isRetryableGenerationError(error) || attempt >= maxAttempts) throw error;
      await onRetry?.(error, attempt, maxAttempts);
      await new Promise((resolve) => setTimeout(resolve, Math.min(1500, 350 * attempt)));
    }
  }
  return null;
}

async function runPrompt(state, text, { mode, goal, files = [], onStart, alreadyRendered = false } = {}) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  state.cwd ||= process.cwd();
  state.spentCompute ||= 0;
  state.maxTurns ||= state.config.maxTurns || 100;
  state.maxBudget ??= state.config.maxBudget;
  const message = userMessage(trimmed, files);
  const machine = state.outputFormat === "stream-json";
  // `--print` is a non-interactive text mode, not a silent mode. Keep the
  // transcript chrome suppressed by oneShot, but always render the final
  // assistant text so piping `nexara --print ...` is useful.
  const quiet = Boolean((state.quiet && !state.printText) || state.outputFormat === "json" || machine);
  if (!quiet && !alreadyRendered && !state.printText) {
    // Commit the user message before any network/thread setup. This keeps the
    // submitted prompt visible even when auth, thread creation, or the model
    // takes a moment, and prevents the composer redraw from hiding it.
    state.clearComposer?.();
    const userRows = userTurnRows(trimmed, files);
    state.prepareTranscript?.(userRows);
    printUserTurn(trimmed, files);
    printAssistantHeader(state, mode);
    // Keep the control rail visible while the model works. The prompt remains
    // usable, so a second line can be queued without disturbing the stream.
    state.mountComposer?.();
  }
  // Muted (not blocked) for the rest of this turn's work: the transcript is
  // about to move the real cursor around with absolute addressing while
  // streaming/printing, which the composer's own relative-cursor render()
  // cannot account for -- a keystroke landing mid-print used stale math and
  // corrupted the transcript. Typing is still accepted and queued as normal
  // (see pendingMessages); only the composer's own redraw is silenced until
  // this turn's work is done, at which point one real render() catches it up.
  state.muteComposerRedraw?.();
  try {
  // Thread/auth setup happens before the stream activity line exists. Keep
  // the fixed footer honest during that phase; otherwise a slow or failed
  // session request looks like a dead composer after the user submits.
  setComposerActivity(state, "connecting");
  try {
    await ensureThread(state, trimmed.replace(/\s+/g, " "));
  } catch (error) {
    setComposerActivity(state, null);
    throw error;
  }
  setComposerActivity(state, null);
  const conversation = [...state.messages, message];
  // Alias state.messages to this same array now, not just on a clean finish.
  // Every push onto `conversation` for the rest of this turn (assistant
  // replies, tool results) updates state.messages too, so a cancellation,
  // stream failure, or budget/turn-limit stop no longer drops the user's
  // just-sent message (and anything that happened before the stop) from the
  // live in-memory conversation the NEXT prompt in this session builds on --
  // only the on-disk copy used to get that far via persistLocalSession below.
  state.messages = conversation;
  await persistLocalSession(state, conversation);
  // 25 (the old default) is easily exhausted by a real multi-step task --
  // each file read/write/delete is its own turn, so a from-scratch rebuild
  // can need well over a hundred. Raised the default and the ceiling so a
  // big task doesn't need manual intervention partway through.
  const maxTurns = Math.max(1, Math.min(300, Number(state.maxTurns ?? state.config.maxTurns ?? 100)));
  let lastAssistant = null;
  let emptyContinuationRetries = 0;
  let reconnectText = "";
  for (let turn = 1; turn <= maxTurns; turn += 1) {
    if (state.maxBudget && state.spentCompute >= state.maxBudget) {
      const messageText = `Stopped before another model turn because the ${state.maxBudget.toLocaleString()} Compute-unit session budget was reached.`;
      if (!quiet) composerNotice(state, messageText, "amber");
      outputToolEvent(state, { type: "budget-stop", message: messageText });
      break;
    }
    const turnStartedAt = Date.now();
    reconnectText = "";
    const activity = createActivityLine({
      quiet,
      streamJson: machine,
      // This spinner redraws on a 120ms timer, independent of readline and of
      // every other place that touches the screen (tool-call prints, box
      // remounts). Turning it on for interactive sessions raced against
      // readline's own cursor tracking -- if a redraw landed between some
      // other handler's clear and remount, the real terminal cursor and
      // readline's internal model of where it is desynced, and typing while
      // the AI was working landed wherever that left it instead of the input
      // box. Suppressed here again; the box's status line still updates from
      // the existing event-driven redraws (tool calls, etc.), just without a
      // live spinner glyph between them.
      stableComposer: Boolean(state.interactive),
      getCursorOffset: () => state.composerFooterLines ? state.composerFooterLines + 1 : 0,
      getCursorCol: () => state.getCursorCol ? state.getCursorCol() : 0,
      transcript: quiet ? null : {
        begin: () => Boolean(state.beginTranscriptActivity?.()),
        paint: (line) => Boolean(state.paintTranscriptActivity?.(line)),
        end: () => state.endTranscriptActivity?.(),
      },
      // Always show a live tail of the actual reasoning instead of a static
      // "(click to expand)" placeholder -- the activity line already redraws
      // on its own 120ms timer, so this alone makes thinking visible as it
      // happens with no key/click required.
      getThinkingPreview: () => state.thinkingText,
      // Same live-tail treatment for the response text itself once it starts
      // streaming (see writingPreviewLine) -- state.streamedText is kept in
      // sync by writeText below.
      getWritingPreview: () => state.streamedText,
    });
    state.thinkingText = "";
    state.thinkingExpanded = false;
    state.streamedText = "";
    let thinkingRendered = false;
    const toggleThinking = () => {
      if (!state.thinkingText && !state.thinkingExpanded) {
        notice("Thinking is not available for this model or has not started yet.", "amber");
        return;
      }
      state.thinkingExpanded = !state.thinkingExpanded;
      state.clearComposer?.();
      activity.clear();
      if (state.thinkingExpanded) {
        state.prepareTranscript?.(String(state.thinkingText || "").split(/\r?\n/).length + 2);
        console.log(`  ${color.cream("▾ Thinking")}`);
        const reasoning = stripInlineMarkdownEmphasis(String(state.thinkingText || "(waiting for reasoning…)"));
        process.stdout.write(`${reasoning.split(/\r?\n/).map((line) => `    ${color.italicMuted(line)}`).join("\n")}\n`);
        thinkingRendered = true;
      } else {
        notice("Thinking collapsed.");
      }
      state.mountComposer?.();
      if (!state.thinkingExpanded) activity.render();
    };
    state.toggleThinking = toggleThinking;
    state.setThinkingMouse?.(true);
    const stopComposerAnimation = startComposerActivityAnimation(state);
    onStart?.();
    const serverArtifacts = [];
    // A stream reconnect (see onRetry below) resends the conversation and
    // can replay tool-result events for calls the model already got a
    // result for on the previous, dropped attempt -- without this, the same
    // artifact (e.g. a generated image/PDF) could be saved to disk twice.
    const seenServerArtifactKeys = new Set();
    const controller = new AbortController();
    const previousCancel = state.cancelCurrent;
    const cancel = () => controller.abort();
    state.cancelCurrent = cancel;
    let streamedText = "";
    let responseStarted = false;
    let responseStreamRendered = false;
    const writeText = (delta) => {
      // Mirrors api.js's own cap on state.text -- streamedText (not
      // assistant.text) is what actually becomes the saved/rendered answer
      // after a reconnect (see responseText below), so it needs the same
      // bound or capping state.text alone would do nothing.
      if (streamedText.length < MAX_ACCUMULATED_TEXT_BYTES) streamedText += delta;
      state.streamedText = streamedText;
      if (machine) outputToolEvent(state, { type: "text-delta", delta });
      else if (state.outputFormat !== "json") {
        if (!responseStarted) {
          responseStarted = true;
          activity.set("writing");
          setComposerActivity(state, "writing");
        }
        if (state.interactive) {
          // Keep streamed deltas in memory until the response is complete.
          // Printing raw chunks bypasses markdown formatting and corrupts the
          // fixed composer/transcript cursor when chunks soft-wrap.
        }
      }
    };
    let assistant;
    try {
      assistant = await retryChatRequest(() => sendChat({
        auth: state.auth,
        appUrl: state.config.appUrl,
        threadId: state.threadId,
        cwd: state.cwd,
        messages: conversation,
        model: state.config.selectedModel,
        reasoningEffort: state.config.selectedReasoningEffort,
        mode,
        goal,
        continueFrom: reconnectText || undefined,
        quiet,
        signal: controller.signal,
        onStatus: (status) => {
          activity.set(status);
          setComposerActivity(state, status);
        },
        onText: writeText,
        onReasoning: (delta) => {
          if (state.thinkingText.length < MAX_ACCUMULATED_TEXT_BYTES) state.thinkingText += delta;
          setComposerActivity(state, "thinking");
          // Buffer reasoning while it streams. Repainting the transcript and
          // fixed composer for every token caused visible flicker and cursor
          // loss; the completed block is rendered once on expand/finalize.
        },
        onToolCall: (call) => {
          activity.clear();
          setComposerActivity(state, null);
          state.clearComposer?.();
          printToolCall(call, { cwd: state.cwd, streamJson: machine, state });
          (state.scheduleMountComposer || state.mountComposer)?.();
          outputToolEvent(state, { type: "tool-call", name: call.name, input: call.arguments, toolCallId: call.toolCallId });
        },
        onToolResult: (result) => {
          activity.clear();
          setComposerActivity(state, null);
          const artifactKey = result.toolCallId || `${result.name}:${typeof result.output === "string" ? result.output : JSON.stringify(result.output)}`;
          if (seenServerArtifactKeys.has(artifactKey)) return;
          seenServerArtifactKeys.add(artifactKey);
          serverArtifacts.push(result);
          state.clearComposer?.();
          if (!quiet && result.name !== "create_pdf" && result.name !== "create_image" && result.name !== "edit_image") {
            printToolResult(result.name, result.output, { args: result.input || {}, cwd: state.cwd, state });
          }
          (state.scheduleMountComposer || state.mountComposer)?.();
          outputToolEvent(state, { type: "tool-result", name: result.name, output: result.output });
        },
        onSource: (source) => outputToolEvent(state, { type: "source", source }),
        onFinish: (event) => {
          activity.clear();
          setComposerActivity(state, null);
          const metadata = event.metadata || event.messageMetadata || {};
          outputToolEvent(state, { type: "finish", model: metadata.model || null, usage: metadata.usage || null });
        },
      }), {
        onRetry: async (_error, attempt, maxAttempts) => {
          // The API has a reconnect protocol for a stream that was cut off by
          // a platform/network boundary. Send the text that already reached
          // this terminal so the next attempt can continue instead of
          // restarting the answer from scratch.
          reconnectText = streamedText;
          activity.clear();
          if (!quiet) composerNotice(state, `The model connection failed. Retrying (${attempt}/${maxAttempts - 1})…`, "amber");
          activity.render();
        },
      });
    } catch (error) {
      activity.clear();
      if (error?.name === "AbortError") {
        const messageText = "Generation cancelled.";
        if (!quiet) composerNotice(state, messageText, "amber");
        outputToolEvent(state, { type: "cancelled", message: messageText });
        if (state.cancelCurrent === cancel) state.cancelCurrent = previousCancel || null;
        return null;
      }
      if (error?.code === "STREAM_TERMINATED") {
        const messageText = error.message || "The response connection was terminated before the model finished. Please try again.";
        if (!quiet) composerNotice(state, messageText, "red");
        outputToolEvent(state, { type: "error", code: error.code, message: messageText });
        if (state.cancelCurrent === cancel) state.cancelCurrent = previousCancel || null;
        return null;
      }
      if (state.cancelCurrent === cancel) state.cancelCurrent = previousCancel || null;
      throw error;
    } finally {
      stopComposerAnimation();
      // state.cancelCurrent stays pointed at this turn's controller past this
      // point (see below) so Ctrl+C can still reach an executing local tool
      // -- restoring it here unconditionally ran it back to the PREVIOUS
      // cancel handler before runClientTool ever started, leaving Ctrl+C
      // with nothing to abort while a tool (e.g. a long Bash command) ran.
      state.toggleThinking = null;
      state.setThinkingMouse?.(false);
    }
    activity.clear();
    state.clearComposer?.();
    lastAssistant = assistant;
    // streamedText accumulates every delta received across the whole turn,
    // including any reconnect retries (see onRetry above); assistant.text is
    // only the LAST attempt's own text, so after a reconnect it holds just
    // the continuation suffix. Preferring it here silently dropped the
    // answer's prefix from what got rendered and saved.
    const responseText = streamedText || assistant.text;
    if (responseText && responseText !== assistant.text) {
      // Reconcile the full accumulated answer (prefix + any reconnect
      // continuation) back onto the assistant message so persisted history
      // and later context sent back to the model match what the user saw --
      // not just the last attempt's own (possibly partial) text.
      assistant.text = responseText;
      const reasoningPart = assistant.parts?.find((part) => part.type === "reasoning");
      assistant.parts = [...(reasoningPart ? [reasoningPart] : []), { type: "text", text: responseText }];
    }
    if ((responseText.trim() || String(state.thinkingText || "").trim()) && state.outputFormat !== "json" && !machine && (!quiet || state.printText)) {
      const renderedResponse = wrapRenderedTerminalMarkdown(renderTerminalMarkdown(responseText, { colorize: false }));
      const reasoning = stripInlineMarkdownEmphasis(String(state.thinkingText || "").trim());
      if (reasoning && !thinkingRendered) {
        const reasoningLines = reasoning.split(/\r?\n/);
        const tokEst = formatTokens(estimateTokens(reasoning));
        state.prepareTranscript?.(renderedResponse.split(/\r?\n/).length + 3);
        console.log(`  ${color.coral("▸")} ${color.cream("Thought for 2s")}${color.dim(`, ${tokEst} tokens`)}`);
        if (reasoningLines[0]) console.log(`    ${color.dim(stripInlineMarkdownEmphasis(reasoningLines[0]))}`);
        console.log();
      } else {
        state.prepareTranscript?.(renderedResponse.split(/\r?\n/).length);
      }
      process.stdout.write(`${indentAssistantText(renderedResponse)}\n`);
    }
    if (assistant.usage) {
      state.lastUsage = assistant.usage;
      const turnCompute = usageCompute(assistant.model || state.config.selectedModel, assistant.usage);
      if (turnCompute == null && state.maxBudget) {
        const messageText = "The server did not report billable Compute and this model has no trusted local price. Stopping before another turn so --max-budget cannot be bypassed.";
        if (!quiet) composerNotice(state, messageText, "amber");
        outputToolEvent(state, { type: "budget-unknown", message: messageText });
        break;
      }
      if (turnCompute != null) state.spentCompute += turnCompute;
    }
    for (const artifact of serverArtifacts) {
      const saved = await saveServerArtifact(state, artifact.name, artifact.output).catch(() => null);
      if (saved) {
        const relativePath = path.relative(state.cwd, saved) || saved;
        const messageText = `Saved ${artifact.name} output to ${relativePath}.`;
        if (!quiet) notice(messageText);
        outputToolEvent(state, { type: "artifact", name: artifact.name, path: saved });
        // The model only sees create_image/create_pdf's raw output (a data
        // URL) in the same turn it called the tool -- it has no way to know
        // the LOCAL file path this just got saved to, so referencing it from
        // HTML/files it writes afterward (e.g. <img src="...">) would be a
        // guess. Tell it explicitly, the same way a tool result would.
        conversation.push(userMessage(
          `<saved_artifact name="${artifact.name}" path="${relativePath}">\nThis was just saved to ${relativePath} (relative to the project root). Reference it by this exact path in any file you write.\n</saved_artifact>`,
        ));
        await persistLocalSession(state, conversation);
      }
    }
    if (!quiet && assistant.sources?.length) {
      console.log(`  ${color.muted("Sources")} ${assistant.sources.map((source) => color.cyan(typeof source === "string" ? source : source.url || source.title || "source")).join(color.muted(" · "))}`);
    }
    // A single assistant step can request more than one client tool at once
    // (e.g. two parallel Reads); api.js surfaces all of them in nativeCalls.
    // nativeCall (singular) stays as a fallback for anything constructing an
    // assistant message by hand without the array.
    const calls = assistant.nativeCalls?.length ? assistant.nativeCalls : (assistant.nativeCall ? [assistant.nativeCall] : []);
    const runnableCalls = calls.filter((entry) => CLI_LOCAL_TOOL_NAMES.has(entry.name) || entry.name === "ask_question");
    // Some provider streams close with an empty assistant payload. Do not
    // silently return the user to the prompt: retry the same continuation a
    // small, bounded number of times, preserving any tool result in context.
    if (!calls.length && !responseText.trim() && emptyContinuationRetries < 2) {
      emptyContinuationRetries += 1;
      if (!quiet) composerNotice(state, `The model returned an empty continuation. Retrying (${emptyContinuationRetries}/2)…`, "amber");
      if (state.cancelCurrent === cancel) state.cancelCurrent = previousCancel || null;
      // A transport/provider retry must not consume one of the user's agent
      // turns. The for-loop increment would otherwise make maxTurns=1 exit
      // before the retry ever runs.
      turn -= 1;
      continue;
    }
    if (!calls.length && !responseText.trim() && !quiet) {
      composerNotice(state, "The model returned no response after 3 attempts. Please try again or switch models with /model.", "red");
    }
    if (!runnableCalls.length) {
      // The server protects each HTTP request with a tool/time budget. When
      // that boundary is reached it removes tools for one step and asks the
      // model for a progress summary, tagging the finish metadata. Treating
      // that perfectly normal text response as task completion is what made
      // long CLI jobs stop midway. Save it as context and immediately give
      // the model a fresh request budget so it can resume autonomously.
      if (assistant.toolBudgetExhausted) {
        conversation.push(assistant);
        await persistLocalSession(state, conversation);
        if (!quiet) composerNotice(state, "Continuing the task with a fresh tool budget…", "amber");
        if (state.cancelCurrent === cancel) state.cancelCurrent = previousCancel || null;
        emptyContinuationRetries = 0;
        continue;
      }
      // Printed only here, where the agent loop actually ends, rather than
      // after every intermediate turn -- a turn that reads a file and keeps
      // going still has more tool calls queued, so marking it "Completed"
      // made an in-progress multi-step task look finished after just the
      // first step.
      if (!quiet && assistant.text?.trim()) {
        // The completion marker is transcript content too. Reserve its row
        // before printing it so the next submitted message cannot be placed
        // back on top of the marker by prepareTranscript(). This previously
        // produced merged lines such as "[10:24 PM]d in 9s".
        state.prepareTranscript?.(1);
        printTurnComplete(turnStartedAt);
      }
      if (state.cancelCurrent === cancel) state.cancelCurrent = previousCancel || null;
      conversation.push(assistant);
      await persistLocalSession(state, conversation);
      break;
    }
    const assistantTurn = {
      ...assistant,
      parts: [
        ...(assistant.parts || []),
        ...calls.map((call) => ({
          type: `tool-${call.name}`,
          toolCallId: call.toolCallId || crypto.randomUUID(),
          state: "input-available",
          input: call.arguments || {},
        })),
      ],
    };
    conversation.push(assistantTurn);
    await persistLocalSession(state, conversation);
    // runClientTool prints directly (printToolResult, approval prompts,
    // ask_question) with no clear/mount of its own around most of that --
    // unlike onToolCall/onToolResult below, which always clear the box
    // before printing and remount it after. Without this, the box's own
    // row-count bookkeeping went stale the moment a local tool (Bash, Read,
    // etc.) printed anything, so the NEXT real clear erased the wrong
    // number of rows -- this is what made the rule/status line vanish
    // specifically while a tool was running.
    // Calls run sequentially (not concurrently): parallel Edits/Writes to
    // overlapping files or Bash commands sharing state are not safe to race,
    // and the model reads each result in the order it will see them anyway.
    for (const call of runnableCalls) {
      state.clearComposer?.();
      activity.clear();
      setComposerActivity(state, null);
      printToolCall(call, { cwd: state.cwd, streamJson: machine, state });
      const resultText = await runClientTool(state, call, controller.signal);
      (state.scheduleMountComposer || state.mountComposer)?.();
      outputToolEvent(state, { type: "tool-result", name: call.name, output: resultText, toolCallId: call.toolCallId });
      const toolPart = assistantTurn.parts.find(
        (part) => part.type === `tool-${call.name}` && part.toolCallId === (call.toolCallId || part.toolCallId),
      );
      if (toolPart) {
        toolPart.state = "output-available";
        toolPart.output = resultText;
      }
      await persistLocalSession(state, conversation);
    }
    // The tool phase is over -- restore whatever Ctrl+C should cancel next
    // (a prior turn's controller, or nothing) now that this turn's is done.
    if (state.cancelCurrent === cancel) state.cancelCurrent = previousCancel || null;
    emptyContinuationRetries = 0;
    if (state.outputFormat === "json") continue;
  }
  if (!lastAssistant) return null;
  // By this point any tool calls on lastAssistant already ran -- execution
  // happens unconditionally within the same turn, before the loop's
  // maxTurns check is re-evaluated -- so this branch means the model hasn't
  // had a turn to react to their results yet, not that the calls themselves
  // are still queued. The message used to say "X still pending", which read
  // as the tool never having run and could tempt a retry of something that
  // already executed (and, for a mutating tool, already took effect).
  const lastToolCalls = lastAssistant.nativeCalls?.length ? lastAssistant.nativeCalls : (lastAssistant.nativeCall ? [lastAssistant.nativeCall] : []);
  if (lastToolCalls.length) {
    // "Raise --max-turns" is a startup flag -- useless advice mid-REPL, since
    // the thread already persisted the pending call and just needs another
    // message to pick back up.
    const continueHint = state.interactive
      ? "Send another message (e.g. \"continue\") to keep going."
      : "Raise --max-turns to continue.";
    const lastToolNames = lastToolCalls.map((entry) => entry.name).join(", ");
    // A recognized local/ask_question call always runs unconditionally
    // within its own turn (before maxTurns is re-checked) -- reaching turn
    // exhaustion or a budget stop here means it already ran and the model
    // just hasn't seen/replied to the result yet. An unrecognized name means
    // the opposite: it was never executed at all (see runnableCalls above).
    const allRecognized = lastToolCalls.every((entry) => CLI_LOCAL_TOOL_NAMES.has(entry.name) || entry.name === "ask_question");
    const messageText = allRecognized
      ? `Paused after ${maxTurns} model turn${maxTurns === 1 ? "" : "s"}. Its last tool call${lastToolCalls.length === 1 ? "" : "s"} (${lastToolNames}) already ran; the model hasn't replied to the result${lastToolCalls.length === 1 ? "" : "s"} yet. ${continueHint}`
      : `Paused after ${maxTurns} model turn${maxTurns === 1 ? "" : "s"}. The model's last request (${lastToolNames}) is not a recognized tool and was not run. ${continueHint}`;
    if (!quiet) notice(messageText, "amber");
    outputToolEvent(state, { type: "turn-limit", message: messageText });
  }
  if (lastAssistant.compacted && lastAssistant.summary) {
    const summaryMessage = {
      id: `auto-compacted-${lastAssistant.id}`,
      role: "user",
      parts: [{ type: "text", text: `This conversation was auto-compacted. Summary:\n\n${lastAssistant.summary}` }],
    };
    state.messages = [summaryMessage, ...conversation.slice(-4)];
    if (!quiet) notice("Context compacted automatically to keep the session moving.", "amber");
  } else {
    state.messages = conversation;
  }
  await persistLocalSession(state);
  state.pendingImages = [];
  // The interactive REPL owns the transient footer. Keeping it out of the
  // turn renderer means the transcript can remain one continuous top-to-
  // bottom conversation instead of starting a new block below /effort.
  if (!quiet && !state.interactive) printSessionFooter(state);
  if (state.outputFormat === "json") {
    process.stdout.write(`${JSON.stringify({ text: lastAssistant.text, model: lastAssistant.model || state.config.selectedModel, usage: lastAssistant.usage, threadId: state.threadId })}\n`);
  }
  return lastAssistant;
  } finally {
    state.unmuteComposerRedraw?.();
  }
}

async function continueGoal(state, goal) {
  const maxTurns = 25;
  for (let turn = 1; turn <= maxTurns; turn += 1) {
    let text = "";
    try {
      const result = await runPrompt(state, turn === 1 ? goal : "Continue.", { mode: "goal", goal });
      text = typeof result === "string" ? result : result?.text || "";
    } catch (error) {
      // /goal's entire point is unattended progress -- a turn throwing (a
      // tool that briefly wasn't available, a malformed response, a dropped
      // connection) used to propagate straight up and kill the whole loop,
      // leaving the user staring at an idle composer with no explanation and
      // no further attempts made. Log it and let the next iteration's
      // "Continue." give the model a chance to see what happened (it's still
      // in the conversation) and adjust, instead of the loop ending here.
      // Only running out of turns (the maxTurns cap below) should stop this.
      const message = error instanceof Error ? error.message : String(error);
      console.log(color.yellow(`Turn ${turn} hit an error and will retry: ${message}`));
      continue;
    }
    if (text.trim().endsWith("GOAL_ACHIEVED")) {
      console.log(color.green(`Goal achieved in ${turn} turn${turn === 1 ? "" : "s"}.`));
      return;
    }
  }
  console.log(color.yellow(`Paused after ${maxTurns} turns. Run /goal ${goal} to continue.`));
}

async function handleSlash(state, line) {
  const [command, ...rest] = line.trim().split(/\s+/);
  const argument = rest.join(" ").trim();
  switch (command.toLowerCase()) {
    case "/help": printHelp(); return true;
    case "/models": printModels(state.config.selectedModel, argument); return true;
    case "/model": {
      if (!argument) {
        const choice = await (state.withEditorPaused ? state.withEditorPaused(() => selectModelInteractive(state.config.selectedModel)) : selectModelInteractive(state.config.selectedModel));
        if (!choice?.model) return true;
        if (choice.sessionOnly) {
          state.config = { ...state.config, selectedModel: choice.model };
          printModelChangeMessage(modelLabel(choice.model), state.config.selectedReasoningEffort, state);
        } else {
          state.config = { ...state.config, ...saveConfig({ selectedModel: choice.model }) };
          printModelChangeMessage(modelLabel(choice.model), state.config.selectedReasoningEffort, state);
        }
        return true;
      }
      const model = resolveModel(argument);
      if (!model) { console.log(color.red(`No exact model match for “${argument}”.`)); printModels(state.config.selectedModel, argument); return true; }
      state.config = { ...state.config, ...saveConfig({ selectedModel: model }) };
      printModelChangeMessage(modelLabel(model), state.config.selectedReasoningEffort, state);
      return true;
    }
    case "/effort": {
      if (!argument) {
        console.log(`Reasoning effort: ${state.config.selectedReasoningEffort || "medium"}`);
        console.log("Options: low, medium, high, xhigh (Extra High), max (used by GPT-5.6 Luna/Terra only).");
        printEffortEstimates(state.config.selectedModel, contextOf(state.messages) + 1_600);
        return true;
      }
      const value = normalizeReasoningEffort(argument);
      if (!REASONING_EFFORTS.has(value)) {
        console.log(color.red("Unknown effort. Choose low, medium, high, xhigh (Extra High), or max."));
        return true;
      }
      state.config = { ...state.config, ...saveConfig({ selectedReasoningEffort: value }) };
      notice(`Reasoning effort set to ${color.cream(REASONING_EFFORT_LABELS[value])}.`);
      printEffortEstimates(state.config.selectedModel, contextOf(state.messages) + 1_600);
      return true;
    }
    case "/image":
    case "/attach": {
      if (!argument || argument.toLowerCase() === "clear") {
        state.pendingImages = [];
        console.log("Pending files cleared.");
        return true;
      }
      const file = await readAttachment(argument);
      checkAttachmentBudget([...state.pendingImages, file]);
      state.pendingImages.push(file);
      notice(`Attached ${color.cream(file.filename)} · it will be sent with your next prompt.`);
      return true;
    }
    case "/new":
      state.threadId = null;
      state.messages = [];
      state.pendingImages = [];
      state.todos = [];
      state.config = { ...state.config, ...saveConfig({ lastThreadId: null }) };
      notice("Started a fresh conversation.");
      return true;
    case "/clear":
      state.threadId = null;
      state.messages = [];
      state.pendingImages = [];
      state.todos = [];
      state.config = { ...state.config, ...saveConfig({ lastThreadId: null }) };
      if (input.isTTY && output.isTTY && process.env.NEXARA_NO_CLEAR !== "1") {
        clearTerminalForSession();
        await printBanner(state.config, await state.auth.user(), { resumed: false });
        printNewConversationIntro();
      } else {
        notice("Cleared the conversation.");
      }
      return true;
    case "/resume": {
      const id = argument || state.config.lastThreadId;
      if (!id) { console.log("No saved conversation to resume."); return true; }
      const loaded = await loadSavedThread(state.auth, id, currentAccountId(state.config));
      state.threadId = loaded.thread.id;
      state.messages = loaded.messages;
      state.sessionTitle = loaded.thread.title || "New chat";
      state.sessionCreatedAt = loaded.createdAt || loaded.thread.created_at || new Date().toISOString();
      // A saved transcript may have been created in another project. Keep
      // this process's trusted launch workspace; restoring a historical cwd
      // would silently redirect subsequent tools without a new trust check.
      state.todos = [];
      state.config = { ...state.config, ...saveConfig({ lastThreadId: state.threadId }) };
      await persistLocalSession(state);
      if (input.isTTY && output.isTTY && process.env.NEXARA_NO_CLEAR !== "1") {
        clearTerminalForSession();
        await printBanner(state.config, await state.auth.user(), { resumed: true });
        printConversationHistory(state);
      } else {
        notice(`Resumed ${loaded.local ? "local " : ""}${color.cream(loaded.thread.title)} · ${color.muted(state.threadId)}`);
      }
      return true;
    }
    case "/threads": {
      const local = state.config.noSessionPersistence ? [] : await listLocalSessions(50, currentAccountId(state.config));
      let remote = [];
      try {
        remote = await listThreads(state.auth);
      } catch (error) {
        if (!local.length) throw error;
        notice("Could not refresh remote threads; showing local sessions.", "amber");
      }
      const localIds = new Set(local.map((session) => session.threadId));
      console.log(color.dim(`Local sessions: ${SESSION_DIR}`));
      for (const session of local) {
        console.log(`${session.threadId}  ${session.title || "New chat"}  ${color.teal("· local")}`);
      }
      for (const thread of remote.filter((item) => !localIds.has(item.id))) {
        console.log(`${thread.id}  ${thread.title || "New chat"}  ${color.dim("· remote")}`);
      }
      if (!local.length && !remote.length) console.log("No saved conversations.");
      return true;
    }
    case "/compact": {
      if (state.messages.length < 2) {
        console.log(color.yellow("Conversation is too short to compact."));
        return true;
      }
      if (!state.threadId) {
        state.messages = compactLocalMessages(state.messages);
        console.log(color.green(`Local context compacted to ${state.messages.length} messages.`));
        return true;
      }
      try {
        const token = await state.auth.accessToken();
        const response = await fetch(`${state.config.appUrl.replace(/\/+$/, "")}/api/compact`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ threadId: state.threadId, model: state.config.selectedModel }),
          signal: AbortSignal.timeout(120_000),
        });
        const data = await response.json().catch(() => null);
        if (!response.ok || !data?.summary) {
          throw new Error(data?.error || "Could not compact the conversation.");
        }
        const summaryText = `📌 This conversation was compacted to free up the context window. Here is the summary of everything we discussed before:\n\n${data.summary}\n\nContinue from here — you can ask about anything in the summary.`;
        state.messages = [
          {
            id: data.messageId ?? `compact-${Date.now()}`,
            role: "user",
            parts: [{ type: "text", text: summaryText }],
          },
        ];
        notice("Conversation compacted · context window freed up.");
      } catch (error) {
        console.log(color.red(error.message));
      }
      return true;
    }
    case "/permission":
    case "/permissions": {
      const aliases = new Map([
        ["ask", "ask"],
        ["always-ask", "ask"],
        ["approve", "auto"],
        ["approve-for-me", "auto"],
        ["auto", "auto"],
        ["sandbox", "sandboxed"],
        ["sandboxed", "sandboxed"],
        ["full", "full"],
        // Keep older documented modes usable for existing configurations.
        ["read-only", "read-only"],
        ["plan", "plan"],
        ["allow-edits", "allow-edits"],
        ["allow-commands", "allow-commands"],
      ]);
      if (!argument) {
        const mode = await (state.withEditorPaused ? state.withEditorPaused(() => selectPermissionInteractive(effectivePermissionMode(state), state.cwd)) : selectPermissionInteractive(effectivePermissionMode(state), state.cwd));
        if (!mode) return true;
        state.config = { ...state.config, ...saveConfig({ permissionMode: mode }) };
        notice(`Permission mode set to ${color.cream(permissionModeLabel(mode))}.`);
        return true;
      }
      const mode = aliases.get(argument.toLowerCase().replace(/\s+/g, "-"));
      if (!mode) {
        console.log(color.red("Unknown permission mode. Choose Always ask, Approve for me, Sandboxed, or Full access."));
        return true;
      }
      state.config = { ...state.config, ...saveConfig({ permissionMode: mode }) };
      notice(`Permission mode set to ${color.cream(permissionModeLabel(mode))}.`);
      return true;
    }
    case "/tools":
      printAvailableTools();
      return true;
    case "/mcp":
      await printWorkspaceAutomation("mcp", state.cwd);
      return true;
    case "/skills":
      await printWorkspaceAutomation("skills", state.cwd);
      return true;
    case "/plugins":
      await printWorkspaceAutomation("plugins", state.cwd);
      return true;
    case "/tasks": {
      if (state.todos?.length) printTodoList(state.todos, { compact: true });
      else console.log(color.dim("\nNo active task plan. TodoWrite plans will appear here when the agent starts a multi-step task."));
      const jobs = backgroundSummary();
      console.log(`\n${color.coral("Background work")}`);
      if (!jobs.length) console.log(color.dim("  No local background commands are running."));
      else for (const job of jobs) console.log(`  ${job.id}  ${job.running ? color.teal("running") : color.muted(job.kind === "agent" ? "finished" : "exited")}  ${job.command}`);
      console.log(color.dim("  Commands and delegated read-only agents share this activity view."));
      return true;
    }
    case "/agents":
    case "/background": {
      const jobs = backgroundSummary();
      console.log(`\n${color.coral("Background work")}`);
      if (!jobs.length) console.log(color.dim("  No local background commands are running."));
      else for (const job of jobs) console.log(`  ${job.id}  ${job.running ? color.teal("running") : color.muted(job.kind === "agent" ? "finished" : "exited")}  ${job.command}`);
      console.log(color.dim("  Commands and delegated read-only agents share this activity view."));
      return true;
    }
    case "/logs": {
      if (!argument) { console.log("Usage: /logs <background-id>"); return true; }
      console.log(await executeCliTool(argument.startsWith("agent-") ? "CheckSubagent" : "BackgroundOutput", { id: argument }, { cwd: state.cwd }));
      return true;
    }
    case "/stop": {
      if (!argument) { console.log("Usage: /stop <background-id>"); return true; }
      await runClientTool(state, { name: argument.startsWith("agent-") ? "StopSubagent" : "StopBackground", arguments: { id: argument } });
      return true;
    }
    case "/download": {
      const artifactDirectory = path.join(state.cwd, ".nexara-artifacts");
      const files = await fs.readdir(artifactDirectory).catch(() => []);
      if (!files.length) console.log(color.dim("No artifacts saved yet. Ask Nexara to create a PDF, image, or file."));
      else {
        console.log(`\n${color.coral("Saved artifacts")}`);
        files.forEach((file) => console.log(`  ${path.join(".nexara-artifacts", file)}`));
      }
      return true;
    }
    case "/open":
      if (!argument) { console.log("Usage: /open <path>"); return true; }
      await runClientTool(state, { name: "OpenFile", arguments: { file_path: argument } });
      return true;
    case "/reveal":
      if (!argument) { console.log("Usage: /reveal <path>"); return true; }
      await runClientTool(state, { name: "RevealInExplorer", arguments: { file_path: argument } });
      return true;
    case "/config":
      console.log(`Config: ${state.configPath}`);
      console.log(`Local sessions: ${SESSION_DIR}`);
      return true;
    case "/doctor": {
      const checks = [];
      const nodeVersion = process.versions.node.split(".").map(Number);
      checks.push([nodeVersion[0] >= 22, `Node.js ${process.versions.node} (requires 22+)`]);
      checks.push([Boolean(state.cwd && await fs.stat(state.cwd).catch(() => null)), `Workspace ${displayPath(state.cwd)}`]);
      checks.push([Boolean(state.config.appUrl), `API endpoint ${state.config.appUrl || "missing"}`]);
      checks.push([Boolean(state.config.noSessionPersistence || state.threadId || await fs.stat(SESSION_DIR).catch(() => null)), state.config.noSessionPersistence ? "Local session storage disabled by flag" : `Local sessions ${SESSION_DIR}`]);
      checks.push([Boolean(await state.auth.user()), "Nexara account session"]);
      checks.push([Boolean(input.isTTY && output.isTTY), "Interactive terminal"]);
      console.log(`\n${color.coral("Nexara CLI diagnostics")}`);
      checks.forEach(([ok, label]) => console.log(`  ${ok ? color.teal("✓") : color.red("×")} ${label}`));
      console.log(color.dim("  No credential values are printed. Run /login if the account check fails."));
      return true;
    }
    case "/login": await login(state.config, state.auth); return true;
    case "/update": await runUpdateCommand([]); return true;
    case "/status": {
      const user = await state.auth.user();
      // Real usage from the last turn when available; heuristic otherwise.
      const real = lastRealContext(state);
      const ctxUsed = real ?? contextOf(state.messages);
      const ctxWindow = MODEL_CONTEXT.get(state.config.selectedModel) ?? 128_000;
      console.log();
      console.log(color.cyan("  Session"));
      console.log(`  ${color.dim("account    ")} ${user?.email || "not signed in"}`);
      console.log(`  ${color.dim("directory  ")} ${displayPath()}`);
      console.log(`  ${color.dim("model      ")} ${modelLabel(state.config.selectedModel)}`);
      console.log(`  ${color.dim("effort     ")} ${REASONING_EFFORT_LABELS[state.config.selectedReasoningEffort] || state.config.selectedReasoningEffort}`);
      console.log(`  ${color.dim("thread     ")} ${state.threadId || "new thread"}`);
      console.log(`  ${color.dim("storage    ")} ${state.config.noSessionPersistence ? "disabled" : `local · ${localSessionPath(state.threadId) || SESSION_DIR}`}`);
      console.log(`  ${color.dim("files      ")} ${state.pendingImages.length}`);
      console.log(`  ${color.dim("context    ")} ${formatTokens(ctxUsed)} / ${formatTokens(ctxWindow)} (${Math.min(100, Math.round((ctxUsed / ctxWindow) * 100))}%)${real ? " · exact" : " · estimate"}`);
      console.log();
      return true;
    }
    case "/think": await runPrompt(state, argument, { mode: "think", files: state.pendingImages }); return true;
    case "/research": await runPrompt(state, argument, { mode: "research", files: state.pendingImages }); return true;
    case "/perplexity": await runPrompt(state, argument, { mode: "perplexity", files: state.pendingImages }); return true;
    case "/plan": await runPrompt(state, argument, { mode: "planner", files: state.pendingImages }); return true;
    case "/honest": await runPrompt(state, argument, { mode: "honest", files: state.pendingImages }); return true;
    case "/goal":
      if (!argument) {
        console.log("Usage: /goal <what to achieve> — the agent loops until it reports GOAL_ACHIEVED.");
        return true;
      }
      await continueGoal(state, argument);
      return true;
    case "/quit":
    case "/exit": return false;
    default: console.log(color.yellow(`Unknown command: ${command}. Type /help.`)); return true;
  }
}

async function interactive(config, auth, configPath, existingState) {
  const state = existingState || { config, auth, configPath, threadId: null, messages: [], pendingImages: [], todos: [], quiet: false };
  state.cwd ||= process.cwd();
  state.outputFormat ||= "text";
  state.todos ||= [];
  state.interactive = true;
  state.maxTurns ||= state.config.maxTurns || 100;
  state.maxBudget ??= state.config.maxBudget;
  state.spentCompute ||= 0;
  // Wanting the box pinned to the literal bottom row AND new content to
  // keep appending right where the last real content left off are only
  // both true at once if the gap between them is recomputed and
  // reinserted on every redraw, not left over from whenever it was last
  // sized. realContentRows tracks how many physical rows of REAL content
  // (banner, conversation, tool output, notices -- anything that isn't the
  // box's own chrome or the gap itself) have been printed; clearComposer
  // already erases the gap along with the box every time (composerFooterLines
  // covers both -- see renderComposerFooter below), so re-deriving the gap
  // from this count on every mount keeps the box at the bottom without
  // content ever printing after stale padding. Installed before the banner
  // prints so its rows count too.
  let realContentRows = 0;
  let paintingBox = false;
  const outputWrite = output.write.bind(output);
  output.write = (chunk, ...rest) => {
    if (!paintingBox && !suppressRealContentRowCount && chunk) {
      const str = typeof chunk === "string" ? chunk : chunk.toString();
      const segments = str.split("\n");
      const columns = Math.max(1, Number(output.columns) || 80);
      // Only fully-terminated segments (everything before a \n) count as
      // real, completed rows -- an in-place redraw (the prompt, a spinner
      // tick, backspacing) never contains a literal newline, so it is
      // naturally excluded without needing to special-case it.
      for (let index = 0; index < segments.length - 1; index += 1) {
        realContentRows += Math.max(1, Math.ceil((visibleLength(segments[index]) || 0) / columns));
      }
    }
    return outputWrite(chunk, ...rest);
  };
  await printBanner(config, await auth.user(), { resumed: state.messages.length > 0 });
  const rl = input.isTTY && output.isTTY
    ? createTerminalEditor({ input, output, width: () => Math.max(24, Number(output.columns) || 80), rows: () => COMPOSER_INPUT_ROWS })
    : readline.createInterface({
      input,
      output,
      prompt: color.coral("  › "),
      completer: (line) => [[], line],
      crlfDelay: Infinity,
      terminal: false,
    });
  // Without bracketed paste, a paste landed in the composer indistinguishable
  // from real typing -- there was no way to tell "the user typed this" from
  // "this got pasted in" (including an accidental paste of whatever a text
  // selection elsewhere on screen had auto-copied). createTerminalEditor now
  // detects the terminal's paste markers and emits this event; surface it so
  // a paste is always visibly a paste, not a mystery.
  if (typeof rl.on === "function") {
    rl.on("paste", (text) => {
      const chars = String(text || "").length;
      if (chars) composerNotice(state, `Pasted ${chars} character${chars === 1 ? "" : "s"}.`, "teal");
    });
  }
  // selectQuestionInteractive/selectPermissionInteractive/selectModelInteractive
  // each install their OWN keypress listener on `input` rather than replacing
  // this editor's -- pause it first so the same keystroke isn't handled
  // twice (an Enter that selects a picker option no longer also submits or
  // corrupts whatever is sitting in the composer underneath it).
  const withEditorPaused = async (run) => {
    rl.pause?.();
    try {
      return await run();
    } finally {
      rl.resume?.();
    }
  };
  state.withEditorPaused = withEditorPaused;
  // While a response streams/prints, the transcript moves the real cursor
  // with absolute VT100 addressing; the composer's own render() only knows
  // relative movement, so a redraw racing that window drew into whatever
  // row the cursor actually landed on and corrupted the transcript. Typing
  // must still work (queued messages while the AI is busy are a supported
  // feature), so this only silences the composer's redraw -- not the
  // keystrokes -- for that window, then repaints once when it ends.
  // Only the fixed-composer TUI (terminal-editor.js) has this race -- the
  // plain readline fallback used for non-TTY/simple sessions has no
  // absolute-cursor transcript writes to collide with, and readline's own
  // pause() genuinely stops reading stdin (no "muted" concept), which would
  // wrongly kill its already-working type-ahead-while-busy behavior.
  state.muteComposerRedraw = () => { if (fixedComposer) rl.pause?.("muted"); };
  state.unmuteComposerRedraw = () => { if (fixedComposer) rl.resume?.(); };
  let questionActive = false;
  const askInComposer = async (message, options) => {
    questionActive = true;
    try {
      return await rl.question(message, options);
    } finally {
      questionActive = false;
    }
  };
  state.askApproval = async (message) => askInComposer(`\n  ${color.amber("! Approval required")}\n    ${message}`);
  state.askQuestion = async (message) => askInComposer(message);
  state.askChoice = async (question) => withEditorPaused(() => selectQuestionInteractive(question));

  // The status strip is a composer footer, not part of the conversation.
  // Keep its height so a submitted line can remove it before the next turn
  // is committed, leaving the transcript growing down from the top.
  let composerFooterLines = 0;
  // Remember exactly where the rail was last drawn (top row + total rows).
  // A resize changes output.rows/columns before the 'resize' handler runs,
  // so recomputing these from the CURRENT terminal size would erase the
  // wrong rows and leave the old rail stuck on screen. Always clear at the
  // position it was actually drawn.
  let railTop = null;
  let railRows = null;
  // The composer is a real terminal region, not transcript output. This is
  // the key invariant that prevents autocomplete, resize and streamed output
  // from ever cutting through the input surface in Windows Terminal.
  const fixedComposer = Boolean(input.isTTY && output.isTTY);
  // While a response is streaming, the editor's relative redraw is muted to
  // protect the transcript's absolute cursor writes. Repaint the draft at
  // its fixed absolute rows immediately on every change so type-ahead never
  // waits for the next status tick to become visible.
  if (fixedComposer && typeof rl.on === "function") {
    rl.on("change", () => {
      if (state.busy && composerMounted && railTop != null) rl.renderAt?.(railTop);
    });
  }
  // Match terminalWidth()'s margin below: writing to a terminal's literal
  // last row is exactly as unreliable on Windows as writing to its literal
  // last column. Without this, output.rows can be reported 1-2 rows taller
  // than what is actually visible, so the bottom rule and footer -- the
  // last two rows of the rail -- silently never appear (only the top rule
  // and the input row, which land a row or two higher, are ever seen).
  const terminalRows = () => Math.max(8, (Number(output.rows) || 24) - 1);
  // The rail mirrors OpenCode's prompt stack: a three-row editor, a model /
  // shortcut metadata row, then the workspace/version footer.
  // Everything above that boundary is the transcript and uses the terminal's
  // normal top-to-bottom scroll direction.
  const transcriptBottom = () => Math.max(3, terminalRows() - (COMPOSER_INPUT_ROWS + 2));
  // Logical cursor for transcript content. The first turn should follow the
  // header near the top (as in the reference), not jump to the bottom just
  // because the composer is fixed there. Once content fills the viewport the
  // cursor naturally clamps to the scroll-region tail.
  let transcriptFlowRow = 8;
  // The editor cursor lives inside the fixed rail. Before committing any
  // transcript text, anchor output at the scroll region's bottom so the rail
  // can never repaint over a just-submitted message.
  state.prepareTranscript = (reservedRows = 1) => {
    if (!fixedComposer || !output.isTTY) return null;
    // Reconcile logical placement with rows that were printed by tools,
    // notices, history, or other renderers outside this helper.
    transcriptFlowRow = Math.max(transcriptFlowRow, Math.min(transcriptBottom(), realContentRows + 1));
    const rows = Math.max(1, Math.min(transcriptBottom(), Number(reservedRows) || 1));
    const start = Math.max(1, Math.min(transcriptFlowRow, transcriptBottom() - rows + 1));
    transcriptFlowRow = Math.min(transcriptBottom(), start + rows);
        output.write(`\u001b[1;${transcriptBottom()}r\u001b[${start};1H`);
    // Rows this reserves can already hold a longer line from whatever content
    // last occupied this exact screen position -- the transcript scroll region
    // reuses rows once content fills the viewport (see transcriptFlowRow
    // above). Positioning the cursor here does not erase what is already on
    // the row, so a shorter new line only overwrites its own leading
    // characters and leaves the old line\'s tail sitting to the right of
    // it -- exactly the "You 11:30 AM" plus stray leftover-sentence
    // corruption seen in practice. Clear every reserved row before handing
    // control back to the caller, which prints its actual content starting
    // from `start`.
    for (let row = start; row < start + rows; row += 1) output.write(`\u001b[${row};1H\u001b[2K`);
    output.write(`\u001b[${start};1H`);
    return start;
  };
  // The live "Processing / Thinking / Writing" line belongs in the
  // transcript, directly under the submitted message and exactly where the
  // answer will appear -- the same place every other agent CLI puts it --
  // not buried in the composer's status strip. It owns one reserved
  // transcript row and is repainted in place at an absolute address wrapped
  // in save/restore (\u001b7 / \u001b8), so readline's caret never moves. The
  // earlier implementation moved the cursor RELATIVELY and had to guess the
  // column on the way back, which is what desynced the input caret and got
  // the inline line disabled for interactive sessions.
  let activityRow = null;
  state.beginTranscriptActivity = () => {
    if (!fixedComposer || !output.isTTY) return false;
    // A tool call, notice, or approval prompt printed during the turn pushes
    // the transcript tail below the reserved row. Re-reserve so the live line
    // keeps trailing the newest content instead of animating in place above
    // it. realContentRows only counts newline-terminated writes, so the
    // spinner's own in-place repaints never trigger this.
    const tail = Math.min(transcriptBottom(), realContentRows + 1);
    if (activityRow != null && tail <= activityRow) return true;
    if (activityRow != null && activityRow <= transcriptBottom()) {
      output.write(`\u001b7\u001b[${activityRow};1H\u001b[2K\u001b8`);
    }
    // prepareTranscript() parks the real cursor on the reserved row. That is
    // correct when transcript text is about to be printed, but this runs on a
    // timer while readline owns the caret -- bracket it so the caret lands
    // back in the composer.
    output.write(`\u001b7`);
    activityRow = state.prepareTranscript(1);
    output.write(`\u001b8`);
    state.transcriptActivityActive = activityRow != null;
    return state.transcriptActivityActive;
  };
  state.paintTranscriptActivity = (text) => {
    if (activityRow == null || !output.isTTY) return false;
    if (activityRow > transcriptBottom()) return false;
    output.write(`\u001b7\u001b[${activityRow};1H\u001b[2K${text}\u001b8`);
    return true;
  };
  state.endTranscriptActivity = () => {
    if (activityRow == null) return;
    if (activityRow <= transcriptBottom()) output.write(`\u001b7\u001b[${activityRow};1H\u001b[2K\u001b8`);
    // Hand the reserved row back so the response (or the next tool line) is
    // written over the spinner instead of leaving a blank gap behind it.
    transcriptFlowRow = Math.max(1, activityRow);
    activityRow = null;
    state.transcriptActivityActive = false;
  };
  let transcriptCursorSaved = false;
  let composerMounted = false;
  let slashSuggestionLines = 0;
  let slashSuggestionTop = null;
  let slashSuggestionIndex = -1;
  let slashSuggestionInput = null;
  let slashSuggestionTimer = null;

  function cancelSlashSuggestionTimer() {
    if (slashSuggestionTimer) clearImmediate(slashSuggestionTimer);
    slashSuggestionTimer = null;
  }

  function clearComposerFooter() {
    if (fixedComposer) {
      // Clear at the rail's last actually-drawn position, not wherever the
      // current terminal size says it "should" be — a resize between the
      // draw and this call would otherwise erase the wrong rows and leave
      // the stale rail visible (duplicate rail after maximizing the window).
      const rows = railRows != null ? railRows : terminalRows();
      const top = railTop != null ? railTop : transcriptBottom() + 1;
      // This function is intentionally safe to call more than once per turn:
      // onLine clears the rail, and runPrompt may clear it again while the
      // thread is being prepared. Preserve the current transcript position
      // when no composer cursor has been saved for restoration.
      const preserveCurrentCursor = !transcriptCursorSaved;
      if (preserveCurrentCursor) output.write("\u001b[s");
      // Erase only the reserved rail. Never clear the transcript viewport.
      output.write("\u001b[r");
      for (let row = top; row <= rows; row += 1) output.write(`\u001b[${row};1H\u001b[2K`);
      output.write("\u001b[0m");
      // `showComposer` saves the transcript position before moving to the
      // fixed controls. Restore it so the next user/assistant turn appends
      // directly after the header instead of jumping to the lower boundary.
      if (transcriptCursorSaved || preserveCurrentCursor) output.write("\u001b[u");
      transcriptCursorSaved = false;
      composerMounted = false;
      composerFooterLines = 0;
      state.composerFooterLines = 0;
      railTop = null;
      railRows = null;
      return;
    }
    if (!composerFooterLines || !output.isTTY) {
      state.composerFooterLines = 0;
      return;
    }
    // Readline moves to the blank row below the submitted prompt before this
    // runs. Erase only the footer and input rows; never touch older output.
    const rows = composerFooterLines + 1;
    output.write(`\u001b[${rows}A`);
    for (let index = 0; index < rows; index += 1) {
      output.write(`\r\u001b[2K${index < rows - 1 ? "\u001b[1B" : ""}`);
    }
    // The erase loop finishes on the last footer row. Return to the original
    // transcript row so the next user/assistant turn is committed directly
    // below the previous content instead of after a block of blank rows.
    if (rows > 1) output.write(`\u001b[${rows - 1}A`);
    output.write("\u001b[0m");
    composerFooterLines = 0;
    state.composerFooterLines = 0;
  }

  function renderComposerFooter() {
    if (fixedComposer) return;
    // Re-derive the gap needed to reach the bottom from actual real-content
    // rows printed so far, every time -- once that count exceeds the
    // screen height the pad is naturally just 0 forever after (the terminal
    // is already full and its own scrolling keeps the tail, i.e. the box,
    // at the bottom on its own).
    const boxRows = 4; // top border + status line + bottom border + input row
    const pad = Math.max(0, terminalRows() - boxRows - Math.min(realContentRows, terminalRows()));
    paintingBox = true;
    for (let index = 0; index < pad; index += 1) console.log();
    const footerLines = printSessionFooter(state);
    paintingBox = false;
    composerFooterLines = pad + footerLines;
    state.composerFooterLines = composerFooterLines;
  }

  // The streaming renderer uses these hooks to keep the composer anchored at
  // the bottom while status updates are drawn above it.
  state.composerFooterLines = 0;
  // A turn with many rapid tool calls (deleting a dozen files, say) cleared
  // and remounted the box once per call -- each remount reprints the box a
  // couple of lines further down as the log above it grows, so in a fast
  // burst the box visibly jumped down the screen over and over. Debouncing
  // the mount coalesces a burst into a single remount once it actually
  // settles, the same way the resize handler already avoids redrawing on
  // every intermediate frame of a drag-resize. A pending debounced mount
  // must never survive past the NEXT clear (which always precedes the next
  // print), or it could fire after new content already printed and land in
  // the wrong place -- so clearComposer cancels it too.
  let mountComposerTimer = null;
  state.clearComposer = () => {
    if (mountComposerTimer) {
      clearTimeout(mountComposerTimer);
      mountComposerTimer = null;
    }
    if (fixedComposer && composerMounted) {
      return;
    }
    clearComposerFooter();
  };
  state.mountComposer = () => showComposer();
  state.scheduleMountComposer = () => {
    if (mountComposerTimer) clearTimeout(mountComposerTimer);
    mountComposerTimer = setTimeout(() => {
      mountComposerTimer = null;
      showComposer();
    }, 80);
  };

  function clearSlashSuggestions(afterSubmit = false) {
    cancelSlashSuggestionTimer();
    if (fixedComposer && slashSuggestionLines && slashSuggestionTop != null && output.isTTY) {
      output.write("\u001b7");
      for (let index = 0; index < slashSuggestionLines; index += 1) {
        output.write(`\u001b[${slashSuggestionTop + index};1H\u001b[2K`);
      }
      output.write("\u001b8");
      slashSuggestionLines = 0;
      slashSuggestionTop = null;
      slashSuggestionIndex = -1;
      slashSuggestionInput = null;
      return;
    }
    if (!slashSuggestionLines || !output.isTTY) {
      slashSuggestionLines = 0;
      slashSuggestionIndex = -1;
      slashSuggestionInput = null;
      return;
    }
    const rows = slashSuggestionLines;
    if (afterSubmit) {
      // readline has already moved to the blank row below the submitted
      // prompt. Remove the suggestion rows, then return to that blank row.
      output.write(`\r\u001b[${rows + 1}A\u001b[${rows}M\u001b[1B\r`);
    } else {
      // While editing, the cursor is still inside the prompt row.
      output.write(`\r\u001b[${rows}A\u001b[${rows}M`);
    }
    slashSuggestionLines = 0;
    slashSuggestionIndex = -1;
    slashSuggestionInput = null;
  }

  function drawSlashSuggestions() {
    slashSuggestionTimer = null;
    if (state.modalOpen || !output.isTTY) return;
    const rows = renderSlashSuggestions(rl.line, slashSuggestionIndex);
    if (slashSuggestionLines) clearSlashSuggestions();
    if (!rows.length) return;
    if (fixedComposer) {
      if (railTop == null) return;
      const top = Math.max(1, railTop - rows.length);
      output.write("\u001b7");
      rows.forEach((row, index) => {
        output.write(`\u001b[${top + index};1H\u001b[2K${row}`);
      });
      output.write("\u001b8");
      slashSuggestionLines = rows.length;
      slashSuggestionTop = top;
      return;
    }
    const cursor = typeof rl.getCursorPos === "function" ? rl.getCursorPos() : { cols: 2 };
    output.write(`\r\u001b[${rows.length}L${rows.join("\n")}\n\r\u001b[${Math.max(0, Number(cursor.cols) || 0)}C`);
    slashSuggestionLines = rows.length;
  }

  function scheduleSlashSuggestions() {
    if (!output.isTTY || state.modalOpen || slashSuggestionTimer) return;
    if (rl.line !== slashSuggestionInput) {
      slashSuggestionInput = rl.line;
      const matches = slashSuggestionMatches(rl.line);
      // `/` alone has no arbitrary selection. Once letters are typed, pick
      // the closest match rather than always highlighting the first row.
      slashSuggestionIndex = matches.length && rl.line.length > 1
        ? matches.reduce((best, entry, index) => entry.command.length < matches[best].command.length ? index : best, 0)
        : -1;
    }
    slashSuggestionTimer = setImmediate(drawSlashSuggestions);
  }

  function fillSlashSuggestion() {
    const matches = slashSuggestionMatches(rl.line);
    if (!matches.length) return;
    const choice = matches[Math.max(0, Math.min(matches.length - 1, slashSuggestionIndex))];
    if (typeof rl.setLine === "function") rl.setLine(`${choice.command} `);
    else {
      rl.write(null, { ctrl: true, name: "u" });
      rl.write(`${choice.command} `);
    }
    slashSuggestionIndex = 0;
    scheduleSlashSuggestions();
  }

  const onKeypress = (str, key) => {
    if (state.modalOpen) return;
    if (key?.ctrl && key.name === "c") {
      if (state.cancelCurrent) state.cancelCurrent();
      return;
    }
    if (key?.ctrl && key.name === "o") {
      toggleExpandLastToolResult(state);
      return;
    }
  };

  const onSlashKeypress = (str, key = {}) => {
    if (state.modalOpen || key.ctrl || key.meta || key.alt) return;
    const name = String(key.name || "").toLowerCase();
    const action = navigationAction(str, key);
    if (name === "return" || name === "enter" || name === "escape") return;
    if (name === "tab") {
      setImmediate(fillSlashSuggestion);
      return;
    }
    const matches = slashSuggestionMatches(rl.line);
    if (matches.length && action) {
      if (action === "home") slashSuggestionIndex = 0;
      else if (action === "end") slashSuggestionIndex = matches.length - 1;
      else if (action === "pageup") slashSuggestionIndex = Math.max(0, Math.max(0, slashSuggestionIndex) - 5);
      else if (action === "pagedown") slashSuggestionIndex = Math.min(matches.length - 1, Math.max(-1, slashSuggestionIndex) + 5);
      else if (action === "up") slashSuggestionIndex = slashSuggestionIndex < 0 ? matches.length - 1 : Math.max(0, slashSuggestionIndex - 1);
      else if (action === "down") slashSuggestionIndex = slashSuggestionIndex < 0 ? 0 : Math.min(matches.length - 1, slashSuggestionIndex + 1);
      slashSuggestionInput = rl.line;
    }
    scheduleSlashSuggestions();
  };

  rl.setBeforeSubmit?.(() => {
    if (!fixedComposer) return false;
    const matches = slashSuggestionMatches(rl.line);
    if (!matches.length) return false;
    // An exact command is ready to run. A partial command accepts the current
    // highlighted match first, so Enter behaves like a completion key while
    // typing and a submit key once the command is complete.
    if (matches.length === 1 && rl.line.toLowerCase() === matches[0].command) return false;
    const selected = matches[Math.max(0, Math.min(matches.length - 1, slashSuggestionIndex))];
    rl.setLine?.(`${selected.command} `);
    clearSlashSuggestions();
    return true;
  });

  // Do not enable terminal mouse reporting here. Readline consumes stdin too;
  // allowing SGR mouse mode to run beside it leaks click packets such as
  // `0;5;6M` into the prompt. Thinking remains available through its keyboard
  // control, while normal clicks are harmless and never become chat text.
  let mouseReporting = false;
  const setMouseReporting = (enabled) => {
    if (!input.isTTY || !output.isTTY || !enabled || mouseReporting) return;
    mouseReporting = false;
    output.write("\u001b[?1006l\u001b[?1000l");
  };
  state.setThinkingMouse = setMouseReporting;

  input.on("keypress", onKeypress);
  input.on("keypress", onSlashKeypress);
  rl.on?.("change", () => {
    if (state.modalOpen) return;
    if (slashSuggestionTimer) cancelSlashSuggestionTimer();
    if (!slashSuggestionMatches(rl.line).length) {
      if (slashSuggestionLines) clearSlashSuggestions();
      return;
    }
    scheduleSlashSuggestions();
  });
  const pendingMessages = [];
  state.pendingMessages = pendingMessages;
  let activeRun = false;
  let closing = false;
  let resolveInteractive;
  const interactiveFinished = new Promise((resolve) => { resolveInteractive = resolve; });

  function fixedComposerStatus() {
    // While the inline transcript line is showing the live status, the rail
    // falls back to context/model so the same spinner is not on screen twice.
    const activity = state.transcriptActivityActive ? null : composerActivityLine(state);
    if (activity) return activity;
    const used = lastRealContext(state) ?? contextOf(state.messages || []);
    const windowSize = MODEL_CONTEXT.get(state.config.selectedModel) ?? 128_000;
    const percent = Math.min(100, Math.round((used / windowSize) * 100));
    const lead = state.busy ? color.coral("●") : color.teal("●");
    const label = state.busy ? "Working" : "Ready";
    return `${lead} ${color.muted(label)} ${color.dim("·")} ${color.muted(`${percent}% context`)}`;
  }

  function fixedComposerMetadata() {
    const model = color.muted(modelLabel(state.config.selectedModel));
    const details = state.busy ? color.muted("esc interrupt") : color.muted("tab agents   ctrl+p commands");
    return `${model} ${details}`;
  }

  // While a turn is busy, muteComposerRedraw() silences the input row's own
  // relative-cursor repaint (terminal-editor.js's render()) to avoid racing
  // the transcript's absolute-cursor writes -- typing still works and is
  // buffered, but with zero visible feedback for however long the turn takes,
  // which can be minutes across several tool calls. A plain "N chars typed"
  // status line technically told the user their input wasn't lost, but that's
  // not what was asked for -- they want to see the actual text they're
  // typing, not a count standing in for it. Painting the real draft here is
  // safe where calling the editor's own render() is not: this uses the same
  // fixed absolute-row addressing (and save/restore) as the metadata/footer
  // rows above, not relative cursor movement, so it can never desync with
  // the transcript's own absolute writes the way the muted render() could.
  function draftPreviewRows() {
    const text = typeof rl?.line === "string" ? rl.line : "";
    if (!text) return [];
    const columns = Math.max(20, Number(output.columns) || 80);
    const available = Math.max(1, columns - 6);
    const chunks = [];
    for (const segment of text.split("\n")) {
      if (!segment.length) chunks.push("");
      else for (let index = 0; index < segment.length; index += available) chunks.push(segment.slice(index, index + available));
    }
    // Show the tail -- the most recently typed text is what's actually in
    // progress, the same reasoning the live "Thinking"/"Writing" previews use.
    return chunks.slice(-COMPOSER_INPUT_ROWS);
  }

  function fixedComposerFooterLine() {
    const columns = Math.max(20, Number(output.columns) || 80);
    const width = Math.max(20, columns - 1);
    return color.blue("─".repeat(width));
  }

  function fixedComposerMetadataLine() {
    const columns = Math.max(20, Number(output.columns) || 80);
    const width = Math.max(20, columns - 1);
    return color.blue("─".repeat(width));
  }

  function refreshFixedStatus() {
    if (!composerMounted || railTop == null) return;
    const width = Math.max(20, Number(output.columns) || 80);
    const top = railTop;
    const inputRow = top + 1;
    const bottomRow = top + 2;
    const border = color.blue("─".repeat(width));
    const promptStr = "\u001b[38;2;88;166;255m›\u001b[38;2;250;249;245m  \u001b[0m";
    const text = typeof rl?.line === "string" ? rl.line : "";
    output.write(`\u001b7\u001b[${top};1H\u001b[2K${border}\u001b8`);
    output.write(`\u001b7\u001b[${inputRow};1H\u001b[2K${promptStr}\u001b[38;2;250;249;245m${text}\u001b[0m\u001b8`);
    output.write(`\u001b7\u001b[${bottomRow};1H\u001b[2K${border}\u001b8`);
  }

  function drawFixedComposerRail({ includeInput = false } = {}) {
    const top = transcriptBottom() + 1;
    const inputRow = top + 1;
    const bottomRow = top + 2;
    railRows = bottomRow;
    railTop = top;
    const width = Math.max(20, Number(output.columns) || 80);
    const border = color.blue("─".repeat(width));
    const promptStr = "\u001b[38;2;88;166;255m›\u001b[38;2;250;249;245m  \u001b[0m";
    output.write(`\u001b[${top};1H\u001b[2K${border}`);
    if (includeInput) {
      const text = typeof rl?.line === "string" ? rl.line : "";
      output.write(`\u001b[${inputRow};1H\u001b[2K${promptStr}\u001b[38;2;250;249;245m${text}\u001b[0m`);
    }
    output.write(`\u001b[${bottomRow};1H\u001b[2K${border}`);
  }

  function showComposer() {
    if (closing || rl.closed) return;
    clearComposerFooter();
    if (fixedComposer) {
      const inputRow = transcriptBottom() + 2;
      output.write("\u001b[s");
      transcriptCursorSaved = true;
      output.write(`\u001b[1;${transcriptBottom()}r`);
      drawFixedComposerRail({ includeInput: false });
      output.write(`\u001b[${inputRow};1H`);
      rl.resetRenderAnchor?.();
      rl.setPrompt("\u001b[38;2;88;166;255m›\u001b[38;2;250;249;245m  \u001b[0m");
      rl.prompt();
      composerMounted = true;
      return;
    }
    renderComposerFooter();
    output.write("\r\u001b[2K\u001b[0m\r");
    rl.setPrompt("\u001b[38;2;88;166;255m›\u001b[38;2;250;249;245m  \u001b[0m");
    rl.prompt();
  }

  // Redraw only when the composer is empty. This preserves readline's cursor
  // and any text the user is typing while still allowing an idle composer to
  // show the processing and thinking animation.
  function refreshComposer() {
    if (closing || rl.closed || !composerMounted) return;
    // Spinner/status ticks must never erase and repaint the Chatbox. Update
    // only the reserved status row; transcript and input pixels stay put.
    if (fixedComposer) {
      refreshFixedStatus();
      return;
    }
    // Never remount readline while the user has text in the prompt. The
    // activity timer and keypress handling share the event loop, but a
    // clear-and-prompt cycle still changes the terminal cursor independently
    // of readline's internal cursor model. During queued input that used to
    // make the caret jump and could erase or reorder characters. The prompt
    // stays untouched until the line is empty again; the animation resumes
    // automatically after submit or Ctrl+U.
    if (rl.line) return;
    // This is the spinner tick (every 360ms while a model turn is in
    // flight). It used to reposition the rail with absolute cursor
    // addressing, which depended on the anchored-rail approach that is gone
    // now (see the fixedComposer note above). A full clear-and-redraw
    // through the exact same path every other box update already uses is
    // safe here: showComposer() ends in rl.prompt(), which redraws
    // readline's own current line (prompt + whatever the user has typed) --
    // it is not clobbering the user's input, just repainting it, so the
    // spinner glyph can animate without the cursor-desync bug the old
    // standalone activity line had.
    clearComposerFooter();
    showComposer();
  }

  state.refreshComposer = refreshComposer;
  state.getCursorCol = () => typeof rl.getCursorPos === "function" ? Math.max(0, Number(rl.getCursorPos().cols) || 0) : 0;

  // Keep the transcript boundary and composer rail in sync when the terminal
  // is resized. Readline retains the current line, so remounting the rail is
  // enough to preserve typed text while moving the controls to the new bottom.
  let resizeSettleTimer = null;
  const onResize = () => {
    if (closing || rl.closed || !composerMounted) return;
    // A fullscreen toggle (or any drag-resize) fires many 'resize' events in
    // quick succession while the window animates through intermediate sizes,
    // not just one at the final size. Redrawing on every single one raced
    // against itself -- a clear-and-redraw for a transient in-between size
    // could undercount how many rows its own content actually took (e.g. the
    // rule line wrapping to two rows for one instant), leaving a stray
    // fragment behind that the NEXT redraw's line-count tracking never knew
    // to erase. Debounce so only the size the window actually settles on
    // triggers a redraw.
    if (resizeSettleTimer) clearTimeout(resizeSettleTimer);
    resizeSettleTimer = setTimeout(() => {
      resizeSettleTimer = null;
      if (closing || rl.closed || !composerMounted) return;
      // If the terminal got SHORTER, the rail's fixed position (anchored to
      // the bottom) moves UP to stay pinned there -- directly into rows that
      // may still hold real transcript content (an assistant reply, e.g.)
      // printed back when the terminal was taller. clearComposerFooter()
      // below only knows to erase the rail's OWN last-drawn rows, and
      // showComposer() draws the new, smaller one starting higher up the
      // screen -- neither one has any notion of "real conversation content
      // used to live here," so drawFixedComposerRail's own row-clearing
      // silently wiped it with no way to get it back. A plain burst of
      // newlines scrolls the whole screen up by the shrink amount first
      // (the terminal's own natural scroll, not a clear) so whatever was
      // sitting in those rows moves into scrollback intact instead of being
      // destroyed by the rail redraw that follows.
      const previousInputStartRow = railTop;
      const newInputStartRow = transcriptBottom() + 1;
      if (previousInputStartRow != null && newInputStartRow < previousInputStartRow) {
        output.write("\n".repeat(previousInputStartRow - newInputStartRow));
      }
      // Redraw the box at its new width so a live resize does not leave a
      // stale-width rule or status line behind -- this cannot use absolute
      // addressing or a scroll region (see the fixedComposer note above), so
      // it just re-runs the same relative clear-and-redraw every other
      // update already uses.
      clearComposerFooter();
      showComposer();
    }, 150);
  };
  if (typeof output.on === "function") output.on("resize", onResize);

  async function runInteractiveLine(line, files, options = {}) {
    activeRun = true;
    state.busy = true;
    try {
      if (line.startsWith("/")) {
        state.modalOpen = true;
        try {
          const keepGoing = await handleSlash(state, line);
          if (!keepGoing) {
            closing = true;
            state.cancelCurrent?.();
          }
        } finally {
          state.modalOpen = false;
        }
      } else {
        await runPrompt(state, line, { files, ...options });
      }
    } catch (error) {
      composerNotice(state, error instanceof Error ? error.message : String(error), "red");
    } finally {
      activeRun = false;
      state.busy = false;
      if (closing) {
        rl.close();
        return;
      }
      const next = pendingMessages.shift();
      if (next) {
        void runInteractiveLine(next.line, next.files, { alreadyRendered: true });
      } else {
        showComposer();
      }
    }
  }

  const onLine = (raw) => {
    if (closing || questionActive || state.modalOpen) return;
    const line = raw.trim();
    clearSlashSuggestions(true);
    clearComposerFooter();
    if (!line) {
      showComposer();
      return;
    }
    const files = line.startsWith("/") ? [] : state.pendingImages.slice();
    if (!line.startsWith("/")) state.pendingImages = [];
    if (activeRun) {
      pendingMessages.push({ line, files });
      state.prepareTranscript?.(userTurnRows(line, files) + 1);
      printUserTurn(line, files);
      console.log(`  ${color.amber("↳")} ${color.cream("Queued")} ${color.muted(`message ${pendingMessages.length} · will run after the current turn`)}`);
      showComposer();
      return;
    }
    void runInteractiveLine(line, files);
  };

  const onClose = () => {
    if (!closing) {
      closing = true;
      state.cancelCurrent?.();
    }
    resolveInteractive();
  };

  rl.on("line", onLine);
  rl.once("close", onClose);
  if (!state.messages.length) {
    printNewConversationIntro();
  } else {
    printConversationHistory(state);
  }
  // No padding: the box just prints right after whatever came before it, the
  // same as any other line. It only ever sits away from the visible bottom
  // when there isn't much on screen yet -- pre-filling that gap with blank
  // lines pushed every message that followed down there too, so a fresh
  // session started with a wall of dead space above the actual conversation
  // instead of the conversation continuing naturally from the intro.
  showComposer();
  try {
    await interactiveFinished;
  } finally {
    rl.removeListener("line", onLine);
    rl.removeListener("close", onClose);
    input.removeListener("keypress", onKeypress);
    input.removeListener("keypress", onSlashKeypress);
    if (typeof output.removeListener === "function") output.removeListener("resize", onResize);
    setMouseReporting(false);
    cancelSlashSuggestionTimer();
    clearSlashSuggestions(true);
    clearBackgroundProcesses();
    if (fixedComposer) {
      // The rail (border, model line, input box) was drawn with absolute
      // cursor addressing near the bottom of the screen -- resetting the
      // scroll region only lets FUTURE output scroll through those rows
      // again, it does not erase what is already printed there. Since this
      // CLI deliberately stays in the primary screen buffer (see
      // enterTerminalScreen above, for scrollback), there is no alt-screen
      // exit to wipe the slate clean either -- so without an explicit clear
      // here, the whole rail stayed visibly printed on screen after exit,
      // and the real shell's next prompt landed overlapping it instead
      // of on a clean line.
      const railTopRow = transcriptBottom() + 1;
      const railBottomRow = terminalRows();
      let cleanup = `\u001b[r`;
      for (let row = railTopRow; row <= railBottomRow; row += 1) cleanup += `\u001b[${row};1H\u001b[2K`;
      cleanup += `\u001b[${railTopRow};1H\u001b[0m\r\n`;
      output.write(cleanup);
    }
    rl.close();
  }
}

// A pipe with no natural end (a log tail, an endless producer) or just a
// very large file previously grew this string with no bound at all, risking
// unbounded memory growth before the request was even built -- and a prompt
// that large could never fit a model's context anyway.
const MAX_PIPED_INPUT_BYTES = 4_000_000;
async function readPipedInput() {
  let value = "";
  let truncated = false;
  for await (const chunk of process.stdin) {
    value += chunk;
    if (value.length > MAX_PIPED_INPUT_BYTES) {
      value = value.slice(0, MAX_PIPED_INPUT_BYTES);
      truncated = true;
      // A producer with no natural end (e.g. `yes | nexara -p ...`) would
      // otherwise keep this loop awaiting the next chunk forever even after
      // accumulation stops -- stop consuming stdin entirely instead.
      break;
    }
  }
  const trimmed = value.trim();
  return truncated
    ? `${trimmed}\n\n… input truncated at ${Math.round(MAX_PIPED_INPUT_BYTES / 1_000_000)} MB …`
    : trimmed;
}

async function oneShot(config, auth, options, configPath) {
  await requireLogin(auth, config);
  const piped = !process.stdin.isTTY ? await readPipedInput() : "";
  const instruction = options.prompt.join(" ");
  const prompt = instruction && piped ? `${instruction}\n\nInput:\n${piped}` : instruction || piped;
  if (!prompt) throw new Error("Provide a prompt, e.g. `nexara -p \"Summarize this\"`, or pipe input.");
  const images = await Promise.all(options.images.map(readImage));
  checkAttachmentBudget(images);
  const state = {
    config: {
      ...config,
      ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
      ...(options.maxTurns ? { maxTurns: options.maxTurns } : {}),
      ...(options.maxBudget ? { maxBudget: options.maxBudget } : {}),
      ...(options.allowedTools.length ? { allowedTools: options.allowedTools } : {}),
      ...(options.disallowedTools.length ? { disallowedTools: options.disallowedTools } : {}),
      ...(options.noSessionPersistence ? { noSessionPersistence: true } : {}),
    },
    auth,
    configPath,
    cwd: process.cwd(),
    threadId: null,
    messages: [],
    sessionTitle: null,
    sessionCreatedAt: null,
    pendingImages: images,
    todos: [],
     quiet: Boolean(options.print),
     printText: Boolean(options.print && options.outputFormat === "text"),
    outputFormat: options.outputFormat,
    maxTurns: options.maxTurns || config.maxTurns || 100,
    maxBudget: options.maxBudget || config.maxBudget || null,
    spentCompute: 0,
    askApproval: async () => "n",
    askQuestion: async () => "",
  };
  if (options.continue) {
    const id = config.lastThreadId;
    if (!id) throw new Error("No previous thread to continue.");
    const loaded = await loadSavedThread(auth, id, currentAccountId(config));
    state.threadId = loaded.thread.id;
    state.messages = loaded.messages;
    state.sessionTitle = loaded.thread.title || "New chat";
    state.sessionCreatedAt = loaded.createdAt || loaded.thread.created_at || new Date().toISOString();
    // The directory where this process was launched is authoritative for the
    // current run. A saved thread's cwd is historical metadata; restoring it
    // here made tools inspect a different project when `--continue` was run
    // from a new folder.
  }
  await runPrompt(state, prompt, { files: images });
  if (options.print) process.stdout.write("\n");
}

/** `nexara update [--on|--off]` and the REPL's `/update`.
 *  - bare       Check for a newer version; if one exists, install it now in
 *               the foreground (the CLI restarts into the new version next run)
 *  - --on/--off Persist the silent auto-update preference
 *  - --status   Show whether silent auto-updates are on and what version is
 *               installed (no network call, works offline)
 */
async function runUpdateCommand(args, { quiet = false } = {}) {
  const enable = args.includes("--on");
  const disable = args.includes("--off");
  if (enable || disable) {
    const enabled = setAutoUpdateEnabled(enable);
    console.log(
      enabled
        ? color.green("Silent background updates are ON — newer CLI versions install automatically.")
        : color.green("Silent background updates are OFF. Update manually whenever you like with: nexara update"),
    );
    return;
  }
  if (args.includes("--status")) {
    const auto = isAutoUpdateEnabled();
    console.log(
      `Nexara CLI ${CURRENT_VERSION}\nAuto-update: ${auto ? "enabled (silent background installs)" : "disabled — run \u201cnexara update\u201d to update manually"}`,
    );
    return;
  }
  const result = await manualUpdate();
  if (!quiet) console.log(result.ok ? color.green(result.message) : color.red(result.message));
  else diagnostic(result.message);
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const config = loadConfig();
  const configPath = (await import("./config.js")).CONFIG_FILE;
  if (options.help) { printHelp(); return; }
  if (options.version) { console.log(CURRENT_VERSION); return; }
  const removeEscapeExit = installEscapeExit();
  try {
  // Never block startup on GitHub. The detached worker updates the global
  // install in the background, so this command remains usable offline and
  // the next invocation automatically runs the new version. Manual runs
  // (`nexara update`) check for themselves, so skip the background one.
  if (!(options.prompt[0] === "update" && options.prompt.length === 1)) void scheduleAutoUpdate();
  if (options.appUrl) saveConfig({ appUrl: options.appUrl });
  const nextConfig = loadConfig();
  if (options.model) {
    const model = resolveModel(options.model);
    if (!model) throw new Error(`Unknown model: ${options.model}. Run nexara --help.`);
    nextConfig.selectedModel = model;
  }
  if (options.reasoningEffort) nextConfig.selectedReasoningEffort = options.reasoningEffort;
  if (options.permissionMode) nextConfig.permissionMode = options.permissionMode;
  if (options.maxTurns) nextConfig.maxTurns = options.maxTurns;
  if (options.maxBudget) nextConfig.maxBudget = options.maxBudget;
  if (options.allowedTools.length) nextConfig.allowedTools = options.allowedTools;
  if (options.disallowedTools.length) nextConfig.disallowedTools = options.disallowedTools;
  if (options.noSessionPersistence) nextConfig.noSessionPersistence = true;
  const auth = createAuth(nextConfig);
  await refreshModelCatalog(nextConfig.appUrl);
  const command = options.prompt[0];
  if (command === "login" && options.prompt.length === 1) { await login(nextConfig, auth, options.google, options.qr); return; }
  if (command === "logout" && options.prompt.length === 1) { await auth.logout(); console.log("Signed out."); return; }
  if (command === "update" && options.prompt.length === 1) {
    await runUpdateCommand(options.updateMode ? [`--${options.updateMode}`] : []);
    return;
  }
  if (command === "whoami" && options.prompt.length === 1) { const user = await auth.user(); console.log(user?.email || "Not signed in."); return; }
  const startsInteractive = !(options.print || options.prompt.length > 0 || options.images.length > 0 || (options.continue && options.prompt.length > 0));
  if (startsInteractive || (command === "login" && options.prompt.length === 1)) {
    enterTerminalScreen();
    clearTerminalForSession();
  }
  if (!startsInteractive) {
    await ensureSignedIn(nextConfig, auth, options.google, options.qr);
    await oneShot(nextConfig, auth, { ...options, prompt: options.prompt[0] === "login" ? [] : options.prompt }, configPath);
    return;
  }
  if (!(await confirmWorkspace(nextConfig))) return;
  await ensureSignedIn(nextConfig, auth, options.google, options.qr);
  // Authentication can render its own picker and status lines inside the
  // alternate screen. Start the actual chat home on a clean frame so the
  // sign-in UI never remains above the Nexara transcript.
  clearTerminalForSession();
  if (options.continue) {
    const state = { config: nextConfig, auth, configPath, threadId: null, messages: [], sessionTitle: null, sessionCreatedAt: null, pendingImages: [], quiet: false };
    const id = nextConfig.lastThreadId;
    if (!id) throw new Error("No previous thread to continue.");
    const loaded = await loadSavedThread(auth, id, currentAccountId(nextConfig));
    state.threadId = loaded.thread.id;
    state.messages = loaded.messages;
    state.sessionTitle = loaded.thread.title || "New chat";
    state.sessionCreatedAt = loaded.createdAt || loaded.thread.created_at || new Date().toISOString();
    // Keep the launch directory authoritative. The saved cwd describes where
    // the earlier turn ran and must not silently redirect local tools now.
    await interactive(nextConfig, auth, configPath, state);
    return;
  }
  await interactive(nextConfig, auth, configPath);
  } finally {
    restoreTerminalScreen();
    removeEscapeExit();
  }
}
