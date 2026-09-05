import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

function runNpm(args, options) {
  if (process.platform !== "win32") return execFileAsync("npm", args, options);
  const quote = (value) => `"${String(value).replaceAll('"', '\\"')}"`;
  const npmPath = path.join(path.dirname(process.execPath), "npm.cmd");
  const command = [quote(npmPath), ...args.map(quote)].join(" ");
  return execFileAsync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${command}"`], {
    ...options,
    windowsVerbatimArguments: true,
  });
}

test("packed CLI installs and starts without the source checkout", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nexara-cli-pack-"));
  try {
    await runNpm(["pack", "--silent", "--pack-destination", tempRoot], {
      cwd: process.cwd(),
      env: { ...process.env, npm_config_cache: path.join(tempRoot, "npm-cache") },
      maxBuffer: 2 * 1024 * 1024,
    });
    const packageName = (await fs.readdir(tempRoot)).find((name) => /^nexara-cli-.*\.tgz$/.test(name));
    assert.ok(packageName, "npm pack must create a CLI tarball");
    let entrypoint;
    let launchCwd = tempRoot;
    if (process.env.CI === "true") {
      const installRoot = path.join(tempRoot, "installed");
      await runNpm(["install", "--prefix", installRoot, path.join(tempRoot, packageName), "--ignore-scripts", "--no-audit", "--no-fund"], {
        cwd: process.cwd(),
        env: { ...process.env, npm_config_cache: path.join(tempRoot, "npm-cache") },
        maxBuffer: 4 * 1024 * 1024,
      });
      entrypoint = path.join(installRoot, "node_modules", "nexara-cli", "bin", "nexara.js");
      launchCwd = installRoot;
    } else {
      // Local sandboxes may intentionally deny registry access. Extract the
      // exact tarball and link only the already-installed dependency tree so
      // this smoke test remains useful without weakening the CI install test.
      const extracted = path.join(tempRoot, "extracted");
      await fs.mkdir(extracted);
      const tar = process.platform === "win32" ? "tar.exe" : "tar";
      await execFileAsync(tar, ["-xzf", path.join(tempRoot, packageName), "-C", extracted]);
      await fs.symlink(path.join(process.cwd(), "node_modules"), path.join(extracted, "package", "node_modules"), "junction");
      entrypoint = path.join(extracted, "package", "bin", "nexara.js");
    }
    await fs.access(entrypoint);
    const node = process.execPath;
    const { stdout } = await execFileAsync(node, [entrypoint, "--help"], {
      cwd: launchCwd,
      env: { ...process.env, NODE_ENV: "test", NEXARA_NO_AUTO_UPDATE: "1" },
      maxBuffer: 2 * 1024 * 1024,
    });
    assert.match(stdout, /Nexara CLI|Usage|nexara/i);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
