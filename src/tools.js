import fs from "node:fs/promises";
import fsSync from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "build",
  "dist",
  "release",
  ".next",
  ".turbo",
  "coverage",
]);
// 1.5 MB (~375k tokens) was technically "capped" but could still overflow a
// model's entire context window in a single tool result. Bounded to
// something a turn can actually absorb alongside the rest of the
// conversation.
const MAX_READ_BYTES = 300_000;
const MAX_SEARCH_FILES = 3_000;
const MAX_SEARCH_MATCHES = 200;
const MAX_COMMAND_OUTPUT = 30_000;

// Keep this list deliberately small. The server-side harness contains many
// more tools, but loading every schema on every CLI request wastes context and
// makes it harder for a weaker model to choose the right action.
export const CLI_LOCAL_TOOL_NAMES = new Set([
  "List",
  "Read",
  "Search",
  "Write",
  "Edit",
  "Bash",
  "RunInBackground",
  "BackgroundOutput",
  "StopBackground",
  "CheckPort",
  "Delete",
  "Mkdir",
  "Copy",
  "Move",
  "Glob",
  "GitStatus",
  "GitLog",
  "GitDiff",
  "GitBranch",
  "GitCheckout",
  "GitCommit",
  "GitStash",
  "GitBlame",
  "GitShow",
  "CurrentTime",
  "GetSystemInfo",
  "GetEnv",
  "GetFileInfo",
  "Diff",
  "WebFetch",
  "ListProcesses",
  "KillProcess",
  "Zip",
  "Unzip",
  "OpenFile",
  "RevealInExplorer",
  "OpenExternal",
  "ApplyDiff",
  "TodoWrite",
  "RenameSymbol",
  "ScaffoldFile",
  "SymbolSearch",
  "FindReferences",
  "LocateDefinition",
  "CodeOutline",
  "ImportGraph",
  "ModuleExports",
  "DependencyTree",
  "DeadCodeScan",
  "TypeCheck",
  "LspDiagnostics",
  "SpawnAgent",
  "CheckSubagent",
  "StopSubagent",
  "ListSubagents",
  "McpList",
  "SkillList",
  "PluginList",
]);

export const CLI_CLIENT_TOOL_NAMES = new Set([...CLI_LOCAL_TOOL_NAMES, "ask_question"]);

const MUTATING_TOOLS = new Set([
  "Write",
  "Edit",
  "Bash",
  "RunInBackground",
  "StopBackground",
  "Delete",
  "Mkdir",
  "Copy",
  "Move",
  "GitCheckout",
  "GitCommit",
  "GitStash",
  "KillProcess",
  "Zip",
  "Unzip",
  "OpenFile",
  "RevealInExplorer",
  "OpenExternal",
  "ApplyDiff",
  "RenameSymbol",
  "ScaffoldFile",
  "SpawnAgent",
  "StopSubagent",
]);

const EDIT_TOOLS = new Set(["Write", "Edit", "Mkdir", "Copy", "Move", "ApplyDiff", "RenameSymbol", "ScaffoldFile", "Zip", "Unzip"]);
const COMMAND_TOOLS = new Set(["Bash", "RunInBackground", "StopBackground", "KillProcess", "GitCheckout", "GitCommit", "GitStash", "SpawnAgent", "StopSubagent"]);

const ALLOWED_COMMANDS = new Set([
  "adb",
  "bash",
  "cat",
  "cargo",
  "cp",
  "dotnet",
  "echo",
  "eslint",
  "find",
  "git",
  "gradle",
  "gradlew",
  "gradlew.bat",
  "java",
  "javac",
  "ls",
  "mvn",
  "node",
  "npm",
  "pnpm",
  "bun",
  "npx",
  "pip",
  "pip3",
  "prettier",
  "py",
  "python",
  "python3",
  "go",
  "pwd",
  "rg",
  "ruby",
  "rustc",
  "sed",
  "ps",
  "pkill",
  "tar",
  "tail",
  "tasklist",
  "taskkill",
  "powershell",
  "pwsh",
  "cmd",
  "tsc",
  "type",
  "vite",
  "where",
  "which",
  "yarn",
  "sh",
  "make",
  "cmake",
  "zip",
]);

const WINDOWS_COMMAND_ALIASES = new Map([
  ["npm", "npm.cmd"],
  ["npx", "npx.cmd"],
  ["yarn", "yarn.cmd"],
  ["tsc", "tsc.cmd"],
  ["vite", "vite.cmd"],
  ["eslint", "eslint.cmd"],
  ["prettier", "prettier.cmd"],
]);

const backgroundProcesses = new Map();
let backgroundSequence = 0;
const localAgents = new Map();
let agentSequence = 0;

export function isLocalTool(name) {
  return CLI_LOCAL_TOOL_NAMES.has(String(name || ""));
}

export function isMutatingTool(name) {
  return MUTATING_TOOLS.has(String(name || ""));
}

export function permissionModeLabel(mode) {
  return ({
    ask: "Always ask",
    "read-only": "Read-only",
    plan: "Plan mode",
    "allow-edits": "Edits allowed",
    "allow-commands": "Commands allowed",
    auto: "Approve for me",
    sandboxed: "Sandboxed",
    full: "Full access",
  })[mode] || "Always ask";
}

export function toolAllowedByMode(name, mode = "ask") {
  const toolName = String(name || "");
  if (!isMutatingTool(toolName)) return true;
  if (mode === "read-only" || mode === "plan") return false;
  if (mode === "allow-edits") return EDIT_TOOLS.has(toolName);
  if (mode === "allow-commands") return EDIT_TOOLS.has(toolName) || COMMAND_TOOLS.has(toolName);
  // Automatic and sandboxed modes must never silently grant arbitrary shell
  // execution or destructive process/repository operations. Those require an
  // explicit command-capable or full-access mode.
  // Automatic modes still run through the command allowlist and workspace
  // path gate. They can build and test, but cannot kill processes, mutate Git,
  // or spawn subagents without an explicit command-capable mode.
  if (mode === "auto" || mode === "sandboxed") {
    return EDIT_TOOLS.has(toolName) || ["Bash", "RunInBackground", "StopBackground"].includes(toolName);
  }
  return mode === "full";
}

function normalizedRelative(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^\.\//, "");
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function resolveWorkspacePath(value, cwd, { allowOutside = false } = {}) {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error("A file or directory path is required.");
  const resolved = path.resolve(cwd, raw);
  if (!allowOutside && !isInside(cwd, resolved)) {
    const error = new Error(`Path is outside the workspace: ${resolved}`);
    error.code = "OUTSIDE_WORKSPACE";
    error.path = resolved;
    throw error;
  }
  if (!allowOutside && fsSync.existsSync(cwd)) {
    let probe = resolved;
    while (!fsSync.existsSync(probe) && probe !== path.dirname(probe)) probe = path.dirname(probe);
    const realRoot = fsSync.existsSync(cwd) ? fsSync.realpathSync.native(cwd) : path.resolve(cwd);
    const realProbe = fsSync.existsSync(probe) ? fsSync.realpathSync.native(probe) : path.resolve(probe);
    if (!isInside(realRoot, realProbe)) {
      const error = new Error(`Path resolves outside the workspace: ${resolved}`);
      error.code = "OUTSIDE_WORKSPACE";
      error.path = resolved;
      throw error;
    }
  }
  return resolved;
}

function firstArg(args, ...keys) {
  for (const key of keys) {
    const value = args?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export function toolPaths(name, args = {}, cwd = process.cwd()) {
  const paths = [];
  const add = (value) => {
    if (typeof value !== "string" || !value.trim()) return;
    const resolved = path.resolve(cwd, value.trim());
    if (!isInside(cwd, resolved)) paths.push(resolved);
  };
  switch (String(name || "")) {
    case "Read":
    case "Write":
    case "Edit":
    case "Delete":
    case "GetFileInfo":
    case "GitDiff":
    case "GitBlame":
    case "GitShow":
    case "Diff":
    case "OpenFile":
    case "RevealInExplorer":
    case "ApplyDiff":
      add(firstArg(args, "file_path", "path", "filepath", "file", "filename", "path_a", "source"));
      add(firstArg(args, "path_b", "destination"));
      break;
    case "GitCommit":
      for (const value of Array.isArray(args.paths) ? args.paths : []) add(value);
      break;
    case "List":
    case "Glob":
      add(firstArg(args, "directory", "path"));
      break;
    case "Mkdir":
      add(firstArg(args, "directory_path", "path", "directory"));
      break;
    case "Copy":
    case "Move":
      add(firstArg(args, "source", "path_a"));
      add(firstArg(args, "destination", "path_b"));
      break;
    case "Zip":
      add(firstArg(args, "archive_path", "path"));
      for (const source of Array.isArray(args.sources) ? args.sources : []) add(source);
      break;
    case "Unzip":
      add(firstArg(args, "archive_path", "path"));
      add(firstArg(args, "destination"));
      break;
    case "Bash":
    case "RunInBackground": {
      // Shell commands can hide paths in arguments (for example, `cd ..` or
      // `python C:\\other-project\\server.py`). Surface those paths to the
      // same approval gate used by file tools.
      const command = firstArg(args, "command", "cmd", "script");
      for (const token of tokenizeCommand(command)) {
        const candidate = token.includes("=") ? token.slice(token.indexOf("=") + 1) : token;
        const looksLikePath = path.isAbsolute(candidate)
          || path.win32.isAbsolute(candidate)
          || candidate.split(/[\\/]/).includes("..");
        if (looksLikePath) add(candidate);
      }
      break;
    }
    default:
      break;
  }
  return paths;
}

async function walk(root, { maxFiles = MAX_SEARCH_FILES, maxDepth = 12 } = {}) {
  const files = [];
  async function visit(directory, depth) {
    if (files.length >= maxFiles || depth > maxDepth) return;
    let entries = [];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(full, depth + 1);
      else if (entry.isFile()) files.push(full);
    }
  }
  await visit(root, 0);
  return files;
}

function relativePath(filePath, cwd) {
  const relative = path.relative(cwd, filePath);
  return relative ? relative.replaceAll(path.sep, "/") : ".";
}

const TRUNCATION_MARKER = "… earlier output truncated …\n";
// Command/background output is accumulated incrementally (this runs again on
// every new chunk). Keeping the HEAD meant that once a long build or dev
// server crossed the cap, every later line -- including the final error or
// "server started" message -- was silently dropped forever. Keep the TAIL
// instead, and strip any marker already present so repeated calls don't pile
// up multiple copies of it as output keeps growing.
function truncate(value, max = MAX_COMMAND_OUTPUT) {
  let text = String(value ?? "");
  if (text.startsWith(TRUNCATION_MARKER)) text = text.slice(TRUNCATION_MARKER.length);
  return text.length > max ? `${TRUNCATION_MARKER}${text.slice(text.length - max)}` : text;
}

function globToRegExp(pattern) {
  const normalized = normalizedRelative(pattern || "**/*");
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === "*" && normalized[index + 1] === "*") {
      // `**/` can match zero directories, so `**/*.js` also matches a root
      // level `index.js`.
      if (normalized[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
    } else if (character === "*") source += "[^/]*";
    else if (character === "?") source += "[^/]";
    else source += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "i");
}

const CODE_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cs", ".css", ".go", ".h", ".hpp", ".html", ".java", ".js", ".jsx",
  ".json", ".kt", ".md", ".php", ".py", ".rb", ".rs", ".scss", ".sh", ".sql", ".swift", ".ts",
  ".tsx", ".vue", ".xml", ".yaml", ".yml",
]);

function escapedRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function sourceFiles(cwd, directory = ".") {
  const root = resolveWorkspacePath(directory, cwd);
  const files = await walk(root);
  return files.filter((file) => CODE_EXTENSIONS.has(path.extname(file).toLowerCase()));
}

async function readCodeFile(filePath) {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat?.isFile() || stat.size > MAX_READ_BYTES) return null;
  const content = await fs.readFile(filePath, "utf8").catch(() => null);
  return content === null || content.includes("\u0000") ? null : content;
}

function codeLineMatches(content, matcher) {
  const matches = [];
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (matcher.test(lines[index])) matches.push({ line: index + 1, text: lines[index].trim().slice(0, 260) });
    matcher.lastIndex = 0;
  }
  return matches;
}

function definitionMatcher(symbol) {
  const escaped = escapedRegExp(symbol);
  return new RegExp(`(?:^|\\s|[;{}])(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function|class|interface|type|enum|const|let|var|def|fn|struct|trait)\\s+${escaped}\\b|(?:public|private|protected|internal|static|final|abstract|sealed|data)\\s+(?:class|interface|object|fun|void|[A-Za-z_$][\\w$<>\\[\\]]*\\s+)${escaped}\\b`, "i");
}

async function symbolSearch(symbol, cwd, { definitionsOnly = false, directory = "." } = {}) {
  const name = String(symbol || "").trim();
  if (!name) throw new Error("A symbol name is required.");
  const files = await sourceFiles(cwd, directory);
  const word = new RegExp(`\\b${escapedRegExp(name)}\\b`, "g");
  const definition = definitionMatcher(name);
  const rows = [];
  for (const file of files) {
    const content = await readCodeFile(file);
    if (content === null) continue;
    const matcher = definitionsOnly ? definition : word;
    for (const match of codeLineMatches(content, matcher)) rows.push(`${relativePath(file, cwd)}:${match.line}: ${match.text}`);
    if (rows.length >= MAX_SEARCH_MATCHES) break;
  }
  return rows.join("\n") || `No ${definitionsOnly ? "definition" : "reference"} found for ${name}.`;
}

function resolveImportPath(importPath, fromFile, cwd) {
  if (!importPath.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), importPath);
  const candidates = [base, ...[".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".json"].map((extension) => `${base}${extension}`), ...["index.js", "index.ts", "index.tsx"].map((name) => path.join(base, name))];
  return candidates.find((candidate) => isInside(cwd, candidate)) || null;
}

async function startLocalAgent(args, cwd) {
  const task = String(args.task || "Background task").trim();
  const prompt = String(args.prompt || "").trim();
  if (!prompt) throw new Error("SpawnAgent requires a prompt.");
  const id = `agent-${++agentSequence}`;
  const script = process.argv[1] || path.resolve(cwd, "bin", "nexara.js");
  const child = spawn(process.execPath, [script, "--print", "--output-format", "json", "--no-session-persistence", "--permission-mode", "read-only", "--max-turns", "12", prompt], {
    cwd,
    shell: false,
    windowsHide: true,
    env: { ...process.env, NEXARA_NO_ANIMATION: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const entry = { id, task, child, output: "", result: "", status: "running", startedAt: Date.now(), finishedAt: null };
  const append = (chunk) => { entry.output = truncate(`${entry.output}${chunk.toString()}`, MAX_COMMAND_OUTPUT); };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.once("error", (error) => { entry.status = "error"; entry.result = error.message; });
  child.once("close", (code) => {
    entry.finishedAt = Date.now();
    entry.status = code === 0 ? "done" : "error";
    const lines = entry.output.trim().split(/\r?\n/).reverse();
    const payload = lines.map((line) => { try { return JSON.parse(line); } catch { return null; } }).find(Boolean);
    entry.result = payload?.text || entry.output.trim() || (code === 0 ? "(no output)" : `Agent exited with code ${code}.`);
  });
  localAgents.set(id, entry);
  return `Started background agent ${id} (${task}). Use CheckSubagent with id ${id}.`;
}

function subagentResult(id) {
  const entry = localAgents.get(id);
  if (!entry) throw new Error(`Unknown subagent: ${id}`);
  const elapsed = (entry.finishedAt || Date.now()) - entry.startedAt;
  return `Agent ${id} · ${entry.status} · ${Math.round(elapsed / 1000)}s · ${entry.task}\n${entry.result || entry.output || "(still working)"}`;
}

function tokenizeCommand(command) {
  const source = String(command || "").trim();
  if (!source) throw new Error("Bash requires a command.");
  if (/[;&|<>`\n\r]/.test(source)) {
    throw new Error("For safety, Bash accepts one command only and does not allow shell operators or redirection.");
  }
  const tokens = source.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]+/g) || [];
  const unquote = (token) => token.replace(/^(['"])(.*)\1$/s, "$2").replace(/\\([\\"'])/g, "$1");
  return tokens.map(unquote);
}

function commandName(command) {
  return path.basename(command).toLowerCase().replace(/\.cmd$|\.exe$|\.bat$/i, "");
}

// Node's fix for CVE-2024-27980 made spawning a .cmd/.bat file directly with
// shell:false throw EINVAL on Windows -- it used to just work. npm, npx,
// yarn, tsc, vite, eslint, and prettier are all aliased to their .cmd
// wrapper above, so every command routed through one of them failed
// unconditionally. shell:true is Node's documented workaround, but Node
// itself warns that when shell:true is combined with an args ARRAY, it only
// concatenates them without escaping -- unsafe for arguments an AI agent
// generated. So for these files only, build one properly cmd.exe-quoted
// command string ourselves (verified: an argument containing shell
// metacharacters stays one literal argument, never a second command) and
// pass shell:true with no separate args array.
function needsWindowsCmdShell(executable) {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(executable);
}

function quoteForWindowsCmd(value) {
  const str = String(value);
  if (!/[\s&|<>^%"]/.test(str)) return str;
  return `"${str.replace(/"/g, '""')}"`;
}

function spawnPossiblyBatch(executable, args, options) {
  if (needsWindowsCmdShell(executable)) {
    const commandLine = [executable, ...args].map(quoteForWindowsCmd).join(" ");
    return spawn(commandLine, { ...options, shell: true });
  }
  return spawn(executable, args, { ...options, shell: false });
}

// child.kill() only signals the direct child. On Windows that is routinely
// not the actual work: npm/npx/yarn/tsc/etc. are .cmd wrappers, so the real
// process is a grandchild of cmd.exe, and build tools commonly spawn further
// children of their own -- none of which Windows tears down just because
// their parent died (no process-group semantics like POSIX SIGKILL-to-group).
// A timed-out or cancelled command left those running: a dev server still
// holding its port, a compiler still holding a file lock, silently breaking
// the NEXT command that needed the same port/file.
function killProcessTree(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
      .once("error", () => child.kill());
    return;
  }
  child.kill();
}

async function runCommand(command, cwd, { background = false, allowOutside = false, signal } = {}) {
  if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
  let tokens = tokenizeCommand(command);
  const environment = { ...process.env };
  while (tokens.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) {
    const separator = tokens[0].indexOf("=");
    environment[tokens[0].slice(0, separator)] = tokens[0].slice(separator + 1);
    tokens = tokens.slice(1);
  }
  const outsidePaths = toolPaths("Bash", { command }, cwd);
  if (outsidePaths.length && !allowOutside) {
    const error = new Error(`Command references a path outside the workspace: ${outsidePaths.join(", ")}`);
    error.code = "OUTSIDE_WORKSPACE";
    error.path = outsidePaths[0];
    throw error;
  }
  const name = commandName(tokens[0]);
  if (!ALLOWED_COMMANDS.has(name)) {
    throw new Error(`Command blocked by the Nexara CLI safety policy: ${name}. Use /permission full only when you understand the risk.`);
  }
  const executable = process.platform === "win32" ? WINDOWS_COMMAND_ALIASES.get(name) || tokens[0] : tokens[0];
  if (background) {
    const id = `bg-${++backgroundSequence}`;
    const child = spawnPossiblyBatch(executable, tokens.slice(1), {
      cwd,
      env: environment,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const entry = { id, command, child, output: "", startedAt: Date.now(), lastOutputAt: Date.now() };
    const append = (chunk) => {
      entry.output = truncate(`${entry.output}${chunk.toString()}`, MAX_COMMAND_OUTPUT);
      entry.lastOutputAt = Date.now();
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", (error) => append(`\n${error.message}\n`));
    child.once("close", (code, signal) => {
      entry.exitCode = typeof code === "number" ? code : -1;
      entry.signal = signal || null;
      entry.finishedAt = Date.now();
    });
    backgroundProcesses.set(id, entry);
    return { id, pid: child.pid, command };
  }
  return await new Promise((resolve, reject) => {
    const child = spawnPossiblyBatch(executable, tokens.slice(1), {
      cwd,
      env: environment,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let cancelled = false;
    const timer = setTimeout(() => {
      killProcessTree(child);
      resolve({ exitCode: -1, stdout, stderr: `${stderr}\nCommand timed out after 120 seconds.` });
    }, 120_000);
    const onAbort = () => {
      cancelled = true;
      killProcessTree(child);
    };
    signal?.addEventListener("abort", onAbort);
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    child.stdout.on("data", (chunk) => { stdout = truncate(`${stdout}${chunk.toString()}`); });
    child.stderr.on("data", (chunk) => { stderr = truncate(`${stderr}${chunk.toString()}`); });
    child.once("error", (error) => {
      cleanup();
      if (cancelled) resolve({ exitCode: -1, stdout, stderr: `${stderr}\nCommand cancelled by user.`, cancelled: true });
      else reject(error);
    });
    child.once("close", (exitCode, exitSignal) => {
      cleanup();
      if (cancelled) resolve({ exitCode: -1, stdout, stderr: `${stderr}\nCommand cancelled by user.`, cancelled: true });
      else resolve({ exitCode: typeof exitCode === "number" ? exitCode : -1, signal: exitSignal, stdout, stderr });
    });
  });
}

async function executeGit(args, cwd) {
  const quote = (value) => {
    const text = String(value);
    return /^[A-Za-z0-9_./:=+@-]+$/.test(text)
      ? text
      : `"${text.replace(/(["\\])/g, "\\$1")}"`;
  };
  const command = ["git", ...args].map(quote).join(" ");
  return runCommand(command, cwd);
}

async function checkPort(port, host = "127.0.0.1") {
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort <= 0 || numericPort > 65535) throw new Error("CheckPort requires a valid port.");
  const started = Date.now();
  while (Date.now() - started < 4_000) {
    const result = await new Promise((resolve) => {
      const socket = net.createConnection({ host, port: numericPort });
      const finish = (open) => {
        socket.destroy();
        resolve(open);
      };
      socket.setTimeout(500, () => finish(false));
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
    });
    if (result) return `${host}:${numericPort} is accepting connections.`;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return `${host}:${numericPort} is not accepting connections.`;
}

async function applyUnifiedDiff(filePath, patch, cwd, { signal } = {}) {
  const patchPaths = String(patch || "")
    .split(/\r?\n/)
    .filter((line) => /^(?:---|\+\+\+)\s+/.test(line))
    .map((line) => line.replace(/^(?:---|\+\+\+)\s+/, "").split(/\s+/)[0])
    .map((value) => value.replace(/^[ab][\\/]/, ""))
    .filter((value) => value && value !== "/dev/null");
  for (const patchPath of patchPaths) resolveWorkspacePath(patchPath, cwd);
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.platform === "win32" ? "git.exe" : "git", ["apply", "--whitespace=nowarn", "-"], {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let cancelled = false;
    // git apply reading from a patch that never closes stdin, or a stuck
    // filesystem, previously had no way to end at all -- unlike Bash it had
    // neither a timeout nor a cancellation path.
    const timer = setTimeout(() => {
      cancelled = true;
      killProcessTree(child);
    }, 120_000);
    const onAbort = () => {
      cancelled = true;
      killProcessTree(child);
    };
    signal?.addEventListener("abort", onAbort);
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (code) => {
      cleanup();
      resolve({ code: cancelled ? -1 : code, stdout, stderr: cancelled ? `${stderr}\nApplyDiff cancelled or timed out.` : stderr });
    });
    child.stdin.end(String(patch || ""));
  });
  if (result.code !== 0) {
    throw new Error(`Could not apply the unified diff. ${result.stderr.trim() || "Use Edit with exact old_string/new_string values."}`);
  }
  return result.stdout.trim() || `Applied patch to ${relativePath(filePath, cwd)}.`;
}

async function openWithSystem(filePath) {
  if (process.platform === "win32") await execFileAsync("explorer.exe", [filePath]);
  else if (process.platform === "darwin") await execFileAsync("open", [filePath]);
  else await execFileAsync("xdg-open", [filePath]);
}

async function openExternal(url) {
  const parsed = new URL(String(url || ""));
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("Only http(s) URLs can be opened.");
  if (process.platform === "win32") await execFileAsync("rundll32", ["url.dll,FileProtocolHandler", parsed.toString()]);
  else if (process.platform === "darwin") await execFileAsync("open", [parsed.toString()]);
  else await execFileAsync("xdg-open", [parsed.toString()]);
  return `Opened ${parsed.toString()}`;
}

function scaffoldContent(kind, name, lang) {
  const safeName = String(name || "Example").replace(/[^A-Za-z0-9_$-]/g, "");
  const language = String(lang || path.extname(safeName).slice(1) || "ts").toLowerCase();
  if (kind === "component") {
    if (["vue"].includes(language)) return `<script setup>\nconst props = defineProps<{ title?: string }>();\n</script>\n\n<template>\n  <section class="${safeName.toLowerCase()}">{{ props.title || "${safeName}" }}</section>\n</template>\n`;
    return `export function ${safeName}() {\n  return <div>${safeName}</div>;\n}\n`;
  }
  if (kind === "class") return language === "java" ? `public class ${safeName} {\n}\n` : `class ${safeName}:\n    pass\n`;
  if (kind === "test") return `describe("${safeName}", () => {\n  it("works", () => {\n    // Add an assertion for ${safeName}.\n  });\n});\n`;
  if (kind === "function" || kind === "lambda") return language === "py" || language === "python" ? `def ${safeName}(*args, **kwargs):\n    return None\n` : `export function ${safeName}(...args) {\n  return args;\n}\n`;
  return `export const ${safeName} = {};\n`;
}

async function workspaceIntegrationEntries(kind, cwd) {
  const candidates = kind === "mcp"
    ? [".mcp.json", ".nexara/mcp.json", ".claude/mcp.json"]
    : kind === "skills"
      ? [".nexara/skills", ".claude/skills", ".codex/skills"]
      : [".nexara/plugins", ".claude/plugins", ".codex/plugins"];
  const entries = [];
  for (const candidate of candidates) {
    const fullPath = path.join(cwd, candidate);
    const stat = await fs.stat(fullPath).catch(() => null);
    if (!stat) continue;
    if (stat.isDirectory()) {
      const names = await fs.readdir(fullPath, { withFileTypes: true }).catch(() => []);
      entries.push(`${candidate}: ${names.filter((entry) => entry.isDirectory()).map((entry) => entry.name).join(", ") || "(empty)"}`);
    } else {
      const content = await fs.readFile(fullPath, "utf8").catch(() => "");
      try {
        const parsed = JSON.parse(content);
        const servers = parsed.mcpServers || parsed.servers || parsed;
        entries.push(`${candidate}: ${Object.keys(servers || {}).join(", ") || "(configured, no named entries)"}`);
      } catch {
        entries.push(`${candidate}: present`);
      }
    }
  }
  return entries;
}

function agentSummary(id) {
  const entry = localAgents.get(id);
  if (!entry) throw new Error(`Unknown subagent: ${id}`);
  const elapsed = (entry.finishedAt || Date.now()) - entry.startedAt;
  return `Agent ${id} · ${entry.status} · ${Math.round(elapsed / 1000)}s · ${entry.task}\n${entry.result || entry.output || "(still working)"}`;
}

export async function executeCliTool(name, args = {}, { cwd = process.cwd(), allowOutside = false, signal } = {}) {
  const toolName = String(name || "");
  if (!isLocalTool(toolName)) throw new Error(`The CLI does not execute ${toolName}.`);
  const pathArg = (...keys) => resolveWorkspacePath(firstArg(args, ...keys), cwd, { allowOutside });
  switch (toolName) {
    case "List": {
      const directory = firstArg(args, "directory", "path") || ".";
      const root = resolveWorkspacePath(directory, cwd, { allowOutside });
      const files = await walk(root, { maxFiles: 500, maxDepth: 8 });
      return files.map((file) => relativePath(file, cwd)).join("\n") || "(empty workspace)";
    }
    case "Read": {
      const filePath = pathArg("file_path", "path", "filepath", "file", "filename");
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) throw new Error(`${filePath} is not a file.`);
      // "ReadLines" does not exist as a tool here -- pointing the model at it
      // sent it into a retry loop calling something that could never work.
      // Search and Bash (sed/tail/head are allowlisted) are real options.
      if (stat.size > MAX_READ_BYTES) throw new Error(`${relativePath(filePath, cwd)} is larger than ${Math.round(MAX_READ_BYTES / 1024)} KB. Use Search to find the relevant section, or Bash with sed/tail/head to view a portion of the file.`);
      return await fs.readFile(filePath, "utf8");
    }
    case "Search": {
      const pattern = firstArg(args, "pattern", "query");
      if (!pattern) throw new Error("Search requires pattern or query.");
      const root = resolveWorkspacePath(firstArg(args, "file_path", "path", "directory") || ".", cwd, { allowOutside });
      const regex = args.regex === true ? new RegExp(pattern, "i") : new RegExp(escapedRegExp(pattern), "i");
      const matches = [];
      const files = (await fs.stat(root).catch(() => null))?.isFile() ? [root] : await walk(root);
      for (const file of files) {
        if (matches.length >= MAX_SEARCH_MATCHES) break;
        const content = await fs.readFile(file, "utf8").catch(() => null);
        if (content === null || content.includes("\u0000")) continue;
        const lines = content.split(/\r?\n/);
        for (let index = 0; index < lines.length && matches.length < MAX_SEARCH_MATCHES; index += 1) {
          if (regex.test(lines[index])) matches.push(`${relativePath(file, cwd)}:${index + 1}: ${lines[index].trim().slice(0, 240)}`);
        }
      }
      return matches.join("\n") || "No matches.";
    }
    case "Glob": {
      const root = resolveWorkspacePath(firstArg(args, "directory", "path") || ".", cwd, { allowOutside });
      const pattern = firstArg(args, "pattern") || "**/*";
      const matcher = globToRegExp(pattern);
      const files = await walk(root);
      const matches = [];
      for (const file of files) {
        if (!matcher.test(relativePath(file, root))) continue;
        const stat = await fs.stat(file).catch(() => null);
        if (stat) matches.push({ file, modified: stat.mtimeMs });
      }
      matches.sort((a, b) => b.modified - a.modified || a.file.localeCompare(b.file));
      return matches.map(({ file }) => relativePath(file, cwd)).join("\n") || "No files matched.";
    }
    case "Write": {
      const filePath = pathArg("file_path", "path", "filepath", "file", "filename");
      const content = args.content ?? args.text ?? args.body ?? args.code ?? args.file_content ?? "";
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, String(content), "utf8");
      return `Wrote ${relativePath(filePath, cwd)} (${String(content).length} characters).`;
    }
    case "Edit": {
      const filePath = pathArg("file_path", "path", "filepath", "file", "filename");
      const current = await fs.readFile(filePath, "utf8");
      const oldString = String(args.old_string ?? args.oldString ?? args.old_str ?? args.old ?? args.search ?? args.find ?? "");
      const newString = String(args.new_string ?? args.newString ?? args.new_str ?? args.new ?? args.replace ?? args.replacement ?? "");
      if (!oldString) throw new Error("Edit requires old_string and new_string.");
      const occurrences = current.split(oldString).length - 1;
      if (!occurrences) throw new Error(`The requested text was not found in ${relativePath(filePath, cwd)}.`);
      if (occurrences > 1 && args.replace_all !== true) throw new Error(`The requested text occurs ${occurrences} times. Add replace_all=true or provide a more specific old_string.`);
      const next = args.replace_all === true ? current.split(oldString).join(newString) : current.replace(oldString, newString);
      await fs.writeFile(filePath, next, "utf8");
      return `Edited ${relativePath(filePath, cwd)} (${occurrences} replacement${occurrences === 1 ? "" : "s"}).`;
    }
    case "RenameSymbol": {
      const from = firstArg(args, "from", "symbol");
      const to = firstArg(args, "to", "replacement");
      if (!from || !to || !/^[A-Za-z_$][\w$]*$/.test(from) || !/^[A-Za-z_$][\w$]*$/.test(to)) throw new Error("RenameSymbol requires simple symbol names in from and to.");
      const extensions = Array.isArray(args.extensions)
        ? new Set(args.extensions.map((value) => `.${String(value).replace(/^\./, "").toLowerCase()}`))
        : null;
      const files = (await sourceFiles(cwd)).filter((file) => !extensions || extensions.has(path.extname(file).toLowerCase()));
      const matcher = new RegExp(`\\b${escapedRegExp(from)}\\b`, "g");
      const changes = [];
      for (const file of files) {
        const content = await readCodeFile(file);
        if (content === null || !matcher.test(content)) { matcher.lastIndex = 0; continue; }
        matcher.lastIndex = 0;
        const count = (content.match(matcher) || []).length;
        changes.push({ file, count, content });
      }
      // A tool named RenameSymbol should perform the requested rename after
      // the normal approval gate. Preview is still available explicitly with
      // dryRun=true; the old default silently did nothing and made the agent
      // report a successful-looking no-op.
      const dryRun = args.dryRun === true;
      if (!dryRun) for (const change of changes) await fs.writeFile(change.file, change.content.replace(matcher, to), "utf8");
      return `${dryRun ? "Preview" : "Renamed"} ${from} → ${to} in ${changes.length} file${changes.length === 1 ? "" : "s"}.\n${changes.map((change) => `${relativePath(change.file, cwd)} (${change.count} occurrence${change.count === 1 ? "" : "s"})`).join("\n") || "No matches."}`;
    }
    case "ScaffoldFile": {
      const filePath = pathArg("file_path", "path", "file");
      const kind = firstArg(args, "kind") || "module";
      const name = firstArg(args, "name") || path.basename(filePath, path.extname(filePath));
      const content = scaffoldContent(kind, name, firstArg(args, "lang") || path.extname(filePath).slice(1));
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content, "utf8");
      return `Scaffolded ${relativePath(filePath, cwd)} (${kind}).`;
    }
    case "SymbolSearch":
      return symbolSearch(firstArg(args, "symbol", "name"), cwd, { definitionsOnly: true });
    case "FindReferences":
      return symbolSearch(firstArg(args, "symbol", "name"), cwd);
    case "LocateDefinition": {
      const symbol = firstArg(args, "symbol", "name");
      const file = firstArg(args, "file", "file_path");
      const listing = file
        ? await symbolSearch(symbol, cwd, { definitionsOnly: true, directory: path.dirname(file) || "." })
        : await symbolSearch(symbol, cwd, { definitionsOnly: true });
      if (!file || listing.startsWith("No definition")) return listing;
      const filePath = resolveWorkspacePath(file, cwd);
      const content = await readCodeFile(filePath);
      const first = codeLineMatches(content || "", definitionMatcher(symbol))[0];
      if (!first) return listing;
      const lines = (content || "").split(/\r?\n/);
      return lines.slice(Math.max(0, first.line - 6), Math.min(lines.length, first.line + 6)).map((line, index) => `${Math.max(1, first.line - 5) + index}: ${line}`).join("\n");
    }
    case "CodeOutline": {
      const filePath = pathArg("file_path", "path", "file");
      const content = await readCodeFile(filePath);
      if (content === null) throw new Error("CodeOutline could not read that source file.");
      const outline = [];
      const matcher = /^\s*(?:(?:export|default|public|private|protected|static|async|function|def|fn)\s+)*(?:function|class|interface|type|enum|const|let|var|def|fn|struct|trait)\s+([A-Za-z_$][\w$]*)/gm;
      let match;
      while ((match = matcher.exec(content)) && outline.length < 200) outline.push(`${content.slice(0, match.index).split(/\r?\n/).length}: ${match[0].trim()}`);
      return outline.join("\n") || "No top-level definitions found.";
    }
    case "ImportGraph": {
      const filePath = pathArg("file_path", "path", "file");
      const content = await readCodeFile(filePath);
      if (content === null) throw new Error("ImportGraph could not read that source file.");
      const imports = [...content.matchAll(/(?:import\s+(?:[^"']+\s+from\s+)?|require\(|from\s+)["']([^"']+)["']/g)].map((match) => match[1]);
      const relatives = imports.map((value) => {
        const resolved = resolveImportPath(value, filePath, cwd);
        return resolved ? relativePath(resolved, cwd) : null;
      });
      if (String(args.direction || "outgoing").toLowerCase() !== "incoming") {
        return `Imports from ${relativePath(filePath, cwd)}:\n${imports.map((value, index) => `- ${value}${relatives[index] ? ` → ${relatives[index]}` : ""}`).join("\n") || "(none)"}`;
      }
      const target = path.normalize(filePath);
      const importers = [];
      for (const candidate of await sourceFiles(cwd)) {
        const source = await readCodeFile(candidate);
        if (!source) continue;
        const resolved = [...source.matchAll(/(?:import\s+(?:[^"']+\s+from\s+)?|require\(|from\s+)["']([^"']+)["']/g)]
          .map((match) => resolveImportPath(match[1], candidate, cwd))
          .find((value) => value && path.normalize(value) === target);
        if (resolved) importers.push(relativePath(candidate, cwd));
      }
      return `Imported by ${relativePath(filePath, cwd)}:\n${importers.map((value) => `- ${value}`).join("\n") || "(none)"}`;
    }
    case "ModuleExports": {
      const filePath = pathArg("file_path", "path", "file");
      const content = await readCodeFile(filePath);
      if (content === null) throw new Error("ModuleExports could not read that source file.");
      const exports = new Set([...content.matchAll(/\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g)].map((match) => match[1]));
      for (const match of content.matchAll(/\bexport\s*\{([^}]+)\}/g)) for (const item of match[1].split(",")) exports.add(item.trim().split(/\s+as\s+/i)[0]);
      return [...exports].filter(Boolean).join("\n") || "No named exports found.";
    }
    case "DependencyTree": {
      const entryPath = pathArg("entry", "file_path", "path");
      const maxDepth = Math.max(0, Math.min(8, Number(args.depth) || 3));
      const seen = new Set();
      const lines = [];
      async function visit(filePath, depth) {
        const key = path.normalize(filePath);
        const indent = "  ".repeat(depth);
        if (seen.has(key)) { lines.push(`${indent}↺ ${relativePath(filePath, cwd)}`); return; }
        seen.add(key);
        lines.push(`${indent}${relativePath(filePath, cwd)}`);
        if (depth >= maxDepth) return;
        const content = await readCodeFile(filePath);
        if (!content) return;
        for (const match of content.matchAll(/(?:import\s+(?:[^"']+\s+from\s+)?|require\(|from\s+)["']([^"']+)["']/g)) {
          const target = resolveImportPath(match[1], filePath, cwd);
          if (target && await fs.stat(target).then((stat) => stat.isFile()).catch(() => false)) await visit(target, depth + 1);
        }
      }
      await visit(entryPath, 0);
      return lines.join("\n");
    }
    case "DeadCodeScan": {
      // Every matching file's full content is held in memory at once to
      // build the corpus (then joined into a second, duplicate copy) --
      // with no cap beyond the per-file read limit, a large project could
      // approach a gigabyte of held text and crash the process. Stop
      // accumulating once the corpus is already big enough to be a
      // reasonable signal; a project this large needs a real dead-code tool
      // anyway, and a partial scan beats an OOM crash.
      const MAX_DEAD_CODE_CORPUS_BYTES = 40_000_000;
      const files = await sourceFiles(cwd, firstArg(args, "directory") || ".");
      const all = [];
      let corpusBytes = 0;
      let scannedCount = 0;
      for (const file of files) {
        if (corpusBytes >= MAX_DEAD_CODE_CORPUS_BYTES) break;
        const content = await readCodeFile(file);
        scannedCount += 1;
        if (!content) continue;
        all.push(content);
        corpusBytes += content.length;
      }
      const corpus = all.join("\n");
      const partial = scannedCount < files.length;
      const unused = files.slice(0, scannedCount).filter((file) => {
        const base = path.basename(file, path.extname(file));
        return base.length > 2 && (corpus.match(new RegExp(`\\b${escapedRegExp(base)}\\b`, "g")) || []).length <= 1;
      });
      const summary = unused.map((file) => relativePath(file, cwd)).join("\n") || "No likely unused files found.";
      return partial
        ? `${summary}\n\n(Partial scan: ${scannedCount}/${files.length} files -- the project is large enough that results are a hint, not exhaustive.)`
        : summary;
    }
    case "TypeCheck": {
      const packagePath = path.join(cwd, "package.json");
      const packageJson = JSON.parse(await fs.readFile(packagePath, "utf8").catch(() => "{}"));
      const scripts = packageJson.scripts || {};
      const scriptName = ["typecheck", "check:types", "types"].find((name) => scripts[name]);
      const hasTsConfig = await fs.stat(path.join(cwd, "tsconfig.json")).then((stat) => stat.isFile()).catch(() => false);
      const exists = async (name) => fs.stat(path.join(cwd, name)).then((stat) => stat.isFile()).catch(() => false);
      const packageManager = await exists("pnpm-lock.yaml") ? "pnpm" : await exists("yarn.lock") ? "yarn" : await exists("bun.lockb") || await exists("bun.lock") ? "bun" : "npm";
      let command;
      if (scriptName) command = `${packageManager} ${packageManager === "npm" ? "run " : "run "}${scriptName}`;
      else if (hasTsConfig) command = packageManager === "npm" ? "npx --no-install tsc --noEmit" : `${packageManager} exec tsc --noEmit`;
      else if (await exists("pom.xml")) command = "mvn -q -DskipTests compile";
      else if (await exists("gradlew") || await exists("gradlew.bat")) command = process.platform === "win32" ? "gradlew.bat compileJava" : "./gradlew compileJava";
      else if (await exists("Cargo.toml")) command = "cargo check";
      else if (await exists("go.mod")) command = "go test ./...";
      else return "No supported typecheck or build manifest found.";
      const result = await runCommand(command, cwd);
      return `$ ${command}\n${truncate(`${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`)}\n(exit ${result.exitCode})`;
    }
    case "LspDiagnostics":
      return `LSP bridge fallback for this workspace.\n${await executeCliTool("TypeCheck", args, { cwd, allowOutside })}`;
    case "SpawnAgent":
      return startLocalAgent(args, cwd);
    case "CheckSubagent":
      return agentSummary(firstArg(args, "id"));
    case "StopSubagent": {
      const id = firstArg(args, "id");
      const entry = localAgents.get(id);
      if (!entry) throw new Error(`Unknown subagent: ${id}`);
      if (entry.status === "running") killProcessTree(entry.child);
      entry.status = "stopped";
      entry.finishedAt = Date.now();
      return `Stopped subagent ${id}.`;
    }
    case "ListSubagents":
      return [...localAgents.values()].map((entry) => `${entry.id}  ${entry.status}  ${entry.task}`).join("\n") || "No subagents have been started.";
    case "McpList":
    case "SkillList":
    case "PluginList": {
      const kind = toolName === "McpList" ? "mcp" : toolName === "SkillList" ? "skills" : "plugins";
      return (await workspaceIntegrationEntries(kind, cwd)).join("\n") || `No workspace ${kind} configuration found.`;
    }
    case "Bash": {
      const result = await runCommand(firstArg(args, "command", "cmd", "script"), cwd, { allowOutside, signal });
      return `$ ${firstArg(args, "command", "cmd", "script")}\n${truncate(`${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`)}\n(exit ${result.exitCode})`;
    }
    case "RunInBackground": {
      const result = await runCommand(firstArg(args, "command", "cmd", "script"), cwd, { background: true, allowOutside });
      return `Started background command ${result.id} (pid ${result.pid ?? "?"}): ${result.command}`;
    }
    case "BackgroundOutput": {
      const id = firstArg(args, "id");
      const entry = backgroundProcesses.get(id);
      if (!entry) throw new Error(`Unknown background process: ${id}`);
      return `Background ${id}: ${entry.exitCode === undefined ? "running" : `exited (${entry.exitCode})`}\n${entry.output || "(no output yet)"}`;
    }
    case "StopBackground": {
      const id = firstArg(args, "id");
      const entry = backgroundProcesses.get(id);
      if (!entry) throw new Error(`Unknown background process: ${id}`);
      killProcessTree(entry.child);
      return `Stopped background process ${id}.`;
    }
    case "CheckPort":
      return checkPort(args.port, firstArg(args, "host") || "127.0.0.1");
    case "Delete": {
      const filePath = pathArg("file_path", "path", "file");
      await fs.rm(filePath, { recursive: true, force: false });
      return `Deleted ${relativePath(filePath, cwd)}.`;
    }
    case "Mkdir": {
      const directory = pathArg("directory_path", "path", "directory");
      await fs.mkdir(directory, { recursive: true });
      return `Created ${relativePath(directory, cwd)}.`;
    }
    case "Copy": {
      const source = pathArg("source", "path_a");
      const destination = pathArg("destination", "path_b");
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.cp(source, destination, { recursive: true });
      return `Copied ${relativePath(source, cwd)} → ${relativePath(destination, cwd)}.`;
    }
    case "Move": {
      const source = pathArg("source", "path_a");
      const destination = pathArg("destination", "path_b");
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.rename(source, destination);
      return `Moved ${relativePath(source, cwd)} → ${relativePath(destination, cwd)}.`;
    }
    case "GitStatus": {
      const result = await executeGit(["status", "--short", "--branch"], cwd);
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || "git status failed");
      return `${result.stdout}${result.stderr}`.trim() || "Working tree clean.";
    }
    case "GitLog": {
      const count = Math.max(1, Math.min(50, Number(args.count) || 10));
      const result = await executeGit(["log", `-${count}`, "--oneline", "--decorate"], cwd);
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || "git log failed");
      return `${result.stdout}${result.stderr}`.trim() || "No commits found.";
    }
    case "GitDiff": {
      const filePath = firstArg(args, "file_path", "path");
      const result = await executeGit(["diff", "--", filePath || "."], cwd);
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || "git diff failed");
      return `${result.stdout}${result.stderr}`.trim() || "No changes.";
    }
    case "GitBranch": {
      const result = await executeGit(["branch", ...(args.all === false ? [] : ["--all"]), "--no-color"], cwd);
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || "git branch failed");
      return `${result.stdout}${result.stderr}`.trim() || "No branches found.";
    }
    case "GitCheckout": {
      const branch = firstArg(args, "branch", "name");
      if (!branch || /[\s;&|<>]/.test(branch)) throw new Error("GitCheckout requires a simple branch name.");
      const result = await executeGit(["checkout", ...(args.create === true ? ["-b"] : []), branch], cwd);
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || "git checkout failed");
      return `${result.stdout}${result.stderr}`.trim();
    }
    case "GitCommit": {
      const message = firstArg(args, "message", "subject");
      if (!message) throw new Error("GitCommit requires a commit message.");
      const requestedPaths = Array.isArray(args.paths) ? args.paths.map((value) => String(value)) : [];
      const paths = requestedPaths.filter((value) => value && !/[;&|<>\n\r]/.test(value));
      if (requestedPaths.length && paths.length !== requestedPaths.length) throw new Error("GitCommit received an invalid path; refusing to stage anything.");
      const result = await executeGit(["add", ...(paths.length ? ["--", ...paths] : ["-A"])], cwd);
      if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || "git add failed");
      const commit = await executeGit(["commit", "-m", message], cwd);
      return `${commit.stdout}${commit.stderr}`.trim();
    }
    case "GitStash": {
      const action = firstArg(args, "action") || "push";
      if (!["push", "pop", "list", "clear"].includes(action)) throw new Error("GitStash action must be push, pop, list, or clear.");
      const result = await executeGit(["stash", action], cwd);
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || "git stash failed");
      return `${result.stdout}${result.stderr}`.trim();
    }
    case "GitBlame": {
      const filePath = pathArg("file_path", "path");
      const result = await executeGit(["blame", "--", relativePath(filePath, cwd)], cwd);
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || "git blame failed");
      return `${result.stdout}${result.stderr}`.trim();
    }
    case "GitShow": {
      const revision = firstArg(args, "revision", "commit", "ref") || "HEAD";
      if (/[\s;&|<>]/.test(revision)) throw new Error("GitShow requires a simple revision.");
      const file = firstArg(args, "file");
      const result = await executeGit(["show", ...(file ? [] : ["--stat", "--oneline"]), revision, ...(file ? ["--", file] : [])], cwd);
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || "git show failed");
      return `${result.stdout}${result.stderr}`.trim();
    }
    case "CurrentTime":
      return new Date().toString();
    case "GetSystemInfo":
      return JSON.stringify({ platform: process.platform, arch: process.arch, release: os.release(), cpus: os.cpus().length, memoryGB: Math.round(os.totalmem() / 1024 ** 3), node: process.version }, null, 2);
    case "GetEnv": {
      const safeNames = ["PATH", "Path", "TEMP", "TMP", "USERPROFILE", "HOME", "PWD", "NODE_ENV", "NEXARA_APP_URL"];
      return safeNames.filter((key) => process.env[key]).map((key) => `${key}=${process.env[key]}`).join("\n") || "No safe environment values available.";
    }
    case "GetFileInfo": {
      const filePath = pathArg("file_path", "path", "file");
      const stat = await fs.stat(filePath);
      return JSON.stringify({ path: relativePath(filePath, cwd), bytes: stat.size, modified: stat.mtime.toISOString(), directory: stat.isDirectory(), file: stat.isFile() }, null, 2);
    }
    case "Diff": {
      const pathA = pathArg("path_a", "file_path", "path");
      const pathB = firstArg(args, "path_b") ? resolveWorkspacePath(firstArg(args, "path_b"), cwd, { allowOutside }) : null;
      const [a, b] = await Promise.all([fs.readFile(pathA, "utf8"), pathB ? fs.readFile(pathB, "utf8") : executeGit(["show", `HEAD:${relativePath(pathA, cwd)}`], cwd).then((result) => {
        if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Could not read the HEAD version of this file.");
        return result.stdout;
      })]);
      if (a === b) return "Files are identical.";
      return `Files differ: ${relativePath(pathA, cwd)}${pathB ? ` and ${relativePath(pathB, cwd)}` : " versus HEAD"}.`;
    }
    case "WebFetch": {
      const url = new URL(firstArg(args, "url"));
      if (!/^https?:$/.test(url.protocol)) throw new Error("WebFetch only supports http(s) URLs.");
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      const body = await response.text();
      const text = body.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      return `${response.status} ${response.statusText}\n\n${truncate(text, 40_000)}`;
    }
    case "ListProcesses": {
      const command = process.platform === "win32" ? "tasklist" : "ps";
      const result = await runCommand(command, cwd);
      return truncate(`${result.stdout}${result.stderr}`);
    }
    case "KillProcess": {
      const pid = Number(args.pid);
      if (Number.isInteger(pid) && pid > 0) {
        const entries = [...backgroundProcesses.values(), ...localAgents.values()];
        const entry = entries.find((item) => item.child.pid === pid && item.exitCode === undefined && item.status !== "done");
        if (!entry) throw new Error("KillProcess only terminates processes launched by this CLI. Use StopBackground or StopSubagent.");
        killProcessTree(entry.child);
        return `Sent a termination signal to process ${pid}.`;
      }
      throw new Error("KillProcess requires the pid of a process launched by RunInBackground or SpawnAgent.");
    }
    case "Zip": {
      const archive = pathArg("archive_path", "path");
      const sources = Array.isArray(args.sources) ? args.sources.map((source) => resolveWorkspacePath(source, cwd, { allowOutside })) : [cwd];
      if (process.platform === "win32") {
        const result = await runCommand(`tar -a -c -f "${archive}" ${sources.map((source) => `"${source}"`).join(" ")}`, cwd);
        return `${result.stdout}${result.stderr}`.trim() || `Created ${relativePath(archive, cwd)}.`;
      }
      const result = await runCommand(`zip -r "${archive}" ${sources.map((source) => `"${source}"`).join(" ")}`, cwd);
      return `${result.stdout}${result.stderr}`.trim() || `Created ${relativePath(archive, cwd)}.`;
    }
    case "Unzip": {
      const archive = pathArg("archive_path", "path");
      const destination = pathArg("destination");
      await fs.mkdir(destination, { recursive: true });
      // Archive member names are untrusted input. Reject absolute paths and
      // traversal before extraction so a model cannot unpack over the project
      // or the user's parent directories.
      const listing = await runCommand(`tar -tf "${archive}"`, cwd, { allowOutside });
      const unsafe = listing.stdout
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .filter(Boolean)
        .find((entry) => {
          const member = entry.replaceAll("\\", "/");
          const normalized = path.posix.normalize(member);
          return member.startsWith("/") || /^[A-Za-z]:\//.test(member) || normalized === ".." || normalized.startsWith("../");
        });
      if (unsafe) throw new Error(`Refusing to extract unsafe archive member: ${unsafe}`);
      const result = await runCommand(`tar -xf "${archive}" -C "${destination}"`, cwd);
      return `${result.stdout}${result.stderr}`.trim() || `Extracted ${relativePath(archive, cwd)}.`;
    }
    case "OpenFile": {
      const filePath = pathArg("file_path", "path", "file");
      await openWithSystem(filePath);
      return `Opened ${relativePath(filePath, cwd)}.`;
    }
    case "RevealInExplorer": {
      const filePath = pathArg("file_path", "path", "file");
      await openWithSystem(path.dirname(filePath));
      return `Revealed ${relativePath(filePath, cwd)}.`;
    }
    case "OpenExternal":
      return openExternal(firstArg(args, "url"));
    case "ApplyDiff": {
      const filePath = pathArg("file_path", "path", "file");
      const patch = String(args.patch || "");
      if (!patch) throw new Error("ApplyDiff requires a unified diff patch.");
      return applyUnifiedDiff(filePath, patch, cwd, { signal });
    }
    case "TodoWrite": {
      const todos = Array.isArray(args.todos) ? args.todos : [];
      return `Todo list updated (${todos.length} item${todos.length === 1 ? "" : "s"}).\n${todos.map((todo) => `- [${todo.status || "pending"}] ${todo.content || "Untitled"}`).join("\n")}`;
    }
    default:
      throw new Error(`Unsupported CLI tool: ${toolName}`);
  }
}

export function backgroundSummary() {
  const commands = [...backgroundProcesses.values()].map((entry) => ({
    id: entry.id,
    kind: "command",
    command: entry.command,
    running: entry.exitCode === undefined,
    pid: entry.child.pid,
    startedAt: entry.startedAt,
    finishedAt: entry.finishedAt || null,
  }));
  const agents = [...localAgents.values()].map((entry) => ({
    id: entry.id,
    kind: "agent",
    command: `agent: ${entry.task}`,
    running: entry.status === "running",
    pid: entry.child.pid,
    startedAt: entry.startedAt,
    finishedAt: entry.finishedAt,
  }));
  return [...commands, ...agents];
}

export function clearBackgroundProcesses() {
  for (const entry of backgroundProcesses.values()) {
    if (entry.exitCode === undefined) killProcessTree(entry.child);
  }
  backgroundProcesses.clear();
  for (const entry of localAgents.values()) {
    if (entry.status === "running") killProcessTree(entry.child);
  }
  localAgents.clear();
}
