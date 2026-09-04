import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PS_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "mic-windows.ps1");

function waitExit(child, ms) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
      resolve();
    }, ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function hasCommand(command) {
  return new Promise((resolve) => {
    const probe = spawn(command, ["-version"], { stdio: "ignore", windowsHide: true });
    probe.once("error", () => resolve(false));
    probe.once("exit", () => resolve(true));
  });
}

/**
 * Starts recording from the default microphone.
 *
 * Returns `{ stop }` — calling `stop()` stops the recording, finalizes the
 * WAV file, and resolves with its path (or `null` when nothing was captured).
 *
 * Backends, in order:
 *   1. Windows 10+ built-in PowerShell + WinRT AudioGraph (no installs).
 *   2. `ffmpeg` on PATH (works on any platform, needs a mic device).
 */
async function wavSignalStats(filePath) {
  const buffer = await fs.readFile(filePath);
  let dataStart = -1;
  for (let i = 12; i < buffer.length - 8; i += 1) {
    if (buffer.toString("ascii", i, i + 4) === "data") {
      dataStart = i + 8;
      break;
    }
  }
  if (dataStart < 0) return null;
  let samples = 0;
  let nonzero = 0;
  for (let i = dataStart; i + 1 < buffer.length; i += 2) {
    samples += 1;
    if (buffer.readInt16LE(i) !== 0) nonzero += 1;
  }
  return { samples, nonzero };
}

export async function startMicRecording({ onStatus = () => {}, onError = () => {} } = {}) {
  const tag = `nexara-mic-${process.pid}-${Date.now()}`;
  const outFile = path.join(os.tmpdir(), `${tag}.wav`);
  const stopFile = path.join(os.tmpdir(), `${tag}.stop`);

  let child = null;
  let mode = null;
  let ffmpegInput = null;
  let processError = null;
  let startupError = null;

  async function startPowershell() {
    await fs.writeFile(stopFile, "");
    const shell = process.platform === "win32" ? "powershell.exe" : "pwsh";
    child = spawn(
      shell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        PS_SCRIPT,
        "-OutFile",
        outFile,
        "-StopFile",
        stopFile,
        "-ParentPid",
        String(process.pid),
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    child.stdout.on("data", (chunk) => {
      if (/RECORDING/.test(chunk.toString())) onStatus("recording");
    });
    // PowerShell writes the full script location and stack trace for an
    // AccessDenied microphone result. Keep that implementation detail out of
    // the prompt and convert it to one useful, actionable message on stop.
    child.stderr.on("data", (chunk) => {
      processError = chunk.toString();
    });
    child.once("error", (error) => {
      processError = error instanceof Error ? error.message : String(error);
    });
    mode = "powershell";
    const ready = await new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish(false), 2_500);
      child.stdout.on("data", (chunk) => {
        if (/RECORDING/.test(chunk.toString())) finish(true);
      });
      child.once("exit", () => finish(false));
      child.once("error", () => finish(false));
    });
    if (!ready) {
      startupError = processError || "The Windows microphone recorder could not start.";
      await waitExit(child, 500);
      child = null;
      mode = null;
      throw new Error(startupError);
    }
    onStatus("recording");
  }

  async function startFfmpeg() {
    if (!(await hasCommand("ffmpeg"))) return false;
    const device =
      process.platform === "win32"
        ? ["-f", "dshow", "-i", "audio=Microphone"]
        : process.platform === "darwin"
          ? ["-f", "avfoundation", "-i", ":0"]
          : ["-f", "alsa", "-i", "default"];
    child = spawn(
      "ffmpeg",
      ["-y", ...device, "-ac", "1", "-ar", "16000", outFile],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    ffmpegInput = child.stdin;
    child.stderr.on("data", () => {
      // ffmpeg logs constantly; the CLI shows its own status line instead.
    });
    child.on("error", () => {});
    mode = "ffmpeg";
    onStatus("recording");
    return true;
  }

  let started = false;
  if (process.platform === "win32") {
    try {
      await startPowershell();
      started = true;
    } catch {
      started = false;
    }
  }
  if (!started) started = await startFfmpeg();
  if (!started) {
    if (startupError && /accessdenied|permission|microphone/i.test(startupError)) {
      throw new Error(
        "Microphone access was denied. Enable microphone access for desktop apps in Windows Settings → Privacy & security → Microphone, then press M again.",
      );
    }
    throw new Error("No microphone recorder available. Install ffmpeg (or run on Windows 10+) to use push-to-talk.");
  }

  return {
    async stop() {
      if (mode === "powershell") {
        try {
          await fs.rm(stopFile, { force: true });
        } catch {
          // Ignore — the script exits on its own timeout.
        }
        await waitExit(child, 8000);
      } else if (mode === "ffmpeg") {
        if (ffmpegInput && !ffmpegInput.destroyed) {
          ffmpegInput.write("q");
          ffmpegInput.end();
        }
        await waitExit(child, 5000);
      }
      child = null;
      if (processError) {
        const denied = /accessdenied|permission|microphone/i.test(processError);
        const message = denied
          ? "Microphone access was denied. Enable microphone access for desktop apps in Windows Settings → Privacy & security → Microphone, then press M again."
          : "The microphone recorder stopped before it captured audio. Check your microphone and try again.";
        processError = null;
        onError(message);
        await fs.rm(outFile, { force: true }).catch(() => {});
        return null;
      }
      try {
        await fs.rm(stopFile, { force: true });
      } catch {
        // Ignore.
      }
      const stats = await fs.stat(outFile).catch(() => null);
      if (!stats || stats.size <= 44) return null;
      // A valid-looking WAV that is pure silence usually means the mic is
      // muted or Windows is blocking desktop-app microphone access.
      const signal = await wavSignalStats(outFile).catch(() => null);
      if (signal && signal.samples > 0 && signal.nonzero === 0) {
        await fs.rm(outFile, { force: true }).catch(() => {});
        onError(
          "Your microphone produced no audio. Check that it isn't muted and that Windows allows desktop apps to use the microphone (Settings > Privacy > Microphone).",
        );
        return null;
      }
      return outFile;
    },
    get outFile() {
      return outFile;
    },
  };
}
