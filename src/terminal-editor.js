import { EventEmitter } from "node:events";
import { emitKeypressEvents } from "node:readline";

const graphemeSegmenter = typeof Intl?.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;
const combiningMarkPattern = /^\p{Mark}+$/u;
const emojiPattern = /\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]/u;
const wideCharacterPattern = /[\u{1100}-\u{115F}\u{2329}\u{232A}\u{2E80}-\u{A4CF}\u{AC00}-\u{D7A3}\u{F900}-\u{FAFF}\u{FE10}-\u{FE19}\u{FE30}-\u{FE6F}\u{FF00}-\u{FF60}\u{FFE0}-\u{FFE6}]/u;

function graphemes(value) {
  const text = String(value ?? "");
  return graphemeSegmenter
    ? Array.from(graphemeSegmenter.segment(text), ({ segment }) => segment)
    : Array.from(text);
}

function cellWidth(value) {
  const text = String(value ?? "");
  if (!text || text === "\n" || combiningMarkPattern.test(text)) return 0;
  if (emojiPattern.test(text) || wideCharacterPattern.test(text)) return 2;
  return 1;
}

function textCellWidth(value) {
  return graphemes(value).reduce((total, grapheme) => total + cellWidth(grapheme), 0);
}

function clipToCells(value, maxCells) {
  const limit = Math.max(0, Number(maxCells) || 0);
  let used = 0;
  let result = "";
  for (const grapheme of graphemes(value)) {
    const width = cellWidth(grapheme);
    if (used + width > limit) break;
    result += grapheme;
    used += width;
  }
  return result;
}

function replaceGraphemes(value, start, deleteCount, replacement = "") {
  const items = graphemes(value);
  items.splice(start, deleteCount, ...graphemes(replacement));
  return items.join("");
}

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
  let beforeSubmit = null;
  let stashedDraft = null;
  const restoreDraft = () => {
    if (!stashedDraft) return;
    ({ line, cursor } = stashedDraft);
    stashedDraft = null;
  };
  let currentPrompt = "›  ";
  let rawBefore = false;
  let renderedRows = 1;
  // A modal picker (question/permission/model) installs its OWN keypress
  // listener on the same `input` stream rather than replacing this one --
  // Node calls every registered listener for an event, so without this flag
  // both this editor and the picker processed the SAME keystroke: Enter
  // could submit/queue whatever was in the composer at the same instant it
  // selected a picker option, and typing a picker's own hotkeys (letters,
  // numpad digits) could repaint/edit the composer underneath it. Callers
  // must pause() before opening a modal and resume() once it settles.
  //
  // Two distinct pause reasons need different behavior, so this is a mode,
  // not a boolean:
  //  - "blocked" (modal pickers): keystrokes are fully ignored -- the picker
  //    owns the keyboard, nothing here should mutate.
  //  - "muted" (a response is actively streaming/printing into the
  //    transcript): the composer still owns the keyboard -- the user can
  //    keep typing/queue their next message while the AI is working, an
  //    existing feature (pendingMessages) -- so keystrokes still update
  //    line/cursor normally. Only the actual screen REDRAW is suppressed.
  //    render() uses relative cursor movement with no absolute position of
  //    its own; the transcript printer moves the real cursor around via
  //    absolute addressing while a long response streams, so a redraw
  //    landing in that window used stale relative math and drew into
  //    whatever row the cursor actually was on (letters/fragments of the
  //    composer bleeding into the transcript, or the reverse). Muting the
  //    redraw during that window and forcing one resync render() on resume()
  //    means typed input is never lost, just not visibly updated for that
  //    brief stretch.
  let inputMode = "active";

  // Bracketed paste: without this, a paste (Ctrl+V, right-click-paste --
  // Windows Terminal's default right-click action -- or even an accidental
  // paste of whatever was last auto-copied by a text selection) arrives as
  // plain bytes indistinguishable from real typing. Every pasted character
  // gets fed through the same one-at-a-time keypress path as a keystroke, so
  // it silently appears in the composer with zero indication it was a paste,
  // not something the user typed -- exactly the "text appeared out of
  // nowhere" report this was built to fix. Enabling this mode (below) makes
  // a compliant terminal wrap paste content in ESC[200~ ... ESC[201~ markers.
  // node:readline's own keypress decoder already recognizes those markers
  // as dedicated key.name "paste-start"/"paste-end" events (confirmed by
  // feeding it real bracketed-paste bytes directly) -- so this is handled
  // entirely inside onKeypress below, buffering the ordinary keypress events
  // that arrive in between and flushing them as one atomic insert, with a
  // "paste" event emitted so the caller can show a confirmation notice.
  const ESC = String.fromCharCode(27);
  let pasting = false;
  let pasteBuffer = "";

  // The absolute screen row the composer's input line lives on. The rail
  // that draws the Chatbox owns this value, and a callback is accepted so
  // every repaint and every caret park resolves it FRESH. A cached row the
  // rail had since moved is exactly how the caret ended up sitting on -- and
  // typing over -- the border ("dashes") row above the input.
  let fixedRowSource = null;
  const resolvedFixedRow = () => {
    const value = typeof fixedRowSource === "function" ? fixedRowSource() : fixedRowSource;
    return Number.isInteger(value) && value > 0 ? value : null;
  };

  const editor = {
    get line() { return line; },
    get closed() { return closed; },
    pause(mode = "blocked") { inputMode = mode; },
    resume() {
      inputMode = "active";
      render();
    },
    getCursorPos() {
      const layout = computeLayout(Math.max(24, Number(width()) || 80));
      return { cols: textCellWidth(currentPrompt) + layout.cursorCol, rows: layout.visibleCursorRow };
    },
    setPrompt(value) {
      // Strip styling from the prompt and retain the visible glyphs only.
      currentPrompt = String(value || "›  ").replace(/\u001b\[[0-9;]*m/g, "");
    },
    setLine(value) {
      line = String(value ?? "");
      cursor = graphemes(line).length;
      render();
    },
    setFixedRow(row) {
      if (typeof row === "function") fixedRowSource = row;
      else fixedRowSource = Number.isInteger(row) && row > 0 ? row : null;
    },
    get fixedRow() { return resolvedFixedRow(); },
    get inputMode() { return inputMode; },
    // Force an absolute repaint of the input row, even while redraws are
    // muted. Muting exists to stop the RELATIVE redraw path from racing the
    // transcript's absolute writes; painting the composer at its own fixed
    // row is never part of that race. Callers no longer pass a row of their
    // own -- passing the rail's TOP row here is what painted the composer
    // onto the border line (and left the caret there) while the model was
    // working.
    repaint() {
      const row = resolvedFixedRow();
      if (row) render(row);
      return Boolean(row);
    },
    // Put the caret back inside the input row without repainting anything.
    // Anything that prints to the transcript calls this afterwards, so the
    // caret is never left parked wherever the last write happened to end.
    parkCursor() { return parkCursor(); },
    setBeforeSubmit(handler) { beforeSubmit = typeof handler === "function" ? handler : null; },
    on: (...args) => { events.on(...args); return editor; },
    once: (...args) => { events.once(...args); return editor; },
    removeListener: (...args) => { events.removeListener(...args); return editor; },
    emit: (...args) => events.emit(...args),
    prompt() { render(); },
    renderAt(row) { render(Number(row)); },
    // The fixed composer can be removed and then painted again at an absolute
    // row (for example after a terminal resize). The next render starts at
    // that new anchor, so it must not replay the previous render's relative
    // wrapped-row movement first.
    resetRenderAnchor() { renderedRows = 1; },
    write(value, key = {}) {
      if (key?.ctrl && key.name === "u") {
        line = "";
        cursor = 0;
      } else if (value === "\b \b") {
        if (cursor > 0) { line = replaceGraphemes(line, cursor - 1, 1); cursor -= 1; }
      } else if (typeof value === "string") {
        line = replaceGraphemes(line, cursor, 0, value);
        cursor += graphemes(value).length;
      }
      render();
    },
    question(message) {
      renderMessage(message);
      // A question (approval prompt, /model, etc.) can interrupt the user
      // mid-draft -- there is only one line/cursor, so starting the question
      // with whatever they had typed already mixed that draft into the
      // question's answer, and submitting silently discarded it. Stash it
      // and restore it once the question settles, so it comes back exactly
      // as left instead of vanishing into (or corrupting) the answer.
      stashedDraft = { line, cursor };
      line = "";
      cursor = 0;
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
      if (output.isTTY) output.write(`${ESC}[?2004l`);
      output.write("\u001b[?25h\u001b[0m\r\n");
      events.emit("close");
    },
  };

  function renderMessage(message) {
    const text = String(message || "").replace(/\r?\n/g, "\n");
    output.write(`\r\u001b[2K${text}\n`);
  }

  // Lay the current line out into the wrapped rows the editor viewport shows
  // and work out where the caret sits inside them. Shared by render() and
  // parkCursor() so a caret park can never disagree with the last repaint
  // about which column the caret belongs in.
  function computeLayout(columns) {
    const promptWidth = textCellWidth(currentPrompt);
    const available = Math.max(1, columns - promptWidth - 3);
    const maxRows = Math.max(1, Number(rows()) || 3);
    const chunks = [];
    let cursorRow = 0;
    let cursorCol = 0;
    let offset = 0;
    for (const segment of line.split("\n")) {
      const items = graphemes(segment);
      const segmentChunks = [];
      if (!items.length) {
        segmentChunks.push({ text: "", items: [] });
      } else {
        let chunkItems = [];
        let chunkWidth = 0;
        for (const item of items) {
          const itemWidth = cellWidth(item);
          if (chunkItems.length && chunkWidth + itemWidth > available) {
            segmentChunks.push({ text: chunkItems.join(""), items: chunkItems });
            chunkItems = [];
            chunkWidth = 0;
          }
          chunkItems.push(item);
          chunkWidth += itemWidth;
        }
        if (chunkItems.length) segmentChunks.push({ text: chunkItems.join(""), items: chunkItems });
      }
      const segmentEnd = offset + items.length;
      const localCursor = Math.max(0, Math.min(items.length, cursor - offset));
      if (cursor >= offset && cursor <= segmentEnd) {
        let consumed = 0;
        for (let index = 0; index < segmentChunks.length; index += 1) {
          const chunk = segmentChunks[index];
          const next = consumed + chunk.items.length;
          // At an exact wrap boundary the caret belongs at the end of the
          // preceding row, not column zero on the next row.
          if (localCursor <= next || index === segmentChunks.length - 1) {
            cursorRow = chunks.length + index;
            cursorCol = textCellWidth(chunk.items.slice(0, Math.max(0, localCursor - consumed)).join(""));
            break;
          }
          consumed = next;
        }
      }
      chunks.push(...segmentChunks.map(({ text }) => text));
      offset = segmentEnd + 1;
    }
    if (!chunks.length) chunks.push("");
    const firstRow = Math.min(
      Math.max(0, cursorRow - maxRows + 1),
      Math.max(0, chunks.length - maxRows),
    );
    // Never let wrapped input escape the reserved editor viewport.
    const visibleChunks = chunks.slice(firstRow, firstRow + maxRows);
    return {
      visibleChunks,
      visibleCursorRow: Math.max(0, cursorRow - firstRow),
      visibleRows: Math.max(1, visibleChunks.length),
      cursorCol,
    };
  }

  // Move the real terminal caret to the composer's input row/column. This is
  // the single place that decides where the caret is allowed to be, so it can
  // only ever land inside the Chatbox: never on a border row, and never past
  // the right edge where the terminal would wrap it onto the row below (which
  // then scrolls the rail).
  function parkCursor() {
    if (closed) return false;
    const row = resolvedFixedRow();
    if (!row) return false;
    const columns = Math.max(24, Number(width()) || 80);
    const { cursorCol } = computeLayout(columns);
    const targetCol = Math.max(1, Math.min(columns, textCellWidth(currentPrompt) + cursorCol + 1));
    output.write(`\u001b[${row};${targetCol}H`);
    return true;
  }

  function render() {
    if (closed) return;
    const explicitRow = arguments.length ? Number(arguments[0]) : null;
    const hasExplicitRow = Number.isInteger(explicitRow) && explicitRow > 0;
    if (inputMode === "muted" && !hasExplicitRow) {
      events.emit("change", line);
      return;
    }
    const absoluteRow = hasExplicitRow ? explicitRow : resolvedFixedRow();
    const columns = Math.max(24, Number(width()) || 80);
    const { visibleChunks, visibleCursorRow, visibleRows, cursorCol } = computeLayout(columns);
    if (absoluteRow) {
      const row = absoluteRow;
      // Hard-clip to the row's own width. computeLayout already wraps at a
      // narrower budget, but a stale width() reading (mid-resize) must not be
      // able to push a character past the last column: the terminal would
      // wrap it onto the next row and scroll the whole rail up by one, which
      // is precisely how the input line ended up overwriting the border.
      const promptWidth = textCellWidth(currentPrompt);
      const budget = Math.max(0, columns - promptWidth - 1);
      const visible = clipToCells(visibleChunks[0] || "", budget);
      const promptFormatted = "\u001b[38;2;204;120;92m›\u001b[38;2;250;249;245m  \u001b[0m";
      const textFormatted = `\u001b[38;2;250;249;245m${visible}\u001b[0m`;
      // Autowrap off for the duration of the paint: belt-and-braces against
      // that same one-row scroll.
      output.write(`\u001b[?7l\u001b[${row};1H\u001b[2K${promptFormatted}${textFormatted}\u001b[?7h`);
      const targetCol = Math.max(1, Math.min(columns, promptWidth + cursorCol + 1));
      output.write(`\u001b[${row};${targetCol}H`);
      renderedRows = 1;
      return;
    }
    // Return to the top of the previous render, clear only the editor rows,
    // then paint every wrapped row in one pass. No delete/reinsert blink.
    if (renderedRows > 1) output.write(`\r\u001b[${renderedRows - 1}A`);
    const rowsToClear = Math.max(renderedRows, visibleRows);
    for (let index = 0; index < rowsToClear; index += 1) {
      if (index >= visibleRows) {
        output.write(`\r\u001b[2K`);
        if (index < rowsToClear - 1) output.write("\n");
        continue;
      }
      const content = `${currentPrompt}${visibleChunks[index]}`;
      // Use the DEC save/restore pair so the transcript's CSI save slot is
      // never clobbered by editor redraws.
      output.write(`\r\u001b[2K${content}\u001b7\u001b8`);
      // Clear through the full previous render span so stale wrapped rows
      // remain below the visible input instead of erasing it.
      if (index < rowsToClear - 1) output.write("\n");
    }
    const moveUp = rowsToClear - 1 - visibleCursorRow;
    if (moveUp) output.write(`\u001b[${moveUp}A`);
    const cursorOffset = textCellWidth(currentPrompt) + cursorCol;
    if (cursorOffset) output.write(`\r\u001b[${cursorOffset}C`);
    renderedRows = visibleRows;
    events.emit("change", line);
  }

  function submit() {
    if (beforeSubmit?.({ line, cursor }) === true) return;
    const value = line;
    line = "";
    cursor = 0;
    if (questionResolver) {
      const resolve = questionResolver;
      questionResolver = null;
      questionRejecter = null;
      restoreDraft();
      resolve(value);
      render();
      return;
    }
    events.emit("line", value);
  }

  function onKeypress(str, key = {}) {
    if (closed || inputMode === "blocked") return;
    const name = String(key.name || "").toLowerCase();
    // node:readline's own decoder recognizes the bracketed-paste boundary
    // sequences (ESC[200~ / ESC[201~) as these two dedicated key names --
    // verified directly against a real readline keypress stream, not
    // assumed -- rather than splitting them into individual characters like
    // ordinary text. Toggle paste-buffering right here in the same handler
    // that receives every keypress event for the pasted characters in
    // between, so there is no second listener racing this one over the
    // same bytes (an earlier version tried a parallel raw "data" listener and
    // hit exactly that race: both fired for the same chunk and the paste
    // landed in the line twice, markers and all).
    if (name === "paste-start") { pasting = true; pasteBuffer = ""; return; }
    if (name === "paste-end") {
      pasting = false;
      const pasted = pasteBuffer;
      pasteBuffer = "";
      if (pasted) {
        line = `${line.slice(0, cursor)}${pasted}${line.slice(cursor)}`;
        cursor += pasted.length;
        events.emit("paste", pasted);
      }
      render();
      return;
    }
    if (pasting) {
      // Buffer verbatim, including characters that would otherwise be
      // special (Enter, Ctrl+U, ...) -- a multi-line paste must not submit
      // partway through just because it contains a newline. A raw CR
      // arrives with str populated too, so it needs an explicit check here
      // or it would keep the literal CR instead of becoming the LF
      // render()'s row-splitting already understands. Any other control
      // byte is dropped, matching the filter ordinary typing already
      // applies below.
      if (str === "\r" || str === "\n" || key.sequence === "\r" || key.sequence === "\n") pasteBuffer += "\n";
      else if (str && str.length && str.charCodeAt(0) >= 32 && str.charCodeAt(0) !== 127) pasteBuffer += str;
      return;
    }
    const sequence = key.sequence || str || "";
    if (key.ctrl && name === "c") return;
    if (name === "return" || name === "enter" || sequence === "\r" || sequence === "\n") {
      if (key.shift && !resolvedFixedRow()) {
        line = `${line.slice(0, cursor)}\n${line.slice(cursor)}`;
        cursor += 1;
        render();
      } else submit();
      return;
    }
    if (name === "backspace") {
      if (cursor > 0) { line = replaceGraphemes(line, cursor - 1, 1); cursor -= 1; render(); }
      return;
    }
    if (name === "delete") {
      if (cursor < graphemes(line).length) { line = replaceGraphemes(line, cursor, 1); render(); }
      return;
    }
    if (name === "left") { cursor = Math.max(0, cursor - 1); render(); return; }
    if (name === "right") { cursor = Math.min(graphemes(line).length, cursor + 1); render(); return; }
    if (name === "home" || (key.ctrl && name === "a")) { cursor = 0; render(); return; }
    if (name === "end" || (key.ctrl && name === "e")) { cursor = line.length; render(); return; }
    if (name === "up" || name === "down" || sequence === "\u001b[A" || sequence === "\u001b[B" || sequence === "\u001bOA" || sequence === "\u001bOB") return;
    if (key.ctrl && name === "u") { line = ""; cursor = 0; render(); return; }
    if (key.ctrl || key.meta || key.alt || !str || str.charCodeAt(0) < 32 || str.charCodeAt(0) === 127) return;
    line = replaceGraphemes(line, cursor, 0, str);
    cursor += graphemes(str).length;
    render();
  }

  emitKeypressEvents(input);
  if (input.isTTY && typeof input.setRawMode === "function") {
    rawBefore = Boolean(input.isRaw);
    input.setRawMode(true);
    input.resume();
  }
  input.on("keypress", onKeypress);
  // Ask the terminal to wrap paste content in ESC[200~ ... ESC[201~ markers
  // (see the "Bracketed paste" comment above) instead of sending it as
  // indistinguishable-from-typed raw bytes.
  if (output.isTTY) output.write(`${ESC}[?2004h`);
  output.write("\u001b[?25h");
  return editor;
}
