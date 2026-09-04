import assert from "node:assert/strict";
import test from "node:test";

import { resolveWorkspacePath, toolAllowedByMode } from "../src/tools.js";

test("sandboxed and automatic modes do not grant shell or destructive tools", () => {
  for (const mode of ["auto", "sandboxed"]) {
    assert.equal(toolAllowedByMode("Write", mode), true);
    assert.equal(toolAllowedByMode("Bash", mode), false);
    assert.equal(toolAllowedByMode("Delete", mode), false);
    assert.equal(toolAllowedByMode("GitCheckout", mode), false);
  }
});

test("workspace path resolver rejects traversal outside the workspace", () => {
  assert.throws(() => resolveWorkspacePath("../outside", "C:/workspace/project"), /outside the workspace/);
  assert.equal(resolveWorkspacePath("src/index.js", "C:/workspace/project"), "C:\\workspace\\project\\src\\index.js");
});
