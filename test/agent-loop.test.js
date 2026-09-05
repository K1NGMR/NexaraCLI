import assert from "node:assert/strict";
import test from "node:test";

import { consumeDataLine } from "../src/api.js";
import { toolAccessDecision } from "../src/cli.js";

function stateFor(permissionMode) {
  return { config: { permissionMode, allowedTools: [], disallowedTools: [] } };
}

test("read-only and plan modes still allow non-mutating tools like Read/Search", () => {
  for (const mode of ["read-only", "plan"]) {
    const state = stateFor(mode);
    assert.equal(toolAccessDecision(state, "Read").action, "allow");
    assert.equal(toolAccessDecision(state, "Search").action, "allow");
    assert.equal(toolAccessDecision(state, "Glob").action, "allow");
    // Mutating tools must still be denied outright in these modes, even if
    // remembered as previously allowed -- this is the case the ordering fix
    // must not regress.
    assert.equal(toolAccessDecision(state, "Write").action, "deny");
    assert.equal(toolAccessDecision(state, "Bash").action, "deny");
  }
});

test("an explicitly allowed mutating tool still cannot override read-only/plan mode", () => {
  const state = { config: { permissionMode: "read-only", allowedTools: ["Write"], disallowedTools: [] } };
  assert.equal(toolAccessDecision(state, "Write").action, "deny");
});

test("disallowed-tools always denies, even non-mutating tools", () => {
  const state = { config: { permissionMode: "full", allowedTools: [], disallowedTools: ["Read"] } };
  assert.equal(toolAccessDecision(state, "Read").action, "deny");
});

function freshApiState() {
  return { text: "", reasoning: "", nativeCalls: [], lastUsage: null, sources: [], model: null, finished: false };
}

test("parallel tool-call events in one step are all captured, not just the first", () => {
  const state = freshApiState();
  const calls = [];
  const onToolCall = (call) => calls.push(call);
  consumeDataLine(
    JSON.stringify({ type: "tool-call", toolCallId: "a", toolName: "Read", input: { file_path: "one.js" } }),
    state, null, () => {}, onToolCall, () => {}, () => {}, () => {}, () => {},
  );
  consumeDataLine(
    JSON.stringify({ type: "tool-call", toolCallId: "b", toolName: "Read", input: { file_path: "two.js" } }),
    state, null, () => {}, onToolCall, () => {}, () => {}, () => {}, () => {},
  );
  assert.equal(state.nativeCalls.length, 2);
  assert.deepEqual(state.nativeCalls.map((call) => call.toolCallId), ["a", "b"]);
  assert.equal(calls.length, 2);
});

test("a repeated tool-call event for the same toolCallId is not double-added", () => {
  const state = freshApiState();
  const line = JSON.stringify({ type: "tool-call", toolCallId: "a", toolName: "Read", input: { file_path: "one.js" } });
  consumeDataLine(line, state, null, () => {}, () => {}, () => {}, () => {}, () => {}, () => {});
  consumeDataLine(line, state, null, () => {}, () => {}, () => {}, () => {}, () => {}, () => {});
  assert.equal(state.nativeCalls.length, 1);
});
