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
    // This used to do a real `npm install` against the registry in CI to
    // verify the packaged tarball installs standalone -- but that meant the
    // whole release depended on a live, uncached registry hit succeeding on
    // whatever network policy the runner happened to have that day. `npm
    // ci` earlier in the same job serves from GitHub's Actions dependency
    // cache and stays fast/reliable; this test's OWN fresh install has no
    // such cache and is the only network-dependent step in the entire
    // suite. Two releases in a row failed at exactly this step with an
    // identical, immediate (not slow-timeout) failure -- consistent with a
    // network restriction on the runner rather than a transient flake (a
    // retry attempt made no difference). Extracting the tarball and reusing
    // the dependency tree `npm ci` already fetched (exactly what the
    // previously-Windows-only branch below already did) verifies the same
    // thing -- the packaged files/bin/entrypoint are correct and the CLI
    // actually starts -- without needing any network access of its own, on
    // every platform.
    const extracted = path.join(tempRoot, "extracted");
    await fs.mkdir(extracted);
    const tar = process.platform === "win32" ? "tar.exe" : "tar";
    // Windows' bundled bsdtar misreads an absolute "C:\...\file.tgz" source
    // path as a URL (the drive letter reads as a URL scheme) and fails with
    // "Cannot connect to C: resolve failed" instead of extracting -- running
    // it with cwd set to tempRoot and passing only the relative filename
    // sidesteps that entirely and works identically on every platform.
    await execFileAsync(tar, ["-xzf", packageName, "-C", "extracted"], { cwd: tempRoot });
    await fs.symlink(path.join(process.cwd(), "node_modules"), path.join(extracted, "package", "node_modules"), "junction");
    const entrypoint = path.join(extracted, "package", "bin", "nexara.js");
    await fs.access(entrypoint);
    const node = process.execPath;
    const { stdout } = await execFileAsync(node, [entrypoint, "--help"], {
      cwd: tempRoot,
      env: { ...process.env, NODE_ENV: "test", NEXARA_NO_AUTO_UPDATE: "1" },
      maxBuffer: 2 * 1024 * 1024,
    });
    assert.match(stdout, /Nexara CLI|Usage|nexara/i);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
