import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createTerminalEditor } from "../src/terminal-editor.js";

function fakeStreams() {
  const input = new EventEmitter();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = () => {};
  input.resume = () => {};
  const output = new EventEmitter();
  output.columns = 80;
  output.write = () => true;
  return { input, output };
}

function press(input, str, key = {}) {
  input.emit("keypress", str, { name: key.name, sequence: key.sequence ?? str, ...key });
}

test("a picker suspended with pause() does not process keystrokes until resume()", () => {
  const { input, output } = fakeStreams();
  const editor = createTerminalEditor({ input, output });
  press(input, "h");
  press(input, "i");
  assert.equal(editor.line, "hi");

  editor.pause();
  press(input, "x");
  press(input, "y");
  assert.equal(editor.line, "hi", "keystrokes while paused must not reach the composer buffer");

  editor.resume();
  press(input, "!");
  assert.equal(editor.line, "hi!");
});

test("a question stashes and restores an in-progress draft instead of losing it", async () => {
  const { input, output } = fakeStreams();
  const editor = createTerminalEditor({ input, output });
  press(input, "d");
  press(input, "r");
  press(input, "a");
  press(input, "f");
  press(input, "t");
  assert.equal(editor.line, "draft");

  const answerPromise = editor.question("Proceed?");
  // The question starts with an empty answer field, not the pending draft.
  assert.equal(editor.line, "");
  press(input, "y");
  press(input, "", { name: "return" });
  const answer = await answerPromise;
  assert.equal(answer, "y");
  assert.equal(editor.line, "draft", "the original draft must come back after the question settles");
});

test("pause('muted') keeps accepting keystrokes but silences redraws until resume()", () => {
  const { input, output } = fakeStreams();
  let writes = 0;
  output.write = () => { writes += 1; return true; };
  const editor = createTerminalEditor({ input, output });
  press(input, "h");
  press(input, "i");
  assert.equal(editor.line, "hi");

  editor.pause("muted");
  writes = 0;
  press(input, "x");
  press(input, "y");
  assert.equal(editor.line, "hixy", "muted keystrokes must still update the buffer, unlike a blocked pause");
  assert.equal(writes, 0, "no redraw should reach the terminal while muted");

  writes = 0;
  editor.resume();
  assert.ok(writes > 0, "resume() must repaint once to catch up on everything typed while muted");

  writes = 0;
  press(input, "!");
  assert.equal(editor.line, "hixy!");
  assert.ok(writes > 0, "typing after resume() redraws normally again");
});

test("submitting a normal line emits 'line' and clears the buffer", () => {
  const { input, output } = fakeStreams();
  const editor = createTerminalEditor({ input, output });
  const lines = [];
  editor.on("line", (value) => lines.push(value));
  for (const char of "hello") press(input, char);
  press(input, "", { name: "return" });
  assert.deepEqual(lines, ["hello"]);
  assert.equal(editor.line, "");
});
