import assert from "node:assert/strict";
import test from "node:test";

import { listLocalSessions, loadLocalSession, saveLocalSession } from "../src/sessions.js";

// Local session files live in the real ~/.nexara/sessions directory (no
// injectable override exists), so these use uniquely-prefixed thread ids and
// always clean up after themselves.
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
    const { unlink } = await import("node:fs/promises");
    const { localSessionPath } = await import("../src/sessions.js");
    await unlink(localSessionPath(ownId)).catch(() => {});
    await unlink(localSessionPath(otherId)).catch(() => {});
  }
});

test("a legacy session with no accountId stays visible to any account", async () => {
  const legacyId = `${PREFIX}-legacy`;
  try {
    await saveLocalSession({ threadId: legacyId, messages: [{ role: "user", parts: [] }] });
    const loaded = await loadLocalSession(legacyId, "user-a");
    assert.ok(loaded, "a pre-existing session with no recorded owner must not be locked out");
  } finally {
    const { unlink } = await import("node:fs/promises");
    const { localSessionPath } = await import("../src/sessions.js");
    await unlink(localSessionPath(legacyId)).catch(() => {});
  }
});
