import fs from "node:fs/promises";
import path from "node:path";

import { CONFIG_DIR } from "./config.js";

export const SESSION_DIR = path.join(CONFIG_DIR, "sessions");

function sessionDirectory() {
  const override = String(process.env.NEXARA_SESSION_DIR || "").trim();
  return override ? path.resolve(override) : SESSION_DIR;
}

function sessionFile(threadId) {
  const value = String(threadId || "").trim();
  if (!value || !/^[a-zA-Z0-9_-]+$/.test(value)) return null;
  return path.join(sessionDirectory(), `${value}.json`);
}

async function protect(filePath) {
  if (process.platform !== "win32") {
    await fs.chmod(filePath, 0o600).catch(() => {});
  }
}

async function quarantine(filePath) {
  try {
    const quarantinePath = `${filePath}.corrupt-${Date.now()}`;
    await fs.rename(filePath, quarantinePath);
    await protect(quarantinePath);
  } catch {
    // A broken session must never prevent the CLI from starting.
  }
}

function validSession(record) {
  return Boolean(
    record &&
      typeof record === "object" &&
      typeof record.threadId === "string" &&
      Array.isArray(record.messages),
  );
}

export async function saveLocalSession({
  threadId,
  title = "New chat",
  cwd = process.cwd(),
  model = null,
  reasoningEffort = null,
  createdAt = null,
  messages = [],
  // Local session files live under one shared ~/.nexara directory with no
  // per-OS-account isolation. On a machine where more than one Nexara
  // account signs in (`nexara login` switching users), a session saved
  // under one account was otherwise listable/resumable by the next signed-in
  // account with no ownership check at all.
  accountId = null,
}) {
  const filePath = sessionFile(threadId);
  if (!filePath) return null;
  await fs.mkdir(sessionDirectory(), { recursive: true });
  const now = new Date().toISOString();
  const record = {
    version: 1,
    threadId: String(threadId),
    title: String(title || "New chat").slice(0, 120),
    cwd: String(cwd || process.cwd()),
    model: model ? String(model) : null,
    reasoningEffort: reasoningEffort ? String(reasoningEffort) : null,
    accountId: accountId ? String(accountId) : null,
    createdAt: createdAt || now,
    updatedAt: now,
    messages,
  };
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await protect(tempPath);
  await fs.rename(tempPath, filePath);
  await protect(filePath);
  return record;
}

// A record with no accountId predates this fix (or was saved with
// noSessionPersistence-style anonymity) -- treated as visible to anyone,
// same as before, since there is no owner recorded to check against. A
// record WITH an accountId that does not match the current one is always
// excluded: that is the actual cross-account leak this guards against.
function ownedBy(record, accountId) {
  // Anonymous/legacy records are intentionally not readable after the
  // account-scoping migration. Missing ownership must not mean public.
  return Boolean(record.accountId && accountId && record.accountId === accountId);
}

export async function loadLocalSession(threadId, accountId = null) {
  const filePath = sessionFile(threadId);
  if (!filePath) return null;
  try {
    const record = JSON.parse(await fs.readFile(filePath, "utf8"));
    if (!validSession(record)) {
      await quarantine(filePath);
      return null;
    }
    if (!ownedBy(record, accountId)) return null;
    return record;
  } catch (error) {
    if (error instanceof SyntaxError) await quarantine(filePath);
    return null;
  }
}

export async function listLocalSessions(limit = 50, accountId = null) {
  let names;
  try {
    names = await fs.readdir(sessionDirectory());
  } catch {
    return [];
  }
  const records = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => {
        try {
          const record = JSON.parse(await fs.readFile(path.join(sessionDirectory(), name), "utf8"));
          return validSession(record) && ownedBy(record, accountId) ? record : null;
        } catch (error) {
          if (error instanceof SyntaxError) await quarantine(path.join(sessionDirectory(), name));
          return null;
        }
      }),
  );
  return records
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
    .slice(0, Math.max(1, Number(limit) || 50));
}

export function localSessionPath(threadId) {
  return sessionFile(threadId);
}
