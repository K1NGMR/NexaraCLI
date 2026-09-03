import fs from "node:fs/promises";
import path from "node:path";
import { emitKeypressEvents } from "node:readline";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { createAuth } from "./auth.js";
import { createThread, listThreads, loadThread, sendChat, transcribeAudio, userMessage } from "./api.js";
import { loadConfig, saveConfig } from "./config.js";
import { startMicRecording } from "./mic.js";
import { printQr } from "./qr.js";
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
const MODEL_IMAGE_INPUT = new Set([
  "google/gemini-3.6-flash",
  "google/gemini-3.5-flash",
  "google/gemini-3.1-pro",
  "google/gemini-3-flash",
  "google/gemini-2.5-flash",
  "google/gemini-2.5-pro",
]);

function formatCreditEstimate(cost) {
  return cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
}

function reasoningEffortCreditEstimate(model, effort, inputTokens) {
  const pricing = MODEL_PRICING.get(model);
  if (!pricing) return 0;
  return (inputTokens * pricing.input + REASONING_EFFORT_OUTPUT_ESTIMATES[effort] * pricing.output) / 1_000_000;
}

function printEffortEstimates(model, inputTokens) {
  const pricing = MODEL_PRICING.get(model);
  if (!pricing) return;
  const estimates = [...REASONING_EFFORTS]
    .map((effort) => `${REASONING_EFFORT_LABELS[effort]} ~${formatCreditEstimate(reasoningEffortCreditEstimate(model, effort, inputTokens))}`)
    .join(" · ");
  console.log(color.dim(`Estimated $ Credits before sending (${formatTokens(inputTokens)} input tokens): ${estimates}`));
  console.log(color.dim("Estimate uses an illustrative response budget; actual billing uses real provider usage."));
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

const MODELS = [
  ["router/autorouter", "AutoRouter (recommended)"],
  ["router/openrouter-free", "OpenRouter Free Route"],
  ["openai/gpt-oss-120b", "GPT-OSS-120B"],
  ["openai/gpt-5.6-luna", "GPT-5.6 Luna (Paid)"],
  ["openai/gpt-5.6-terra", "GPT-5.6 Terra (Paid)"],
  ["moonshotai/kimi-k2.6", "Kimi K2.6 (Paid)"],
  ["moonshotai/kimi-k2.5", "Kimi K2.5 (Paid)"],
  ["google/gemini-3.6-flash", "Gemini 3.6 Flash (Paid · Vision)"],
  ["google/gemini-3.5-flash", "Gemini 3.5 Flash (Paid · Vision)"],
  ["google/gemini-3.1-pro", "Gemini 3.1 Pro (Paid · Vision)"],
  ["google/gemini-3-flash", "Gemini 3 Flash (Paid · Vision)"],
  ["google/gemini-2.5-flash", "Gemini 2.5 Flash (Paid · Vision)"],
  ["google/gemini-2.5-pro", "Gemini 2.5 Pro (Paid · Vision)"],
  ["minimax/minimax-m2", "MiniMax M2"],
  ["minimax/minimax-m2.1-highspeed", "MiniMax M2.1 High-Speed"],
  ["minimax/minimax-m2.1", "MiniMax M2.1"],
  ["minimax/minimax-m2.5-highspeed", "MiniMax M2.5 High-Speed"],
  ["minimax/minimax-m2.5", "MiniMax M2.5"],
  ["minimax/minimax-m2.7-highspeed", "MiniMax M2.7 High-Speed"],
  ["minimax/minimax-m2.7", "MiniMax M2.7"],
  ["minimax/minimax-m3", "MiniMax M3 (Paid · $ Credits)"],
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
  ["deepseek/deepseek-v4-flash-0731", "DeepSeek V4 Flash 07.31 (Paid · $ Credits)"],
  ["xiaomi/mimo-v2.5-pro:free", "Xiaomi Mimo V2.5 Pro (Paid · $ Credits)"],
  ["xiaomi/mimo-v2.5:free", "Xiaomi Mimo V2.5 (Paid · $ Credits)"],
  ["x-ai/grok-4.5", "Grok 4.5 (Paid)"],
  ["nvidia/nemotron-3-nano", "Nemotron 3 Nano"],
  ["nvidia/nemotron-3-super", "Nemotron 3 Super"],
  ["nvidia/nemotron-3-ultra", "Nemotron 3 Ultra"],
  ["qwen/qwen3.8-max", "Qwen 3.8 Max ($ Credits)"],
  ["qwen/qwen3.7-max", "Qwen 3.7 Max ($ Credits)"],
  ["qwen/qwen3.7-plus", "Qwen 3.7 Plus ($ Credits)"],
  ["qwen/qwen3.6-max-preview", "Qwen 3.6 Max (Preview) ($ Credits)"],
  ["qwen/qwen3.6-plus", "Qwen 3.6 Plus ($ Credits)"],
  ["qwen/qwen3.6-27b", "Qwen 3.6 27B ($ Credits)"],
  ["qwen/qwen3.6-35b-a3b", "Qwen 3.6 35B A3B ($ Credits)"],
  ["qwen/qwen3.5-plus", "Qwen 3.5 Plus ($ Credits)"],
  ["qwen/qwen3.5-397b-a17b", "Qwen 3.5 397B A17B ($ Credits)"],
  ["qwen/qwen3.5-omni-plus", "Qwen 3.5 Omni Plus ($ Credits)"],
  ["qwen/qwen3.5-flash", "Qwen 3.5 Flash ($ Credits)"],
  ["qwen/qwen3.5-omni-flash", "Qwen 3.5 Omni Flash ($ Credits)"],
  ["qwen/qwen3-coder-plus", "Qwen3 Coder Plus ($ Credits)"],
  ["qwen/qwen3-max", "Qwen3 Max ($ Credits)"],
  ["qwen/qwen3-vl-plus", "Qwen3 VL Plus ($ Credits)"],
  ["qwen/qwen3-omni-flash", "Qwen3 Omni Flash ($ Credits)"],
  ["qwen/qwen-plus-2025-07-28", "Qwen Plus 07.28 ($ Credits)"],
  ["stealth/ox-alpha-free", "Ox Alpha ($ Credits)"],
  ["z-ai/glm-4.5-air", "GLM 4.5 Air ($ Credits)"],
  ["z-ai/glm-4.5", "GLM 4.5 ($ Credits)"],
  ["z-ai/glm-4.6", "GLM 4.6 ($ Credits)"],
  ["z-ai/glm-4.7", "GLM 4.7 ($ Credits)"],
  ["z-ai/glm-5", "GLM 5 ($ Credits)"],
  ["z-ai/glm-5-turbo", "GLM 5 Turbo ($ Credits)"],
  ["z-ai/glm-5.1", "GLM 5.1 ($ Credits)"],
  ["z-ai/glm-5.2", "GLM 5.2 ($ Credits)"],
  ["z-ai/glm-5.3", "GLM 5.3 ($ Credits)"],
  ["z-ai/glm-5.3-flash", "GLM 5.3 Flash ($ Credits)"],
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

const SLASH_COMMANDS = [
  "/help", "/model", "/models", "/effort", "/attach", "/image", "/think", "/research",
  "/perplexity", "/plan", "/honest", "/goal", "/new", "/resume", "/threads", "/clear",
  "/compact", "/config", "/permissions", "/tools", "/mcp", "/skills", "/plugins", "/agents", "/background", "/tasks", "/logs",
  "/stop", "/download", "/open", "/reveal", "/login", "/update", "/status", "/quit", "/exit",
];

const SLASH_COMMAND_DESCRIPTIONS = new Map([
  ["/help", "Show commands, shortcuts, login, and automation options."],
  ["/model", "Choose the AI model for this session or set a new default."],
  ["/models", "Print the complete model catalog and pricing."],
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
  ["/resume", "Resume the last saved thread or choose a thread ID."],
  ["/threads", "Browse recent saved conversations."],
  ["/clear", "Clear local context and start a fresh thread."],
  ["/compact", "Summarize the conversation to free context space."],
  ["/config", "Show the local Nexara configuration path."],
  ["/permissions", "Choose read-only, plan, edits, commands, auto, or full access."],
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
  ["/login", "Sign in again or switch the active Nexara account."],
  ["/update", "Check for and install a newer CLI version."],
  ["/status", "Show account, model, thread, and context state."],
  ["/quit", "Exit Nexara."],
  ["/exit", "Exit Nexara."],
]);

const ansi = (code, text) => `\u001b[${code}m${text}\u001b[0m`;
const rgb = (red, green, blue) => (text) => ansi(`38;2;${red};${green};${blue}`, text);
// The CLI uses Nexara's warm dark-surface palette: cream text, coral action,
// teal for healthy state, and amber for attention. It deliberately avoids the
// generic blue/cyan terminal look.
const color = {
  coral: rgb(204, 120, 92),
  coralActive: rgb(169, 88, 62),
  cream: rgb(250, 249, 245),
  violet: rgb(154, 91, 230),
  pink: rgb(239, 117, 205),
  muted: rgb(160, 157, 150),
  teal: rgb(93, 184, 166),
  amber: rgb(232, 165, 90),
  red: rgb(198, 69, 69),
  dim: (text) => ansi("2", text),
  green: rgb(93, 184, 114),
  yellow: rgb(212, 160, 23),
  // Compatibility aliases retained while commands transition to the palette.
  cyan: rgb(204, 120, 92),
  white: rgb(250, 249, 245),
  blue: rgb(93, 184, 166),
  magenta: rgb(204, 120, 92),
};
const ANSI_RE = /\u001b\[[0-9;]*m/g;
// A terminal-safe raster sampled from the Nexara Petal logo. Each character
// is a source-image colour bucket; the renderer paints it as a pair of
// true-colour spaces so the mark remains crisp in Windows Terminal and other
// ANSI-capable terminals. This replaces the old invented puppet silhouette.
const NEXARA_LOGO_FRAME = [
  "..............P..............",
  ".............PPP.............",
  "............PPPPP............",
  "...........PPPPPPP...........",
  "..........PPPPPPPPP..........",
  ".VVVVVVVPPPPPPPPPPPPPPPPPPVV.",
  ".VVBBVVVVVPPPPPPPPPVVVVVVVVW.",
  "..BBBBBBVVPMMPWPMMPVVVVVVVW..",
  "...VBBBBBBBWMMWMWWPPVVVVVW...",
  "....MMMMMMMWWWWWWPPVVVVVV....",
  "....WVVBBBVWWWWWWPPPVVVVW....",
  "...WVVBBBVVWWWWWWWPVVVVVV....",
  "..WVVBBBBBVMMPWPMMVVVVBBBV...",
  "..BBBBBBBBPMPBBVPMPBBBBBBBB..",
  ".BBBBBBBBBVBBBBBBVVBBBBBBBBB.",
  ".WWWWWWWW.BBBBBBBBB.WWWWWWWW.",
  "...........BBBBBBB...........",
  "............BBBBB............",
  ".............BBB.............",
  "..............W..............",
];

// The gentle pulse changes colour intensity only; the logo geometry never
// jumps, stretches, or morphs into a different character while loading.
const PETAL_PIXEL_FRAMES = [NEXARA_LOGO_FRAME, NEXARA_LOGO_FRAME, NEXARA_LOGO_FRAME];

const PIXEL_COLORS = {
  B: [63, 122, 250],
  P: [151, 50, 239],
  V: [105, 88, 239],
  M: [239, 96, 216],
  W: [250, 249, 245],
};

const ACTIVITY_FRAMES = ["✦", "✧", "❖", "✧", "✦", "⋆", "✧", "·"];

function pixelCell(value, frameIndex = 0) {
  const rgbValue = PIXEL_COLORS[value];
  if (!rgbValue) return "  ";
  const pulse = frameIndex % 3 === 1 ? 1.04 : 1;
  const red = Math.min(255, Math.round(rgbValue[0] * pulse));
  const green = Math.min(255, Math.round(rgbValue[1] * pulse));
  const blue = Math.min(255, Math.round(rgbValue[2] * pulse));
  return `\u001b[48;2;${red};${green};${blue}m  \u001b[0m`;
}

function diagnostic(text) {
  process.stderr.write(`${text}\n`);
}

function activityText(status) {
  if (String(status).startsWith("tool:")) return `Using ${String(status).slice(5)}…`;
  return ({
    waiting: "Processing shared Nexara context…",
    connecting: "Connecting to Nexara…",
    thinking: "Thinking…",
    processing: "Processing shared context…",
    complete: "Done",
  })[status] || String(status || "Working…");
}

function createActivityLine({ quiet = false, streamJson = false } = {}) {
  const startedAt = Date.now();
  let status = "waiting";
  let frame = 0;
  let visible = false;
  let timer = null;
  const machine = (event) => {
    if (streamJson) process.stdout.write(`${JSON.stringify(event)}\n`);
  };
  const render = () => {
    if (quiet || streamJson || !output.isTTY) return;
    visible = true;
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    const glyph = ACTIVITY_FRAMES[frame % ACTIVITY_FRAMES.length];
    const paint = [color.coral, color.violet, color.pink, color.teal][frame % 4];
    output.write(`\r\u001b[2K  ${paint(glyph)} ${color.muted(activityText(status))} ${color.dim(`${seconds}s`)}`);
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
      if (visible && output.isTTY && !streamJson) output.write("\r\u001b[2K");
      visible = false;
    },
    event: machine,
  };
}

const DOUBLE_ESCAPE_WINDOW_MS = 850;

function isEscapeKey(str, key = {}) {
  const name = String(key.name || "").toLowerCase();
  const sequence = key.sequence || str || "";
  return name === "escape" || sequence === "\u001b";
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
      output.write("\r\n\u001b[?25h");
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
  return Math.max(64, Math.min(columns - 2, 140));
}

function clearTerminalForSession() {
  if (!input.isTTY || !output.isTTY || process.env.NEXARA_NO_CLEAR === "1") return;
  // Clear the visible viewport and scrollback so every Nexara session starts
  // as a clean workspace, while leaving the user's shell available on exit.
  output.write("\u001b[3J\u001b[2J\u001b[H");
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
  console.log(`  ${accent("╰")}${accent("─".repeat(width - 2))}${accent("╯")}`);
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

function toolArgumentPreview(name, args = {}) {
  const value = args.command || args.file_path || args.path || args.pattern || args.query || args.url || args.message;
  if (typeof value === "string" && value.trim()) return shorten(value.trim(), Math.max(24, terminalWidth() - 25));
  if (name === "CheckPort" && args.port) return `${args.host || "127.0.0.1"}:${args.port}`;
  if (name === "ask_question") return `${Array.isArray(args.questions) ? args.questions.length : 1} question${Array.isArray(args.questions) && args.questions.length === 1 ? "" : "s"}`;
  return "";
}

function printToolCall(call, { streamJson = false } = {}) {
  const name = String(call?.name || "tool");
  const preview = toolArgumentPreview(name, call?.arguments || {});
  if (streamJson) return;
  console.log(`  ${color.coral("╭─")} ${color.cream(name)} ${color.dim(preview ? `· ${preview}` : "")}`);
}

function printToolResult(name, result, { error = false, streamJson = false } = {}) {
  const text = String(result || "").trim();
  if (streamJson) return;
  const firstLine = text.split(/\r?\n/)[0] || "completed";
  const label = error ? color.red("×") : color.teal("✓");
  console.log(`  ${color.muted("╰─")} ${label} ${color.muted(shorten(firstLine, Math.max(32, terminalWidth() - 12)))}`);
  const detailed = new Set(["Bash", "TypeCheck", "LspDiagnostics", "BackgroundOutput", "GitDiff", "GitStatus", "GitLog", "SymbolSearch", "FindReferences", "CodeOutline", "ImportGraph", "DependencyTree", "DeadCodeScan"]);
  if (detailed.has(String(name)) && text.includes("\n")) {
    const lines = text.split(/\r?\n/).slice(1, 9);
    for (const line of lines) console.log(`     ${color.dim(shorten(line, Math.max(32, terminalWidth() - 9)))}`);
    if (text.split(/\r?\n/).length > 9) console.log(`     ${color.dim("… more output available through /logs or the next tool turn")}`);
  }
}

function outputToolEvent(state, event) {
  if (state.outputFormat !== "stream-json") return;
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function effectivePermissionMode(state) {
  return state.config.permissionMode || "ask";
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

function toolAccessDecision(state, name) {
  if (!isToolConfigured(state, name)) return { action: "deny", reason: "blocked by disallowed-tools" };
  if (!isMutatingTool(name)) return { action: "allow" };
  if (Array.isArray(state.config.allowedTools) && state.config.allowedTools.some((rule) => toolRuleMatches(rule, name))) return { action: "allow" };
  const mode = effectivePermissionMode(state);
  if (mode === "read-only" || mode === "plan") return { action: "deny", reason: permissionModeLabel(mode) };
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
  const answers = [];
  for (const question of questions) {
    console.log();
    console.log(`  ${color.coral("?")} ${color.cream(question.question)}`);
    question.options.forEach((option, index) => {
      const description = option.description ? color.dim(` — ${option.description}`) : "";
      console.log(`    ${color.coral(String(index + 1))} ${color.cream(option.label)}${description}`);
    });
    const answer = (await state.askQuestion(`${color.coral("  ›")} Choose a number or type your answer: `)).trim();
    const selected = answer.split(",").map((item) => item.trim()).filter(Boolean).map((item) => {
      const index = Number(item) - 1;
      return Number.isInteger(index) && question.options[index] ? question.options[index].label : item;
    });
    answers.push(`${question.header}: ${selected.join(", ") || "Continue with best judgment"}`);
  }
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
    if (!current.includes(name)) state.config = saveConfig({ allowedTools: [...current, name] });
    return true;
  }
  return answer === "y" || answer === "yes";
}

async function runClientTool(state, call) {
  const name = String(call?.name || "");
  const args = call?.arguments && typeof call.arguments === "object" ? call.arguments : {};
  if (name === "ask_question") return askTerminalQuestion(state, args);
  const decision = toolAccessDecision(state, name);
  if (decision.action === "deny") {
    const message = `Tool ${name} was denied (${decision.reason}).`;
    printToolResult(name, message, { error: true, streamJson: state.outputFormat === "stream-json" });
    return message;
  }
  const outsidePaths = toolPaths(name, args, state.cwd).filter((value) => value);
  const outsideApprovalRequired = outsidePaths.length > 0 && !state.allowOutsidePaths;
  if (decision.action === "ask" || outsideApprovalRequired) {
    const approved = await requestToolApproval(state, name, args, { outsidePaths });
    if (!approved) {
      const message = `Tool ${name} was denied by the user.`;
      printToolResult(name, message, { error: true, streamJson: state.outputFormat === "stream-json" });
      return message;
    }
    if (outsideApprovalRequired) state.allowOutsidePaths = true;
  }
  try {
    const result = await executeCliTool(name, args, { cwd: state.cwd, allowOutside: outsidePaths.length > 0 });
    printToolResult(name, result, { streamJson: state.outputFormat === "stream-json" });
    return result;
  } catch (error) {
    const message = `Tool ${name} failed: ${error instanceof Error ? error.message : String(error)}`;
    printToolResult(name, message, { error: true, streamJson: state.outputFormat === "stream-json" });
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

function logoPixelLines(frameIndex = 0, { compact = false, label = "" } = {}) {
  const frame = PETAL_PIXEL_FRAMES[frameIndex % PETAL_PIXEL_FRAMES.length];
  const sourceRows = compact ? frame.filter((_, index) => index % 2 === 0) : frame;
  const sourceColumns = compact ? 2 : 1;
  const width = Math.max(...frame.map((line) => line.length));
  const lines = sourceRows.map((line) => {
    const padded = line.padEnd(width, ".");
    const pixels = [];
    for (let index = 0; index < padded.length; index += sourceColumns) {
      pixels.push(pixelCell(padded[index], frameIndex));
    }
    return `  ${pixels.join("")}`;
  });
  if (label) lines.push(`  ${color.muted(label)}`);
  return lines;
}

function mascotPixelLines(frameIndex, label = "") {
  return logoPixelLines(frameIndex, { label });
}

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function animateMascot(label = "Waking up your workspace") {
  if (!input.isTTY || !output.isTTY || process.env.NEXARA_NO_ANIMATION === "1") {
    return;
  }
  const frameLines = mascotPixelLines(0, label);
  const draw = (index) => {
    const lines = mascotPixelLines(index, label);
    // Always redraw from the absolute home position. Relative cursor-up
    // caused the old mascot to push the actual CLI hundreds of rows down.
    output.write("\u001b[H");
    lines.forEach((line, lineIndex) => {
      output.write(`\u001b[2K\r${line}${lineIndex === lines.length - 1 ? "" : "\n"}`);
    });
  };
  output.write("\u001b[?25l");
  for (let index = 0; index < PETAL_PIXEL_FRAMES.length * 3; index += 1) {
    draw(index);
    await pause(120);
  }
  output.write("\u001b[H");
  frameLines.forEach((_, lineIndex) => {
    output.write(`\u001b[2K\r${lineIndex === frameLines.length - 1 ? "" : "\n"}`);
  });
  output.write("\u001b[H\u001b[?25h");
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

async function printBanner(config, user = null) {
  const effort = REASONING_EFFORT_LABELS[config.selectedReasoningEffort] || config.selectedReasoningEffort;
  const account = user?.email || "Nexara account";
  // Keep the logo visible after the loading animation and start the settled
  // interface at the top of the cleared terminal.
  console.log(logoPixelLines(1, { compact: true }).join("\n"));
  console.log(`${color.coral("✦")} ${color.cream("Nexara")} ${color.muted(`v${CURRENT_VERSION}`)}`);
  console.log(`  ${color.cream(modelLabel(config.selectedModel))} ${color.muted("with")} ${color.cream(effort)} ${color.muted(`effort · ${account}`)}`);
  console.log(`  ${color.muted(displayPath())}`);
  console.log();
  await animateText("  A calm terminal for ambitious work.");
  console.log();
  console.log(`  ${color.teal("✓")} ${color.cream("Workspace ready")} ${color.muted("· /status for session details")}`);
  console.log();
  console.log(`  ${color.cream("Keep working from anywhere")}`);
  console.log(`  ${color.muted("Your Nexara threads stay available across the web, desktop, and mobile app.")}`);
  console.log(`  ${color.muted("Use /resume to continue a saved thread · /threads to browse recent work.")}`);
  console.log();
}

function printLoginScreen() {
  console.log();
  printPanel([
    `${color.coral("✦")} ${color.cream("Sign in to Nexara")}`,
    color.muted("Your account, models, and saved threads."),
    "",
    `${color.coral("1")}  ${color.cream("Email and password")}`,
    `${color.coral("2")}  ${color.cream("Continue with Google")}`,
    `${color.coral("3")}  ${color.cream("Scan a QR code")}`,
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

function printUserTurn(text, files = []) {
  console.log();
  console.log(`  ${color.muted("›")} ${color.cream(text)}`);
  if (files.length) {
    console.log(`  ${color.muted("  attachments")} ${files.map((file) => color.coral(file.filename)).join(color.muted(" · "))}`);
  }
}

function printAssistantHeader(state, mode) {
  const modeLabel = mode ? ` · ${mode}` : "";
  process.stdout.write(`\n${color.coral("✦")} ${color.cream("Nexara")} ${color.muted(`· ${modelLabel(state.config.selectedModel)}${modeLabel}`)}\n`);
}

function printSessionFooter(state) {
  const real = lastRealContext(state);
  const ctxUsed = real ?? contextOf(state.messages);
  const ctxWindow = MODEL_CONTEXT.get(state.config.selectedModel) ?? 128_000;
  const percent = Math.min(100, Math.round((ctxUsed / ctxWindow) * 100));
  const thread = state.threadId ? `thread ${state.threadId.slice(0, 8)}` : "new thread";
  const effort = REASONING_EFFORT_LABELS[state.config.selectedReasoningEffort] || state.config.selectedReasoningEffort;
  const width = Math.max(20, terminalWidth() - 2);
  const lines = [
    color.muted(`  ${"─".repeat(width)}`),
    `  ${color.muted(`${effort} · /effort`)} ${color.dim("·")} ${color.cream(modelLabel(state.config.selectedModel))} ${color.muted("· /model to change")}`,
    `  ${color.coral("▸")} ${color.cream("Nexara routing active")} ${color.muted("· /help for shortcuts")}`,
    `  ${color.muted("·")} ${color.muted(`${thread}  ${contextBar(percent)}  ${percent}% context · /compact to free space`)}`,
    color.muted(`  ${"─".repeat(width)}`),
  ];
  process.stdout.write(`\n${lines.join("\n")}\n`);
  return lines.length;
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
    const priceLabel = pricing ? color.dim(` — $${pricing.input}/1M in · $${pricing.output}/1M out`) : "";
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
    const width = Math.max(60, terminalWidth());
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
        const price = pricing ? ` · $${pricing.input}/$${pricing.output} per 1M` : "";
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
  let lines = render();
  output.write(`\u001b[?25l${lines.join("\n")}`);

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value, error = null) => {
      if (settled) return;
      settled = true;
      input.removeListener("keypress", onKeypress);
      input.setRawMode(Boolean(previousRawMode));
      output.write(`\u001b[${lines.length - 1}A${lines.map(() => "\u001b[2K\r").join("\n")}\u001b[?25h\r\n`);
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
      const up = name === "up" || name === "k" || name === "8" || sequence === "\u001b[A" || sequence === "\u001bOA";
      const down = name === "down" || name === "j" || name === "2" || sequence === "\u001b[B" || sequence === "\u001bOB";
      const pageUp = name === "pageup" || sequence === "\u001b[5~";
      const pageDown = name === "pagedown" || sequence === "\u001b[6~";
      const home = name === "home" || sequence === "\u001b[H" || sequence === "\u001b[1~";
      const end = name === "end" || sequence === "\u001b[F" || sequence === "\u001b[4~";
      if (key.ctrl && name === "c") { finish(null, new Error("Aborted with Ctrl+C")); return; }
      if (isEscapeKey(str, key)) { finish(null); return; }
      if (up) { move(-1); return; }
      if (down) { move(1); return; }
      if (pageUp) { move(-viewport); return; }
      if (pageDown) { move(viewport); return; }
      if (home) { activeModel = 0; redraw(); return; }
      if (end) { activeModel = modelIndices.length - 1; redraw(); return; }
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

function renderSlashSuggestions(line, activeIndex = 0) {
  const matches = slashSuggestionMatches(line);
  if (!matches.length) return [];
  const limit = Math.max(3, Math.min(5, pickerTerminalHeight() - 14));
  const bounded = Math.max(0, Math.min(matches.length - 1, activeIndex));
  const start = Math.max(0, Math.min(bounded - limit + 1, matches.length - limit));
  const visible = matches.slice(start, start + limit);
  const commandWidth = 22;
  const rows = visible.map((entry, offset) => {
    const active = start + offset === bounded;
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
  /new                          Start a fresh saved conversation
  /resume [thread-id]           Resume the last or a selected conversation
  /threads                      List recent saved conversations
  /clear                        Clear local context and create a fresh thread
  /compact                      Summarize the conversation to free the context window
  /permissions [mode]           Set read-only, plan, edits, commands, auto, or full access
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
  /config                       Show the local config path
  /update                       Check for and install updates (when auto-update is off)
  /status                       Show account, model, and thread state
  /login                        Sign in again or switch account
  /quit                         Exit the CLI

${color.dim("Voice: press M at the prompt to record your mic; press M again to")}
${color.dim("stop and transcribe your words into the input (speech-to-text).")}
${color.dim("Tip: type / and press Tab to autocomplete commands; use ↑/↓ or numpad arrows to browse history.")}

${color.dim("Login options: nexara login, nexara login --google, nexara login --qr")}
${color.dim("Updates: nexara update (install now), nexara update --on / --off (toggle silent background updates)")}
${color.dim("Outside the REPL: nexara \"prompt\", --print, --output-format json|stream-json, --max-turns N, --max-budget USD")}
${color.dim("Automation flags: --allowed-tools A,B · --disallowed-tools A,B · --permission-mode read-only|plan|allow-edits|allow-commands|auto|full · --no-session-persistence")}
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
      options.maxBudget = Number(requiredValue(i, arg, "a dollar amount"));
      if (!Number.isFinite(options.maxBudget) || options.maxBudget <= 0) throw new Error("--max-budget must be greater than zero.");
      i += 1;
    } else if (arg === "--allowed-tools") {
      options.allowedTools = requiredValue(i, arg, "a comma-separated tool list").split(",").map((value) => value.trim()).filter(Boolean);
      i += 1;
    } else if (arg === "--disallowed-tools") {
      options.disallowedTools = requiredValue(i, arg, "a comma-separated tool list").split(",").map((value) => value.trim()).filter(Boolean);
      i += 1;
    } else if (arg === "--permission-mode") {
      options.permissionMode = requiredValue(i, arg, "read-only, plan, allow-edits, allow-commands, auto, or full").toLowerCase();
      if (!["ask", "read-only", "plan", "allow-edits", "allow-commands", "auto", "full"].includes(options.permissionMode)) throw new Error("Unknown permission mode.");
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
  return { filename: path.basename(resolved), mediaType, dataUrl: `data:${mediaType};base64,${data.toString("base64")}` };
}

async function requireLogin(auth, config) {
  const token = await auth.accessToken();
  if (!token) {
    throw new Error("Sign in first with `nexara login`. Your CLI uses the same Nexara account and shared limits as the website.");
  }
  return config;
}

async function completeGoogleProfile(auth, user) {
  const rl = readline.createInterface({ input, output });
  try {
    const name = (await rl.question(`Name${user.user_metadata?.full_name ? ` [${user.user_metadata.full_name}]` : ""}: `)).trim() || user.user_metadata?.full_name || "";
    const email = (await rl.question(`Email [${user.email || ""}]: `)).trim() || user.email || "";
    const password = await rl.question("Password (at least 6 characters): ", { hideEchoBack: true });
    const confirmPassword = await rl.question("Confirm password: ", { hideEchoBack: true });
    if (!name || !email || password.length < 6 || password !== confirmPassword) {
      throw new Error("Name, email, and matching passwords (at least 6 characters) are required.");
    }
    await auth.completeProfile({ name, email, password });
  } finally {
    rl.close();
  }
}

async function login(config, auth, useGoogle = false, useQr = false) {
  if (!useGoogle && !useQr) {
    printLoginScreen();
    const methodRl = readline.createInterface({ input, output });
    let selectedGoogle = false;
    let selectedQr = false;
    try {
      const method = (await methodRl.question(`  ${color.cyan("How would you like to sign in?")} ${color.dim("[1] Email  [2] Google  [3] QR")}\n  › `)).trim().toLowerCase();
      selectedGoogle = method === "2" || method === "g" || method === "google";
      selectedQr = method === "3" || method === "q" || method === "qr";
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
    const providers = Array.isArray(user.app_metadata?.providers) ? user.app_metadata.providers : [];
    if (providers.includes("google") && !providers.includes("email") && !user.user_metadata?.nexara_profile_complete) {
      await completeGoogleProfile(auth, user);
    }
    console.log(color.green(`Signed in as ${user.email || "your Google account"}.`));
    return;
  }
  const rl = readline.createInterface({ input, output });
  try {
    const email = (await rl.question(`  ${color.cyan("Email")} › `)).trim();
    const password = await rl.question(`  ${color.cyan("Password")} › `, { hideEchoBack: true });
    const user = await auth.login(email, password);
    console.log(color.green(`\n  ✓ Signed in as ${user.email || email}.`));
  } finally {
    rl.close();
  }
}

async function ensureSignedIn(config, auth, useGoogle = false, useQr = false) {
  if (await auth.accessToken()) return;
  console.log(color.cyan("You are not signed in. Sign in to Nexara to continue."));
  await login(config, auth, useGoogle, useQr);
}

async function ensureThread(state) {
  if (state.threadId) return;
  const thread = await createThread(state.auth);
  state.threadId = thread.id;
  state.messages = [];
  if (!state.config.noSessionPersistence) state.config = saveConfig({ lastThreadId: thread.id });
}

function usageCost(model, usage) {
  const pricing = MODEL_PRICING.get(model);
  if (!pricing || !usage) return 0;
  return ((Number(usage.inputTokens) || 0) * pricing.input + (Number(usage.outputTokens) || 0) * pricing.output) / 1_000_000;
}

async function runPrompt(state, text, { mode, goal, files = [] } = {}) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  state.cwd ||= process.cwd();
  state.spentCredits ||= 0;
  state.maxTurns ||= state.config.maxTurns || 25;
  state.maxBudget ??= state.config.maxBudget;
  await ensureThread(state);
  const message = userMessage(trimmed, files);
  const machine = state.outputFormat === "stream-json";
  const quiet = Boolean(state.quiet || state.outputFormat === "json" || machine);
  if (!quiet) {
    printUserTurn(trimmed, files);
    printAssistantHeader(state, mode);
  }
  const conversation = [...state.messages, message];
  const maxTurns = Math.max(1, Math.min(100, Number(state.maxTurns ?? state.config.maxTurns ?? 25)));
  let lastAssistant = null;
  for (let turn = 1; turn <= maxTurns; turn += 1) {
    if (state.maxBudget && state.spentCredits >= state.maxBudget) {
      const messageText = `Stopped before another model turn because the $${state.maxBudget.toFixed(2)} session budget was reached.`;
      if (!quiet) notice(messageText, "amber");
      outputToolEvent(state, { type: "budget-stop", message: messageText });
      break;
    }
    const activity = createActivityLine({ quiet, streamJson: machine });
    const serverArtifacts = [];
    const controller = new AbortController();
    const previousCancel = state.cancelCurrent;
    const cancel = () => controller.abort();
    state.cancelCurrent = cancel;
    const writeText = (delta) => {
      activity.clear();
      if (machine) outputToolEvent(state, { type: "text-delta", delta });
      else if (state.outputFormat !== "json") process.stdout.write(delta);
    };
    let assistant;
    try {
      assistant = await sendChat({
        auth: state.auth,
        appUrl: state.config.appUrl,
        threadId: state.threadId,
        messages: conversation,
        model: state.config.selectedModel,
        reasoningEffort: state.config.selectedReasoningEffort,
        mode,
        goal,
        quiet,
        signal: controller.signal,
        onStatus: (status) => {
          activity.set(status);
          if (!quiet && status === "processing") diagnostic(`  ${color.dim("· Syncing shared Nexara context…")}`);
        },
        onText: writeText,
        onToolCall: (call) => {
          activity.clear();
          printToolCall(call, { streamJson: machine });
          outputToolEvent(state, { type: "tool-call", name: call.name, input: call.arguments, toolCallId: call.toolCallId });
        },
        onToolResult: (result) => {
          serverArtifacts.push(result);
          if (!quiet && result.name !== "create_pdf" && result.name !== "create_image" && result.name !== "edit_image") {
            printToolResult(result.name, result.output);
          }
          outputToolEvent(state, { type: "tool-result", name: result.name, output: result.output });
        },
        onSource: (source) => outputToolEvent(state, { type: "source", source }),
        onFinish: (event) => {
          const metadata = event.metadata || event.messageMetadata || {};
          outputToolEvent(state, { type: "finish", model: metadata.model || null, usage: metadata.usage || null });
        },
      });
    } catch (error) {
      activity.clear();
      if (error?.name === "AbortError") {
        const messageText = "Generation cancelled.";
        if (!quiet) notice(messageText, "amber");
        outputToolEvent(state, { type: "cancelled", message: messageText });
        return null;
      }
      throw error;
    } finally {
      if (state.cancelCurrent === cancel) state.cancelCurrent = previousCancel || null;
    }
    activity.clear();
    lastAssistant = assistant;
    if (assistant.usage) {
      state.lastUsage = assistant.usage;
      state.spentCredits += usageCost(assistant.model || state.config.selectedModel, assistant.usage);
    }
    for (const artifact of serverArtifacts) {
      const saved = await saveServerArtifact(state, artifact.name, artifact.output).catch(() => null);
      if (saved) {
        const messageText = `Saved ${artifact.name} output to ${path.relative(state.cwd, saved) || saved}.`;
        if (!quiet) notice(messageText);
        outputToolEvent(state, { type: "artifact", name: artifact.name, path: saved });
      }
    }
    if (!quiet && assistant.sources?.length) {
      console.log(`  ${color.muted("Sources")} ${assistant.sources.map((source) => color.cyan(typeof source === "string" ? source : source.url || source.title || "source")).join(color.muted(" · "))}`);
    }
    const call = assistant.nativeCall;
    if (!call || !CLI_LOCAL_TOOL_NAMES.has(call.name) && call.name !== "ask_question") {
      conversation.push(assistant);
      break;
    }
    conversation.push(assistant);
    const resultText = await runClientTool(state, call);
    outputToolEvent(state, { type: "tool-result", name: call.name, output: resultText, toolCallId: call.toolCallId });
    conversation.push(userMessage(`<tool_result name="${call.name}">\n${resultText}\n</tool_result>`));
    if (state.outputFormat === "json") continue;
  }
  if (!lastAssistant) return null;
  if (lastAssistant.nativeCall) {
    const messageText = `Paused after ${maxTurns} model turn${maxTurns === 1 ? "" : "s"} with ${lastAssistant.nativeCall.name} still pending. Raise --max-turns to continue.`;
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
  state.pendingImages = [];
  // The interactive REPL owns the transient footer. Keeping it out of the
  // turn renderer means the transcript can remain one continuous top-to-
  // bottom conversation instead of starting a new block below /effort.
  if (!quiet && !state.interactive) printSessionFooter(state);
  if (state.outputFormat === "json") {
    process.stdout.write(`${JSON.stringify({ text: lastAssistant.text, model: lastAssistant.model || state.config.selectedModel, usage: lastAssistant.usage, threadId: state.threadId })}\n`);
  }
  return lastAssistant;
}

async function continueGoal(state, goal) {
  const maxTurns = 25;
  for (let turn = 1; turn <= maxTurns; turn += 1) {
    const result = await runPrompt(state, turn === 1 ? goal : "Continue.", { mode: "goal", goal });
    const text = typeof result === "string" ? result : result?.text || "";
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
        const choice = await selectModelInteractive(state.config.selectedModel);
        if (!choice?.model) return true;
        if (choice.sessionOnly) {
          state.config = { ...state.config, selectedModel: choice.model };
          notice(`Using ${color.cream(modelLabel(choice.model))} for this session only.`);
        } else {
          state.config = saveConfig({ selectedModel: choice.model });
          notice(`Default model set to ${color.cream(modelLabel(choice.model))}.`);
        }
        return true;
      }
      const model = resolveModel(argument);
      if (!model) { console.log(color.red(`No exact model match for “${argument}”.`)); printModels(state.config.selectedModel, argument); return true; }
      state.config = saveConfig({ selectedModel: model });
      notice(`Model switched to ${color.cream(modelLabel(model))}.`);
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
      state.config = saveConfig({ selectedReasoningEffort: value });
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
      state.pendingImages.push(file);
      notice(`Attached ${color.cream(file.filename)} · it will be sent with your next prompt.`);
      return true;
    }
    case "/new":
    case "/clear":
      state.threadId = null;
      state.messages = [];
      state.pendingImages = [];
      state.config = saveConfig({ lastThreadId: null });
      notice("Started a fresh conversation.");
      return true;
    case "/resume": {
      const id = argument || state.config.lastThreadId;
      if (!id) { console.log("No saved conversation to resume."); return true; }
      const loaded = await loadThread(state.auth, id);
      state.threadId = loaded.thread.id;
      state.messages = loaded.messages;
      state.config = saveConfig({ lastThreadId: state.threadId });
      notice(`Resumed ${color.cream(loaded.thread.title)} · ${color.muted(state.threadId)}`);
      return true;
    }
    case "/threads": {
      const threads = await listThreads(state.auth);
      if (!threads.length) console.log("No saved conversations.");
      for (const thread of threads) console.log(`${thread.id}  ${thread.title}`);
      return true;
    }
    case "/compact": {
      if (state.messages.length < 2) {
        console.log(color.yellow("Conversation is too short to compact."));
        return true;
      }
      if (!state.threadId) {
        if (state.messages.length > 12) state.messages = state.messages.slice(-12);
        console.log(color.green(`Local context compacted to ${state.messages.length} messages.`));
        return true;
      }
      try {
        const token = await state.auth.accessToken();
        const response = await fetch(`${state.config.appUrl.replace(/\/+$/, "")}/api/compact`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ threadId: state.threadId, model: state.config.selectedModel }),
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
    case "/permissions": {
      const modes = ["ask", "read-only", "plan", "allow-edits", "allow-commands", "auto", "full"];
      if (!argument) {
        console.log(`Permission mode: ${color.cream(permissionModeLabel(effectivePermissionMode(state)))}`);
        console.log(color.dim(`  Modes: ${modes.join(" · ")}`));
        return true;
      }
      const mode = argument.toLowerCase();
      if (!modes.includes(mode)) {
        console.log(color.red(`Unknown permission mode. Choose: ${modes.join(", ")}.`));
        return true;
      }
      state.config = saveConfig({ permissionMode: mode });
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
    case "/agents":
    case "/background":
    case "/tasks": {
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
    case "/config": console.log(`Config: ${state.configPath}`); return true;
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
  const state = existingState || { config, auth, configPath, threadId: null, messages: [], pendingImages: [], quiet: false };
  state.cwd ||= process.cwd();
  state.outputFormat ||= "text";
  state.interactive = true;
  state.maxTurns ||= state.config.maxTurns || 25;
  state.maxBudget ??= state.config.maxBudget;
  state.spentCredits ||= 0;
  await printBanner(config, await auth.user());
  const rl = readline.createInterface({
    input,
    output,
    prompt: color.coral("> "),
    // The CLI draws its own live, described completion strip. Returning no
    // readline completions prevents Node's default multi-line dump from
    // fighting that renderer when Tab is pressed.
    completer: (line) => [[], line],
    crlfDelay: Infinity,
    terminal: Boolean(input.isTTY && output.isTTY),
  });
  state.askApproval = async (message) => rl.question(`\n  ${color.amber("! Approval required")}\n    ${message}`);
  state.askQuestion = async (message) => rl.question(message);

  // Push-to-talk: press M at the prompt to start recording, press M again to
  // stop and transcribe. The transcript is appended to the current line.
  let mic = null;
  let voiceBusy = false;
  let voiceHintShown = false;
  // rl.write() re-emits keypress events for every character it inserts, so
  // ignore 'M' for a beat after appending a transcript.
  const ignoreKeypressUntil = { current: 0 };

  // The status strip is a composer footer, not part of the conversation.
  // Keep its height so a submitted line can remove it before the next turn
  // is committed, leaving the transcript growing down from the top.
  let composerFooterLines = 0;
  let slashSuggestionLines = 0;
  let slashSuggestionIndex = 0;
  let slashSuggestionTimer = null;

  function cancelSlashSuggestionTimer() {
    if (slashSuggestionTimer) clearImmediate(slashSuggestionTimer);
    slashSuggestionTimer = null;
  }

  function clearComposerFooter() {
    if (!composerFooterLines || !output.isTTY) return;
    // After readline accepts a line, the cursor is one row below the prompt.
    // Move to the top of the footer and erase through the old prompt.
    output.write(`\u001b[${composerFooterLines + 1}A\u001b[J`);
    composerFooterLines = 0;
  }

  function renderComposerFooter() {
    composerFooterLines = printSessionFooter(state);
  }

  function clearSlashSuggestions(afterSubmit = false) {
    cancelSlashSuggestionTimer();
    if (!slashSuggestionLines || !output.isTTY) {
      slashSuggestionLines = 0;
      slashSuggestionIndex = 0;
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
    slashSuggestionIndex = 0;
  }

  function drawSlashSuggestions() {
    slashSuggestionTimer = null;
    if (state.modalOpen || !output.isTTY) return;
    const rows = renderSlashSuggestions(rl.line, slashSuggestionIndex);
    if (slashSuggestionLines) clearSlashSuggestions();
    if (!rows.length) return;
    const cursor = typeof rl.getCursorPos === "function" ? rl.getCursorPos() : { cols: 2 };
    output.write(`\r\u001b[${rows.length}L${rows.join("\n")}\n\r\u001b[${Math.max(0, Number(cursor.cols) || 0)}C`);
    slashSuggestionLines = rows.length;
  }

  function scheduleSlashSuggestions() {
    if (!output.isTTY || state.modalOpen || slashSuggestionTimer) return;
    slashSuggestionTimer = setImmediate(drawSlashSuggestions);
  }

  function fillSlashSuggestion() {
    const matches = slashSuggestionMatches(rl.line);
    if (!matches.length) return;
    const choice = matches[Math.max(0, Math.min(matches.length - 1, slashSuggestionIndex))];
    rl.write(null, { ctrl: true, name: "u" });
    rl.write(`${choice.command} `);
    slashSuggestionIndex = 0;
    scheduleSlashSuggestions();
  }

  async function transcribeVoice() {
    const recorder = mic;
    mic = null;
    diagnostic("Transcribing…");
    let filePath = null;
    try {
      filePath = await recorder.stop();
      if (!filePath) {
        if (!voiceHintShown) diagnostic(color.yellow("No audio captured. Try again."));
        return;
      }
      const token = await state.auth.accessToken();
      if (!token) {
        diagnostic(color.red("Your session expired. Run `nexara login` again."));
        return;
      }
      const text = await transcribeAudio({ appUrl: state.config.appUrl, token, filePath });
      if (text) {
        ignoreKeypressUntil.current = Date.now() + 400;
        if (!rl.closed) rl.write(` ${text}`);
      } else {
        diagnostic(color.yellow("No speech detected. Try again."));
      }
    } catch (error) {
      diagnostic(color.red(error instanceof Error ? error.message : String(error)));
    } finally {
      voiceBusy = false;
      if (filePath) await fs.rm(filePath, { force: true }).catch(() => {});
    }
  }

  async function toggleVoice() {
    if (voiceBusy) return;
    if (mic) {
      voiceBusy = true;
      await transcribeVoice();
    } else {
      diagnostic("🎙  Recording… press M again to stop and transcribe");
      try {
        mic = await startMicRecording({
          onStatus: () => diagnostic("🎙  Recording… press M again to stop"),
          onError: (message) => {
            voiceHintShown = true;
            diagnostic(color.red(message));
          },
        });
      } catch (error) {
        diagnostic(color.red(error instanceof Error ? error.message : String(error)));
      }
    }
  }

  const onKeypress = (str, key) => {
    if (state.modalOpen) return;
    if (key?.ctrl && key.name === "c") {
      if (state.cancelCurrent) state.cancelCurrent();
      return;
    }
    if (!key || key.name !== "m" || key.ctrl || key.meta || key.alt || key.shift) return;
    if (Date.now() < ignoreKeypressUntil.current) return;
    // M is push-to-talk only on an otherwise-empty prompt. Previously this
    // listener fired for the m in `/model`, which erased the character and
    // launched the microphone instead of allowing the command to be typed.
    const currentLine = typeof rl.line === "string" ? rl.line : "";
    if (currentLine !== "" && currentLine !== "m" && currentLine !== "M") return;
    // readline already inserted the 'm' into the line — erase it when the
    // cursor is at the end, then toggle recording.
    if (currentLine === "m" || currentLine === "M") rl.write("\b \b");
    void toggleVoice();
  };

  const onSlashKeypress = (str, key = {}) => {
    if (state.modalOpen || key.ctrl || key.meta || key.alt) return;
    const name = String(key.name || "").toLowerCase();
    if (name === "return" || name === "enter" || name === "escape") return;
    if (name === "tab") {
      setImmediate(fillSlashSuggestion);
      return;
    }
    if (name === "up" && slashSuggestionMatches(rl.line).length) {
      slashSuggestionIndex = Math.max(0, slashSuggestionIndex - 1);
    } else if (name === "down" && slashSuggestionMatches(rl.line).length) {
      slashSuggestionIndex = Math.min(slashSuggestionMatches(rl.line).length - 1, slashSuggestionIndex + 1);
    }
    scheduleSlashSuggestions();
  };

  input.on("keypress", onKeypress);
  input.on("keypress", onSlashKeypress);
  rl.prompt();
  try {
    for await (const raw of rl) {
      const line = raw.trim();
      if (!line) {
        clearSlashSuggestions(true);
        clearComposerFooter();
        if (composerFooterLines === 0 && state.messages.length) renderComposerFooter();
        rl.prompt();
        continue;
      }
      clearSlashSuggestions(true);
      clearComposerFooter();
      let keepGoing = true;
      try {
        if (line.startsWith("/")) {
          state.modalOpen = true;
          try {
            keepGoing = await handleSlash(state, line);
          } finally {
            state.modalOpen = false;
          }
        } else {
          await runPrompt(state, line, { files: state.pendingImages });
        }
      } catch (error) {
        console.log(color.red(error instanceof Error ? error.message : String(error)));
      }
      if (!keepGoing) break;
      renderComposerFooter();
      rl.prompt();
    }
  } finally {
    input.removeListener("keypress", onKeypress);
    input.removeListener("keypress", onSlashKeypress);
    cancelSlashSuggestionTimer();
    clearSlashSuggestions(true);
    if (mic) await mic.stop().catch(() => {});
    clearBackgroundProcesses();
    rl.close();
  }
}

async function readPipedInput() {
  let value = "";
  for await (const chunk of process.stdin) value += chunk;
  return value.trim();
}

async function oneShot(config, auth, options, configPath) {
  await requireLogin(auth, config);
  const prompt = options.prompt.join(" ") || (!process.stdin.isTTY ? await readPipedInput() : "");
  if (!prompt) throw new Error("Provide a prompt, e.g. `nexara -p \"Summarize this\"`, or pipe input.");
  const images = await Promise.all(options.images.map(readImage));
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
    pendingImages: images,
    quiet: Boolean(options.print),
    outputFormat: options.outputFormat,
    maxTurns: options.maxTurns || config.maxTurns || 25,
    maxBudget: options.maxBudget || config.maxBudget || null,
    spentCredits: 0,
    askApproval: async () => "n",
    askQuestion: async () => "",
  };
  if (options.continue) {
    const id = config.lastThreadId;
    if (!id) throw new Error("No previous thread to continue.");
    const loaded = await loadThread(auth, id);
    state.threadId = loaded.thread.id;
    state.messages = loaded.messages;
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
  const command = options.prompt[0];
  if (command === "login" && options.prompt.length === 1) { await login(nextConfig, auth, options.google, options.qr); return; }
  if (command === "logout" && options.prompt.length === 1) { await auth.logout(); console.log("Signed out."); return; }
  if (command === "update" && options.prompt.length === 1) {
    await runUpdateCommand(options.updateMode ? [`--${options.updateMode}`] : []);
    return;
  }
  if (command === "whoami" && options.prompt.length === 1) { const user = await auth.user(); console.log(user?.email || "Not signed in."); return; }
  const startsInteractive = !(options.print || options.prompt.length > 0 || options.images.length > 0 || (options.continue && options.prompt.length > 0));
  if (startsInteractive || (command === "login" && options.prompt.length === 1)) clearTerminalForSession();
  if (startsInteractive) await animateMascot();
  if (!startsInteractive) {
    await ensureSignedIn(nextConfig, auth, options.google, options.qr);
    await oneShot(nextConfig, auth, { ...options, prompt: options.prompt[0] === "login" ? [] : options.prompt }, configPath);
    return;
  }
  if (!(await confirmWorkspace(nextConfig))) return;
  await ensureSignedIn(nextConfig, auth, options.google, options.qr);
  if (options.continue) {
    const state = { config: nextConfig, auth, configPath, threadId: null, messages: [], pendingImages: [], quiet: false };
    const id = nextConfig.lastThreadId;
    if (!id) throw new Error("No previous thread to continue.");
    const loaded = await loadThread(auth, id);
    state.threadId = loaded.thread.id;
    state.messages = loaded.messages;
    await interactive(nextConfig, auth, configPath, state);
    return;
  }
  await interactive(nextConfig, auth, configPath);
  } finally {
    removeEscapeExit();
  }
}
