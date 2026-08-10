import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { createAuth } from "./auth.js";
import { createThread, listThreads, loadThread, sendChat, transcribeAudio, userMessage } from "./api.js";
import { loadConfig, saveConfig } from "./config.js";
import { startMicRecording } from "./mic.js";
import { printQr } from "./qr.js";
import { CURRENT_VERSION, scheduleAutoUpdate } from "./update.js";

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
  ["mistralai/ministral-8b", 128_000],
  ["mistralai/ministral-14b", 128_000],
  ["mistralai/devstral-medium", 128_000],
  ["mistralai/codestral-2508", 256_000],
  ["mistralai/mistral-small-2603", 128_000],
  ["mistralai/mistral-medium-3.5", 128_000],
  ["mistralai/mistral-large-2512", 128_000],
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
  ["z-ai/glm-4.5-air", 128_000],
  ["z-ai/glm-4.5", 128_000],
  ["z-ai/glm-4.6", 200_000],
  ["z-ai/glm-4.7", 200_000],
  ["z-ai/glm-5", 200_000],
  ["z-ai/glm-5-turbo", 202_752],
  ["z-ai/glm-5.1", 200_000],
  ["z-ai/glm-5.2", 1_000_000],
  ["deepseek/deepseek-v3.2", 128_000],
  ["deepseek/deepseek-chat-v3.1", 128_000],
  ["deepseek/deepseek-v4-flash", 1_000_000],
  ["deepseek/deepseek-v4-pro", 1_000_000],
  ["nvidia/llama-3.3-nemotron-super-49b", 128_000],
  ["nvidia/nemotron-3-nano-omni", 128_000],
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
      if (part.type === "file") used += 8;
    }
  }
  return used;
}

const MODELS = [
  ["openai/gpt-oss-120b", "GPT-OSS-120B"],
  ["openai/gpt-5.6-luna", "GPT-5.6 Luna (Paid xKiro)"],
  ["openai/gpt-5.6-terra", "GPT-5.6 Terra (Paid xKiro)"],
  ["moonshotai/kimi-k2.6", "Kimi K2.6 (Paid xKiro)"],
  ["moonshotai/kimi-k2.5", "Kimi K2.5 (Paid xKiro)"],
  ["google/gemini-3.6-flash", "Gemini 3.6 Flash (Paid xKiro · Vision)"],
  ["google/gemini-3.5-flash", "Gemini 3.5 Flash (Paid xKiro · Vision)"],
  ["google/gemini-3.1-pro", "Gemini 3.1 Pro (Paid xKiro · Vision)"],
  ["google/gemini-3-flash", "Gemini 3 Flash (Paid xKiro · Vision)"],
  ["google/gemini-2.5-flash", "Gemini 2.5 Flash (Paid xKiro · Vision)"],
  ["google/gemini-2.5-pro", "Gemini 2.5 Pro (Paid xKiro · Vision)"],
  ["minimax/minimax-m2", "MiniMax M2"],
  ["minimax/minimax-m2.1-highspeed", "MiniMax M2.1 High-Speed"],
  ["minimax/minimax-m2.1", "MiniMax M2.1"],
  ["minimax/minimax-m2.5-highspeed", "MiniMax M2.5 High-Speed"],
  ["minimax/minimax-m2.5", "MiniMax M2.5"],
  ["minimax/minimax-m2.7-highspeed", "MiniMax M2.7 High-Speed"],
  ["minimax/minimax-m2.7", "MiniMax M2.7"],
  ["minimax/minimax-m3", "MiniMax M3 (Paid xKiro · $ Credits)"],
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
  ["deepseek/deepseek-v4-flash-0731", "DeepSeek V4 Flash 07.31 (Paid xKiro · $ Credits)"],
  ["xiaomi/mimo-v2.5-pro:free", "Xiaomi Mimo V2.5 Pro (Paid xKiro · $ Credits)"],
  ["xiaomi/mimo-v2.5:free", "Xiaomi Mimo V2.5 (Paid xKiro · $ Credits)"],
  ["x-ai/grok-4.5", "Grok 4.5 (Paid xKiro)"],
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
  ["z-ai/glm-4.5-air", "GLM 4.5 Air ($ Credits)"],
  ["z-ai/glm-4.5", "GLM 4.5 ($ Credits)"],
  ["z-ai/glm-4.6", "GLM 4.6 ($ Credits)"],
  ["z-ai/glm-4.7", "GLM 4.7 ($ Credits)"],
  ["z-ai/glm-5", "GLM 5 ($ Credits)"],
  ["z-ai/glm-5-turbo", "GLM 5 Turbo ($ Credits)"],
  ["z-ai/glm-5.1", "GLM 5.1 ($ Credits)"],
  ["z-ai/glm-5.2", "GLM 5.2 ($ Credits)"],
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
]);

const color = {
  cyan: (text) => `\u001b[36m${text}\u001b[0m`,
  dim: (text) => `\u001b[2m${text}\u001b[0m`,
  green: (text) => `\u001b[32m${text}\u001b[0m`,
  magenta: (text) => `\u001b[35m${text}\u001b[0m`,
  red: (text) => `\u001b[31m${text}\u001b[0m`,
  yellow: (text) => `\u001b[33m${text}\u001b[0m`,
};

function diagnostic(text) {
  process.stderr.write(`${text}\n`);
}

function printBanner(config) {
  console.log(color.cyan("\n  ✦ Nexara CLI") + color.dim("  —  AI in your terminal"));
  console.log(color.dim(`  model: ${modelLabel(config.selectedModel)}   effort: ${config.selectedReasoningEffort || "medium"}   app: ${config.appUrl}`));
  console.log(color.dim("  Type /help for commands. Ctrl+C twice exits.\n"));
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

function printModels(selected) {
  console.log("\nAvailable Nexara models:");
  for (const [id, label] of MODELS) {
    const locked = LOCKED_MODELS.has(id);
    const marker = id === selected ? color.green("●") : locked ? color.yellow("🔒") : "○";
    const pricing = MODEL_PRICING.get(id);
    const priceLabel = pricing ? color.dim(` — $${pricing.input}/1M in · $${pricing.output}/1M out`) : "";
    const imageLabel = MODEL_IMAGE_INPUT.has(id) ? color.cyan(" · Vision input") : "";
    console.log(`${marker} ${label} ${color.dim(`(${id})`)}${priceLabel}${imageLabel}${locked ? color.yellow(" — unavailable") : ""}`);
  }
  console.log();
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
  /status                       Show account, model, and thread state
  /quit                         Exit the CLI

${color.dim("Voice: press M at the prompt to record your mic; press M again to")}
${color.dim("stop and transcribe your words into the input (speech-to-text).")}

${color.dim("Login options: nexara login, nexara login --google, nexara login --qr")}
${color.dim("Outside the REPL, use: nexara \"prompt\", nexara -p \"prompt\", --image file.png, --model deepseek-v4-pro, --effort high, --continue")}
`);
}function parseArgs(argv) {
  const options = { prompt: [], images: [], print: false, continue: false, google: false, qr: false, help: false, version: false };
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
  const resolved = path.resolve(filePath);
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
    const email = (await rl.question("Nexara email: ")).trim();
    const password = await rl.question("Nexara password: ", { hideEchoBack: true });
    const user = await auth.login(email, password);
    console.log(color.green(`Signed in as ${user.email || email}.`));
  } finally {
    rl.close();
  }
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
  if (!quiet) {
    printEffortEstimates(
      state.config.selectedModel,
      contextOf([...state.messages, message]) + 1_600,
    );
    process.stdout.write(color.magenta("nexara ") + color.dim("· "));
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
    onStatus: quiet ? undefined : (status) => diagnostic(status === "thinking" ? "thinking…" : "using tool…"),
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
  if (!quiet) {
    const ctxUsed = contextOf(state.messages);
    const ctxWindow = MODEL_CONTEXT.get(state.config.selectedModel) ?? 128_000;
    const percent = Math.min(100, Math.round((ctxUsed / ctxWindow) * 100));
    process.stdout.write(color.dim(`\n[ctx ${formatTokens(ctxUsed)} / ${formatTokens(ctxWindow)} (${percent}%) — /compact frees this]\n`));
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
    case "/models": printModels(state.config.selectedModel); return true;
    case "/model": {
      if (!argument) { printModels(state.config.selectedModel); return true; }
      const model = resolveModel(argument);
      if (!model) { console.log(color.red(`Unknown model: ${argument}`)); printModels(state.config.selectedModel); return true; }
      state.config = saveConfig({ selectedModel: model });
      console.log(color.green(`Model switched to ${modelLabel(model)}.`));
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
      console.log(color.green(`GPT-5.6 reasoning effort set to ${value}.`));
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
      console.log(color.green(`Attached ${file.filename}. It will be sent with your next prompt.`));
      return true;
    }
    case "/new":
    case "/clear":
      state.threadId = null;
      state.messages = [];
      state.pendingImages = [];
      state.config = saveConfig({ lastThreadId: null });
      console.log("Started a fresh conversation.");
      return true;
    case "/resume": {
      const id = argument || state.config.lastThreadId;
      if (!id) { console.log("No saved conversation to resume."); return true; }
      const loaded = await loadThread(state.auth, id);
      state.threadId = loaded.thread.id;
      state.messages = loaded.messages;
      state.config = saveConfig({ lastThreadId: state.threadId });
      console.log(color.green(`Resumed: ${loaded.thread.title} (${state.threadId})`));
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
        console.log(color.green("Conversation compacted — context window freed up."));
      } catch (error) {
        console.log(color.red(error.message));
      }
      return true;
    }
    case "/config": console.log(`Config: ${state.configPath}`); return true;
    case "/status": {
      const user = await state.auth.user();
      const ctxUsed = contextOf(state.messages);
      const ctxWindow = MODEL_CONTEXT.get(state.config.selectedModel) ?? 128_000;
      console.log(
        `Signed in: ${user?.email || "no"}\nModel: ${modelLabel(state.config.selectedModel)}\nThread: ${state.threadId || "none"}\nPending files: ${state.pendingImages.length}\nContext: ${formatTokens(ctxUsed)} / ${formatTokens(ctxWindow)} (${Math.min(100, Math.round((ctxUsed / ctxWindow) * 100))}%)`,
      );
      return true;
    }
    case "/think": await runPrompt(state, argument, { mode: "think", files: state.pendingImages }); return true;
    case "/research": await runPrompt(state, argument, { mode: "research", files: state.pendingImages }); return true;
    case "/perplexity": await runPrompt(state, argument, { mode: "perplexity", files: state.pendingImages }); return true;
    case "/plan": await runPrompt(state, argument, { mode: "planner", files: state.pendingImages }); return true;
    case "/honest": await runPrompt(state, argument, { mode: "honest", files: state.pendingImages }); return true;
    case "/goal": await continueGoal(state, argument); return true;
    case "/quit":
    case "/exit": return false;
    default: console.log(color.yellow(`Unknown command: ${command}. Type /help.`)); return true;
  }
}

async function interactive(config, auth, configPath, existingState) {
  const state = existingState || { config, auth, configPath, threadId: null, messages: [], pendingImages: [], quiet: false };
  printBanner(config);
  const rl = readline.createInterface({ input, output, prompt: color.cyan("you ") });

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

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const config = loadConfig();
  const configPath = (await import("./config.js")).CONFIG_FILE;
  if (options.help) { printHelp(); return; }
  if (options.version) { console.log(CURRENT_VERSION); return; }
  // Never block startup on GitHub. The detached worker updates the global
  // install in the background, so this command remains usable offline and
  // the next invocation automatically runs the new version.
  void scheduleAutoUpdate();
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
  if (command === "whoami" && options.prompt.length === 1) { const user = await auth.user(); console.log(user?.email || "Not signed in."); return; }
  if (options.print || options.prompt.length > 0 || options.images.length > 0 || (options.continue && options.prompt.length > 0)) {
    await oneShot(nextConfig, auth, { ...options, prompt: options.prompt[0] === "login" ? [] : options.prompt }, configPath);
    return;
  }
  await requireLogin(auth, nextConfig);
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
