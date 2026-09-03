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
  "/compact", "/config", "/login", "/update", "/status", "/quit", "/exit",
];

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
const PETAL_FRAMES = [
  [
    "       ·✦·       ",
    "     ╱╲ ╱╲       ",
    "  ◢██◤ ◥██◣     ",
    " ◥██◣  ✧  ◢██◤  ",
    "   ◥███◣███◤     ",
    "      ◥◤         ",
  ],
  [
    "        ✦        ",
    "      ╱╲         ",
    "  ◢██◤  ◥██◣     ",
    " ◥██◣  ✧  ◢██◤  ",
    "   ◥███████◤     ",
    "       ◥◤        ",
  ],
  [
    "      ·✦·        ",
    "       ╲╱        ",
    " ◢██◣     ◢██◣  ",
    "◥██◤  ◉ ◉  ◥██◤ ",
    "  ◥███ ᴗ ███◤    ",
    "       ◥◤        ",
  ],
  [
    "       ✦         ",
    "     ╱╲ ╱╲       ",
    "  ◢██◤ ◥██◣     ",
    " ◥██◣  ◉  ◢██◤  ",
    "   ◥███ᴗ███◤     ",
    "      ◥◤         ",
  ],
  [
    "      ·✦·        ",
    "       ╲╱        ",
    " ◢██◣     ◢██◣  ",
    "◥██◤  ◉ ◉  ◥██◤ ",
    "  ◥███ ᴗ ███◤    ",
    "        ·         ",
  ],
  [
    "        ✦        ",
    "      ╱╲         ",
    "  ◢██◤  ◥██◣     ",
    " ◥██◣  ✧  ◢██◤  ",
    "   ◥███████◤     ",
    "       ◥◤        ",
  ],
];

function diagnostic(text) {
  process.stderr.write(`${text}\n`);
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
  return Math.max(54, Math.min(columns - 4, 94));
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

function petalLine(line, frame) {
  const painted = frame % 3 === 0 ? color.violet(line) : frame % 3 === 1 ? color.coral(line) : color.pink(line);
  return `  ${painted}`;
}

function mascotFrame(frameIndex, label = "") {
  const frame = PETAL_FRAMES[frameIndex % PETAL_FRAMES.length];
  return [...frame.map((line) => petalLine(line, frameIndex)), label ? `  ${color.muted(label)}` : ""];
}

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function animateMascot(label = "Waking up your workspace") {
  if (!input.isTTY || !output.isTTY || process.env.NEXARA_NO_ANIMATION === "1") {
    return;
  }
  const frameLines = mascotFrame(0, label);
  output.write("\u001b[?25l");
  for (let index = 0; index < 9; index += 1) {
    if (index > 0) output.write(`\u001b[${frameLines.length - 1}A`);
    const lines = mascotFrame(index, label);
    output.write(lines.map((line) => `\u001b[2K${line}`).join("\n"));
    await pause(85);
  }
  output.write(`\u001b[${frameLines.length - 1}A`);
  output.write(frameLines.map(() => "\u001b[2K").join("\n"));
  output.write("\u001b[?25h\n");
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
  console.log();
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
  console.log(color.muted(`  ${"─".repeat(Math.max(20, terminalWidth() - 2))}`));
  console.log(`  ${color.muted(`${effort} · /effort`)} `);
  console.log(color.muted(`  ${"─".repeat(Math.max(20, terminalWidth() - 2))}`));
  console.log(`  ${color.coral("▸")} ${color.cream("Nexara routing active")} ${color.muted("(/model to change)")} ${color.dim("· /help for shortcuts")}`);
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
    lines.push(color.dim("  ↑/↓ or numpad 8/2 to move · Enter to select · Esc to cancel"));
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
      if (name === "escape" || sequence === "\u001b") {
        finish(false);
        return;
      }
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

function printAssistantHeader(state, mode) {
  const modeLabel = mode ? ` · ${mode}` : "";
  process.stdout.write(`\n${color.coral("╭─")} ${color.cream("Nexara")} ${color.muted(`${modelLabel(state.config.selectedModel)}${modeLabel}`)}\n`);
}

function printSessionFooter(state) {
  const real = lastRealContext(state);
  const ctxUsed = real ?? contextOf(state.messages);
  const ctxWindow = MODEL_CONTEXT.get(state.config.selectedModel) ?? 128_000;
  const percent = Math.min(100, Math.round((ctxUsed / ctxWindow) * 100));
  const thread = state.threadId ? `thread ${state.threadId.slice(0, 8)}` : "new thread";
  process.stdout.write(`\n${color.coral("╰─")} ${color.muted(`${thread}  ${contextBar(percent)}  ${percent}% context · /compact to free space`)}\n\n`);
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

function slashCompleter(line) {
  if (!line.startsWith("/")) return [[], line];
  const matches = SLASH_COMMANDS.filter((command) => command.startsWith(line.toLowerCase()));
  return [matches.length ? matches : SLASH_COMMANDS, line];
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
  /config                       Show the local config path
  /update                       Check for and install updates (when auto-update is off)
  /status                       Show account, model, and thread state
  /login                        Sign in again or switch account
  /quit                         Exit the CLI

${color.dim("Voice: press M at the prompt to record your mic; press M again to")}
${color.dim("stop and transcribe your words into the input (speech-to-text).")}
${color.dim("Tip: type / and press Tab to autocomplete commands; use /model <name> to search models.")}

${color.dim("Login options: nexara login, nexara login --google, nexara login --qr")}
${color.dim("Updates: nexara update (install now), nexara update --on / --off (toggle silent background updates)")}
${color.dim("Outside the REPL, use: nexara \"prompt\", nexara -p \"prompt\", --image file.png, --model deepseek-v4-flash, --effort high, --continue")}
`);
}function parseArgs(argv) {
  const options = { prompt: [], images: [], print: false, continue: false, google: false, qr: false, help: false, version: false, updateMode: null };
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
  state.config = saveConfig({ lastThreadId: thread.id });
}

async function runPrompt(state, text, { mode, goal, files = [] } = {}) {
  const trimmed = text.trim();
  if (!trimmed) return;
  await ensureThread(state);
  const message = userMessage(trimmed, files);
  const quiet = Boolean(state.quiet);
  let lastActivity = "";
  if (!quiet) {
    printAssistantHeader(state, mode);
  }
  const assistant = await sendChat({
    auth: state.auth,
    appUrl: state.config.appUrl,
    threadId: state.threadId,
    messages: [...state.messages, message],
    model: state.config.selectedModel,
    reasoningEffort: state.config.selectedReasoningEffort,
    mode,
    goal,
    quiet,
    onStatus: quiet ? undefined : (status) => {
      if (status === lastActivity) return;
      lastActivity = status;
      diagnostic(`${color.coral("  ·")} ${color.muted(status === "thinking" ? "Thinking through it…" : "Using a tool…")}`);
    },
    onText: quiet ? (text) => process.stdout.write(text) : undefined,
  });
  if (assistant.compacted && assistant.summary) {
    // The server auto-compacted the oldest messages to fit the model's
    // context window — keep the summary plus this exchange, drop the rest.
    const summaryMessage = {
      id: `auto-compacted-${assistant.id}`,
      role: "user",
      parts: [
        {
          type: "text",
          text: `📌 This conversation was auto-compacted to fit the model's context window. Summary of what we discussed before:\n\n${assistant.summary}\n\nContinue from here — you can ask about anything in the summary.`,
        },
      ],
    };
    state.messages = [summaryMessage, message, assistant];
    if (!quiet) console.log(color.yellow("\n[auto-compacted to fit the model's context window]"));
  } else {
    state.messages.push(message, assistant);
  }
  state.pendingImages = [];
  if (assistant.usage) state.lastUsage = assistant.usage;
  if (!quiet) {
    printSessionFooter(state);
  }
  return assistant.text;
}

async function continueGoal(state, goal) {
  const maxTurns = 25;
  for (let turn = 1; turn <= maxTurns; turn += 1) {
    const text = await runPrompt(state, turn === 1 ? goal : "Continue.", { mode: "goal", goal });
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
        console.log(`\n${color.cyan("Current model")}  ${modelLabel(state.config.selectedModel)}`);
        console.log(color.dim("  Use /model <name> to switch, or /models to browse every model."));
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
  await printBanner(config, await auth.user());
  const rl = readline.createInterface({
    input,
    output,
    prompt: color.coral("╰─› "),
    completer: slashCompleter,
    crlfDelay: Infinity,
    terminal: Boolean(input.isTTY && output.isTTY),
  });

  // Push-to-talk: press M at the prompt to start recording, press M again to
  // stop and transcribe. The transcript is appended to the current line.
  let mic = null;
  let voiceBusy = false;
  let voiceHintShown = false;
  // rl.write() re-emits keypress events for every character it inserts, so
  // ignore 'M' for a beat after appending a transcript.
  const ignoreKeypressUntil = { current: 0 };

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
    if (!key || key.name !== "m" || key.ctrl || key.meta || key.alt || key.shift) return;
    if (Date.now() < ignoreKeypressUntil.current) return;
    // readline already inserted the 'm' into the line — erase it when the
    // cursor is at the end, then toggle recording.
    if (str === "m" || str === "M") rl.write("\b \b");
    void toggleVoice();
  };

  input.on("keypress", onKeypress);
  rl.prompt();
  try {
    for await (const raw of rl) {
      const line = raw.trim();
      if (!line) { rl.prompt(); continue; }
      try {
        if (line.startsWith("/")) {
          const keepGoing = await handleSlash(state, line);
          if (!keepGoing) break;
        } else {
          await runPrompt(state, line, { files: state.pendingImages });
        }
      } catch (error) {
        console.log(color.red(error instanceof Error ? error.message : String(error)));
      }
      rl.prompt();
    }
  } finally {
    input.removeListener("keypress", onKeypress);
    if (mic) await mic.stop().catch(() => {});
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
  const state = { config, auth, configPath, threadId: null, messages: [], pendingImages: images, quiet: Boolean(options.print) };
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
}
