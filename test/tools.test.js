import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { executeCliTool, resolveWorkspacePath, toolAllowedByMode } from "../src/tools.js";

test("sandboxed and automatic modes permit shell execution but block destructive tools", () => {
  for (const mode of ["auto", "sandboxed"]) {
    assert.equal(toolAllowedByMode("Write", mode), true);
    assert.equal(toolAllowedByMode("Bash", mode), true);
    assert.equal(toolAllowedByMode("Delete", mode), false);
    assert.equal(toolAllowedByMode("GitCheckout", mode), false);
  }
});

test("workspace path resolver rejects traversal outside the workspace", () => {
  // A hardcoded Windows-style literal ("C:/workspace/project") only means
  // "absolute path" on Windows -- resolveWorkspacePath resolves through
  // node:path, which is intentionally platform-native (a real CLI process
  // resolves paths the way its own host OS does), so on Linux/macOS that
  // same literal is just a relative path with a weird "C:" first segment
  // and gets joined onto the real cwd instead of staying put. This never
  // surfaced locally (only ever run on Windows) until it broke CI on
  // Ubuntu. path.resolve(path.sep, ...) builds a synthetic, guaranteed-
  // absolute root the same way on every platform (an actual drive-rooted
  // path on Windows, a plain absolute path on POSIX) without ever touching
  // a real directory, keeping the original synthetic-path intent.
  const workspaceRoot = path.resolve(path.sep, "workspace", "project");
  assert.throws(() => resolveWorkspacePath("../outside", workspaceRoot), /outside the workspace/);
  assert.equal(resolveWorkspacePath("src/index.js", workspaceRoot), path.join(workspaceRoot, "src", "index.js"));
});

test("glob supports root-level matches with a recursive pattern", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexara-glob-"));
  try {
    await fs.writeFile(path.join(root, "root.js"), "export {};\n");
    await fs.mkdir(path.join(root, "nested"));
    await fs.writeFile(path.join(root, "nested", "child.js"), "export {};\n");
    const result = await executeCliTool("Glob", { pattern: "**/*.js" }, { cwd: root });
    assert.match(result, /root\.js/);
    assert.match(result, /nested[\\/]child\.js/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("GitShow fails instead of returning misleading stderr", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexara-git-"));
  try {
    await assert.rejects(() => executeCliTool("GitShow", { revision: "does-not-exist" }, { cwd: root }), /git show failed|not a git repository|unknown revision|bad object/i);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
