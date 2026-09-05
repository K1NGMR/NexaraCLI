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
  assert.throws(() => resolveWorkspacePath("../outside", "C:/workspace/project"), /outside the workspace/);
  assert.equal(resolveWorkspacePath("src/index.js", "C:/workspace/project"), "C:\\workspace\\project\\src\\index.js");
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
