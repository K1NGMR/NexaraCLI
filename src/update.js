import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { CONFIG_DIR } from "./config.js";

const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const RETRY_INTERVAL_MS = 30 * 60 * 1000;
const UPDATE_STATE_FILE = path.join(CONFIG_DIR, "update.json");
const REPOSITORY = "K1NGMR/NexaraCLI";
const REMOTE_PACKAGE_URL = `https://raw.githubusercontent.com/${REPOSITORY}/main/package.json`;
const WORKER_FILE = fileURLToPath(new URL("./update-worker.ps1", import.meta.url));

const CURRENT_VERSION = JSON.parse(
  fsSync.readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
).version;

function versionParts(version) {
  const match = String(version || "").match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  return match ? match.slice(1, 4).map(Number) : null;
}

function isNewer(remote, current) {
  const a = versionParts(remote);
  const b = versionParts(current);
  if (!a || !b) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index];
  }
  return false;
}

async function readState() {
  try {
    const value = JSON.parse(await fs.readFile(UPDATE_STATE_FILE, "utf8"));
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

async function writeState(patch) {
  try {
    await fs.mkdir(CONFIG_DIR, { recursive: true });
    await fs.writeFile(UPDATE_STATE_FILE, `${JSON.stringify({ ...await readState(), ...patch }, null, 2)}\n`, "utf8");
  } catch {
    // Updating is best-effort and must never prevent the CLI from starting.
  }
}

async function fetchRemoteVersion() {
  const response = await fetch(`${REMOTE_PACKAGE_URL}?t=${Date.now()}`, {
    headers: { Accept: "application/json", "Cache-Control": "no-cache" },
    signal: AbortSignal.timeout(3500),
  });
  if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
  const packageJson = await response.json();
  if (!/^\d+\.\d+\.\d+$/.test(String(packageJson?.version || ""))) {
    throw new Error("GitHub returned an invalid stable CLI version");
  }
  return packageJson.version;
}

function launchWindowsUpdater(targetVersion, stateFile) {
  if (process.platform !== "win32") return false;
  if (!fsSync.existsSync(WORKER_FILE)) return false;

  const powershell = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
  const child = spawn(
    powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      WORKER_FILE,
      "-TargetVersion",
      targetVersion,
      "-StateFile",
      stateFile,
    ],
    { detached: true, stdio: "ignore", windowsHide: true },
  );
  child.unref();
  return true;
}

/**
 * Check at most every few hours, then let a detached PowerShell worker update
 * the globally installed package. The current invocation keeps running; the
 * next `nexara` invocation uses the new files. Network/update failures are
 * intentionally silent so offline CLI use is never interrupted.
 */
export async function scheduleAutoUpdate() {
  if (process.env.NEXARA_NO_AUTO_UPDATE === "1") return;
  if (process.env.NODE_ENV === "test") return;

  const state = await readState();
  const lastCheck = Date.parse(state.checkedAt || "") || 0;
  const interval = state.status === "error" ? RETRY_INTERVAL_MS : UPDATE_INTERVAL_MS;
  if (Date.now() - lastCheck < interval) return;

  try {
    const remoteVersion = await fetchRemoteVersion();
    const checkedAt = new Date().toISOString();
    if (!isNewer(remoteVersion, CURRENT_VERSION)) {
      await writeState({ status: "current", currentVersion: CURRENT_VERSION, remoteVersion, checkedAt });
      return;
    }

    const stateFile = path.resolve(UPDATE_STATE_FILE);
    const launched = launchWindowsUpdater(remoteVersion, stateFile);
    await writeState({
      status: launched ? "scheduled" : "manual",
      currentVersion: CURRENT_VERSION,
      remoteVersion,
      targetVersion: remoteVersion,
      checkedAt,
      scheduledAt: launched ? new Date().toISOString() : undefined,
    });
  } catch (error) {
    await writeState({ status: "error", checkedAt: new Date().toISOString(), error: String(error?.message || error).slice(0, 200) });
  }
}

export { CURRENT_VERSION };
