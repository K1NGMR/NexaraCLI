import assert from "node:assert/strict";
import test from "node:test";

import { consumeDataLine } from "../src/api.js";
import { toolAllowedByMode } from "../src/tools.js";

test("stream parsing accepts both current and legacy tool event fields", () => {
  const calls = [];
  const results = [];
  const state = { text: "", reasoning: "", nativeCalls: [], sources: [], finished: false };
  consumeDataLine(
    JSON.stringify({ kind: "tool-call", name: "Read", arguments: { file_path: "README.md" }, toolCallId: "call-1" }),
    state,
    null,
    null,
    (call) => calls.push(call),
    (result) => results.push(result),
  );
  consumeDataLine(
    JSON.stringify({ type: "tool-result", tool: { name: "Read" }, toolCallId: "call-1", output: "ok" }),
    state,
    null,
    null,
    null,
    (result) => results.push(result),
  );
  assert.deepEqual(calls, [{ name: "Read", arguments: { file_path: "README.md" }, toolCallId: "call-1" }]);
  assert.deepEqual(results, [{ name: "Read", toolCallId: "call-1", output: "ok" }]);
});

test("automatic and sandboxed modes cannot reach destructive tools", () => {
  for (const mode of ["auto", "sandboxed"]) {
    assert.equal(toolAllowedByMode("Bash", mode), true);
    assert.equal(toolAllowedByMode("Delete", mode), false);
    assert.equal(toolAllowedByMode("GitCheckout", mode), false);
    assert.equal(toolAllowedByMode("KillProcess", mode), false);
  }
});

test("a stream ending with the standard done marker is complete", () => {
  const state = { text: "", reasoning: "", nativeCalls: [], sources: [], finished: false };
  consumeDataLine("data: [DONE]", state);
  assert.equal(state.finished, true);
});
