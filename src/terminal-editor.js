import { EventEmitter } from "node:events";
import { emitKeypressEvents } from "node:readline";

// A small terminal editor for Windows Terminal/conhost. It deliberately owns
// every byte in the input row; readline is excellent for pipes, but its line
// wrapping and cursor bookkeeping are what caused the Chatbox to be clipped.
export function createTerminalEditor({ input, output, width = () => 80, rows = () => 3 }) {
  const events = new EventEmitter();
  let line = "";
  let cursor = 0;
  let closed = false;
  let questionResolver = null;
  let questionRejecter = null;
  let currentPrompt = "║ ❯ ";
  let rawBefore = false;
  let renderedRows = 1;

  const editor = {
    get line() { return line; },
    get closed() { return closed; },
    getCursorPos() { return { cols: currentPrompt.length + cursor, rows: 0 }; },
    setPrompt(value) {
      // Strip styling from the prompt and retain the visible glyphs only.
      currentPrompt = String(value || "║ ❯ ").replace(/\u001b\[[0-9;]*m/g, "");
    },
    on: (...args) => { events.on(...args); return editor; },
    once: (...args) => { events.once(...args); return editor; },
    removeListener: (...args) => { events.removeListener(...args); return editor; },
    emit: (...args) => events.emit(...args),
    prompt() { render(); },
    write(value, key = {}) {
      if (key?.ctrl && key.name === "u") {
        line = "";
        cursor = 0;
      } else if (value === "\b \b") {
        if (cursor > 0) { line = `${line.slice(0, cursor - 1)}${line.slice(cursor)}`; cursor -= 1; }
      } else if (typeof value === "string") {
        line = `${line.slice(0, cursor)}${value}${line.slice(cursor)}`;
        cursor += value.length;
      }
      render();
    },
    question(message) {
      renderMessage(message);
      return new Promise((resolve, reject) => {
        questionResolver = resolve;
        questionRejecter = reject;
        render();
      });
    },
    close() {
      if (closed) return;
      closed = true;
      if (questionRejecter) questionRejecter(new Error("Terminal editor closed"));
      questionResolver = null;
      questionRejecter = null;
      if (input.isTTY && typeof input.setRawMode === "function") input.setRawMode(Boolean(rawBefore));
      input.removeListener("keypress", onKeypress);
      output.write("\u001b[?25h\u001b[0m\r\n");
      events.emit("close");
    },
  };

  function renderMessage(message) {
    const text = String(message || "").replace(/\r?\n/g, "\n");
    output.write(`\r\u001b[2K${text}\n`);
  }

  function render() {
    if (closed) return;
    const columns = Math.max(24, Number(width()) || 80);
    const available = Math.max(1, columns - currentPrompt.length - 3);
    const maxRows = Math.max(1, Number(rows()) || 3);
    const chunks = [];
    let cursorRow = 0;
    let cursorCol = 0;
    let offset = 0;
    for (const segment of line.split("\n")) {
      if (!segment.length) chunks.push("");
      else for (let index = 0; index < segment.length; index += available) chunks.push(segment.slice(index, index + available));
      const segmentEnd = offset + segment.length;
      if (cursor >= offset && cursor <= segmentEnd) {
        const local = cursor - offset;
        cursorRow = chunks.length - 1;
        cursorCol = Math.min(available, local % available);
      }
      offset = segmentEnd + 1;
    }
    if (!chunks.length) chunks.push("");
    const firstRow = Math.min(
      Math.max(0, cursorRow - maxRows + 1),
      Math.max(0, chunks.length - maxRows),
    );
    const visibleChunks = chunks.slice(firstRow);
    const visibleCursorRow = Math.max(0, cursorRow - firstRow);
    const visibleRows = Math.max(1, visibleChunks.length);
    // Return to the top of the previous render, clear only the editor rows,
    // then paint every wrapped row in one pass. No delete/reinsert blink.
    if (renderedRows > 1) output.write(`\r\u001b[${renderedRows - 1}A`);
    for (let index = 0; index < visibleRows; index += 1) {
      const content = `${currentPrompt}${visibleChunks[index]}`;
      output.write(`\r\u001b[2K${content}\u001b[s\u001b[${Math.max(1, columns - 1)}G║\u001b[u`);
      if (index < visibleRows - 1) output.write("\n");
    }
    const moveUp = visibleRows - 1 - visibleCursorRow;
    if (moveUp) output.write(`\u001b[${moveUp}A`);
    const cursorOffset = currentPrompt.length + cursorCol;
    if (cursorOffset) output.write(`\r\u001b[${cursorOffset}C`);
    renderedRows = visibleRows;
  }

  function submit() {
    const value = line;
    line = "";
    cursor = 0;
    if (questionResolver) {
      const resolve = questionResolver;
      questionResolver = null;
      questionRejecter = null;
      resolve(value);
      render();
      return;
    }
    events.emit("line", value);
  }

  function onKeypress(str, key = {}) {
    if (closed) return;
    const name = String(key.name || "").toLowerCase();
    const sequence = key.sequence || str || "";
    if (key.ctrl && name === "c") return;
    if (name === "return" || name === "enter" || sequence === "\r" || sequence === "\n") {
      if (key.shift) {
        line = `${line.slice(0, cursor)}\n${line.slice(cursor)}`;
        cursor += 1;
        render();
      } else submit();
      return;
    }
    if (name === "backspace") {
      if (cursor > 0) { line = `${line.slice(0, cursor - 1)}${line.slice(cursor)}`; cursor -= 1; render(); }
      return;
    }
    if (name === "delete") {
      if (cursor < line.length) { line = `${line.slice(0, cursor)}${line.slice(cursor + 1)}`; render(); }
      return;
    }
    if (name === "left") { cursor = Math.max(0, cursor - 1); render(); return; }
    if (name === "right") { cursor = Math.min(line.length, cursor + 1); render(); return; }
    if (name === "home" || (key.ctrl && name === "a")) { cursor = 0; render(); return; }
    if (name === "end" || (key.ctrl && name === "e")) { cursor = line.length; render(); return; }
    if (key.ctrl && name === "u") { line = ""; cursor = 0; render(); return; }
    if (key.ctrl || key.meta || key.alt || !str || /[\u0000-\u001f\u007f]/.test(str)) return;
    line = `${line.slice(0, cursor)}${str}${line.slice(cursor)}`;
    cursor += str.length;
    render();
  }

  emitKeypressEvents(input);
  if (input.isTTY && typeof input.setRawMode === "function") {
    rawBefore = Boolean(input.isRaw);
    input.setRawMode(true);
    input.resume();
  }
  input.on("keypress", onKeypress);
  output.write("\u001b[?25h");
  return editor;
}
