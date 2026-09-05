import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { listLocalSessions, loadLocalSession, saveLocalSession } from "../src/sessions.js";

const TEST_SESSION_DIR = path.join(process.cwd(), `.test-sessions-${process.pid}`);
process.env.NEXARA_SESSION_DIR = TEST_SESSION_DIR;
const PREFIX = `test-acct-scope-${Date.now()}`;

test("a session saved under one account is invisible to a different account", async () => {
  const ownId = `${PREFIX}-own`;
  const otherId = `${PREFIX}-other`;
  try {
    await saveLocalSession({ threadId: ownId, accountId: "user-a", messages: [{ role: "user", parts: [] }] });
    await saveLocalSession({ threadId: otherId, accountId: "user-b", messages: [{ role: "user", parts: [] }] });

    const ownFromA = await loadLocalSession(ownId, "user-a");
    assert.ok(ownFromA, "the owning account must still load its own session");

    const otherFromA = await loadLocalSession(otherId, "user-a");
    assert.equal(otherFromA, null, "a different account's session must not load");

    const listedForA = await listLocalSessions(50, "user-a");
    assert.ok(listedForA.some((record) => record.threadId === ownId));
    assert.ok(!listedForA.some((record) => record.threadId === otherId), "listing must not leak another account's session");
  } finally {
    const { localSessionPath } = await import("../src/sessions.js");
    await fs.unlink(localSessionPath(ownId)).catch(() => {});
    await fs.unlink(localSessionPath(otherId)).catch(() => {});
  }
});

test("a legacy session with no accountId is not readable without ownership", async () => {
  const legacyId = `${PREFIX}-legacy`;
  try {
    await saveLocalSession({ threadId: legacyId, messages: [{ role: "user", parts: [] }] });
    const loaded = await loadLocalSession(legacyId, "user-a");
    assert.equal(loaded, null, "a session without an owner must not become cross-account readable");
  } finally {
    const { localSessionPath } = await import("../src/sessions.js");
    await fs.unlink(localSessionPath(legacyId)).catch(() => {});
  }
});

test.after(async () => {
  await fs.rm(TEST_SESSION_DIR, { recursive: true, force: true });
});
