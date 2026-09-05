import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { DEFAULT_MODEL, NEXARA_APP_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./runtime-defaults.js";

export const CONFIG_DIR = path.join(os.homedir(), ".nexara");
export const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

const DEFAULT_CONFIG = {
  version: 1,
  appUrl: NEXARA_APP_URL,
  supabaseUrl: SUPABASE_URL,
  supabaseKey: SUPABASE_PUBLISHABLE_KEY,
  selectedModel: DEFAULT_MODEL,
  selectedReasoningEffort: "medium",
  permissionMode: "ask",
  noSessionPersistence: false,
  maxTurns: 100,
  maxBudget: null,
  allowedTools: [],
  disallowedTools: [],
  lastThreadId: null,
  session: null,
  /** Silent background updates. Opt out with `nexara update --off` (or
   * install with the -DisableAutoUpdate switch), then update manually with
   * `nexara update` whenever you choose. */
  autoUpdate: true,
};

export function loadConfig() {
  let parsed = {};
  try {
    parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    // First run or a partially deleted config: start from safe defaults.
  }
  const merged = { ...DEFAULT_CONFIG, ...parsed };
  // The first CLI release used MiniMax M2.5 as its implicit default. Migrate
  // only that untouched legacy default; an explicitly chosen model remains
  // exactly as the user set it.
  if (merged.selectedModel === "minimax/minimax-m2.5") merged.selectedModel = DEFAULT_CONFIG.selectedModel;
  return merged;
}

export function saveConfig(patch) {
  const next = { ...loadConfig(), ...patch };
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  // Do not leave a partially-written token/config file if the process or
  // machine stops mid-write. Write beside the target, protect it, then swap.
  const tempFile = `${CONFIG_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  try {
    if (process.platform !== "win32") fs.chmodSync(tempFile, 0o600);
  } catch {
    // Best effort on filesystems without Unix permissions.
  }
  fs.renameSync(tempFile, CONFIG_FILE);
  return next;
}

export function clearSession() {
  return saveConfig({ session: null, lastThreadId: null });
}

export function ensureConfiguration(config) {
  const missing = [];
  if (!config.appUrl) missing.push("app URL");
  if (!config.supabaseUrl) missing.push("Supabase URL");
  if (!config.supabaseKey) missing.push("Supabase publishable key");
  if (missing.length) {
    throw new Error(
      `Nexara CLI is missing ${missing.join(", ")}. Set NEXARA_APP_URL, NEXARA_SUPABASE_URL, and NEXARA_SUPABASE_PUBLISHABLE_KEY, then run again.`,
    );
  }
}

export function resolveConfigValue(config, key, value) {
  if (!value) return config;
  if (!(key in DEFAULT_CONFIG)) throw new Error(`Unknown config key: ${key}`);
  return saveConfig({ [key]: value });
}
