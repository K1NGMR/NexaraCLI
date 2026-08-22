import { createClient } from "@supabase/supabase-js";
import http from "node:http";
import net from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { clearSession, ensureConfiguration, loadConfig, saveConfig } from "./config.js";

function clientFor(config) {
  ensureConfiguration(config);
  return createClient(config.supabaseUrl, config.supabaseKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      flowType: "pkce",
    },
  });
}

const execFileAsync = promisify(execFile);

export function createAuth(config = loadConfig()) {
  let client;
  let session = config.session;

  function getClient() {
    return (client ??= clientFor(config));
  }

  async function restore() {
    if (!session?.access_token || !session?.refresh_token) return null;
    const { data, error } = await getClient().auth.setSession({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
    });
    if (error || !data.session) {
      session = null;
      clearSession();
      return null;
    }
    session = data.session;
    saveConfig({ session });
    return session;
  }

  async function login(email, password) {
    const { data, error } = await getClient().auth.signInWithPassword({ email, password });
    if (error || !data.session) throw new Error(error?.message || "Sign-in did not return a session.");
    session = data.session;
    saveConfig({ session });
    return data.user;
  }

  async function loginWithQr(appUrl, onStatus = () => {}) {
    const base = appUrl.replace(/\/+$/, "");
    const callback = `${base}/auth#qr-callback=1`;
    const created = await fetch(`${base}/api/qr-auth?action=create&callback=${encodeURIComponent(callback)}`, {
      cache: "no-store",
    });
    const challenge = await created.json();
    if (!created.ok) throw new Error(challenge.error || "Could not start QR sign-in.");
    onStatus({ type: "code", url: challenge.scanUrl, expiresAt: challenge.expiresAt });
    const started = Date.now();
    while (Date.now() - started < 125_000) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const response = await fetch(`${base}/api/qr-auth?action=poll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pollToken: challenge.pollToken }),
        cache: "no-store",
      });
      const result = await response.json();
      if (result.status === "expired") throw new Error("QR sign-in expired. Please try again.");
      if (result.status !== "ready") {
        onStatus({ type: "waiting" });
        continue;
      }
      const verified = await getClient().auth.verifyOtp({
        token_hash: result.tokenHash,
        type: result.type,
      });
      if (verified.error || !verified.data.session) throw new Error(verified.error?.message || "QR sign-in failed.");
      await fetch(`${base}/api/qr-auth?action=consume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pollToken: challenge.pollToken }),
      });

      session = verified.data.session;
      saveConfig({ session });
      return verified.data.user;
    }
    throw new Error("QR sign-in timed out.");
  }

  async function completeProfile({ name, email, password }) {
    const activeBeforeUpdate = await user();
    const attributes = {
      password,
      data: { full_name: name.trim(), nexara_profile_complete: true },
    };
    const verifiedGoogleEmail = activeBeforeUpdate?.email?.trim() || "";
    if (!verifiedGoogleEmail) throw new Error("Your Google account did not provide a verified email address.");
    if (email.trim().toLowerCase() !== verifiedGoogleEmail.toLowerCase()) {
      throw new Error("Use the verified Google email associated with your Google account.");
    }
    const { error } = await getClient().auth.updateUser(attributes);
    if (error) throw new Error(error.message);
    const activeUser = await user();
    if (activeUser) {
      const { error: profileError } = await getClient().from("profiles").upsert({
        id: activeUser.id,
        display_name: name.trim() || null,
        avatar_url: typeof activeUser.user_metadata?.avatar_url === "string" ? activeUser.user_metadata.avatar_url : null,
      });
      if (profileError) throw new Error(profileError.message);
    }
  }

  async function loginWithGoogle() {
    let callbackError = null;
    let callbackSession = null;
    let closeServer;
    let redirectUrl;
    let resolveCallback;
    let rejectCallback;
    // Supabase requires EXACT redirect URLs, so the callback port must be
    // fixed (the documented allowlist entry is http://127.0.0.1:54321).
    // Fall back once, then to an ephemeral port rather than never working.
    let listenPort = 0;
    for (const candidate of [54321, 54322]) {
      const free = await new Promise((resolve) => {
        const probe = net.createServer();
        probe.once("error", () => resolve(false));
        probe.listen(candidate, "127.0.0.1", () => probe.close(() => resolve(true)));
      });
      if (free) {
        listenPort = candidate;
        break;
      }
    }
    const callbackDone = new Promise((resolve, reject) => {
      resolveCallback = resolve;
      rejectCallback = reject;
    });
    const callbackReady = new Promise((resolve, reject) => {
      const server = http.createServer(async (request, response) => {
        const requestUrl = new URL(request.url || "/", redirectUrl || "http://127.0.0.1");
        if (requestUrl.pathname !== "/callback") {
          response.writeHead(404).end();
          return;
        }
        const errorDescription = requestUrl.searchParams.get("error_description") || requestUrl.searchParams.get("error");
        const code = requestUrl.searchParams.get("code");
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end("<h2>You can close this window and return to Nexara CLI.</h2>");
        try {
          if (errorDescription) throw new Error(`Google sign-in was cancelled: ${errorDescription}`);
          if (!code) throw new Error("Google sign-in did not return an authorization code.");
          const exchanged = await getClient().auth.exchangeCodeForSession(code);
          if (exchanged.error || !exchanged.data.session) throw new Error(exchanged.error?.message || "Google sign-in did not return a session.");
          callbackSession = exchanged.data.session;
          session = callbackSession;
          saveConfig({ session });
        } catch (error) {
          callbackError = error instanceof Error ? error : new Error(String(error));
        } finally {
          server.close(() => resolveCallback?.());
        }
      });
      closeServer = () => server.close(() => resolve());
      server.once("error", (error) => {
        callbackError = error;
        rejectCallback?.(error);
        reject(error);
      });
      server.listen(listenPort, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          closeServer?.();
          reject(new Error("Could not start OAuth callback server."));
          return;
        }
        redirectUrl = `http://127.0.0.1:${address.port}/callback`;
        resolve();
      });
    });

    try {
      await callbackReady;
      const { data, error } = await getClient().auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: redirectUrl, skipBrowserRedirect: true },
      });
      if (error || !data.url) throw new Error(error?.message || "Could not start Google sign-in.");
      // Windows: never route the URL through cmd.exe — bare "&" in the
      // authorize URL would split it into separate commands. rundll32
      // receives the URL as a single argv entry with no shell parsing.
      const opener = process.platform === "win32" ? "rundll32" : process.platform === "darwin" ? "open" : "xdg-open";
      const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", data.url] : [data.url];
      await execFileAsync(opener, args);
    } catch (error) {
      closeServer?.();
      throw error instanceof Error ? error : new Error(String(error));
    }

    let timeoutId;
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        closeServer?.();
        reject(new Error("Google sign-in timed out."));
      }, 120_000);
    });
    try {
      await Promise.race([callbackDone, timeout]);
    } finally {
      clearTimeout(timeoutId);
    }
    if (callbackError) throw callbackError;
    if (!callbackSession) throw new Error("Google sign-in did not complete.");
    return (await user()) || {};
  }

  async function refresh() {
    if (!session) return null;
    const restored = await restore();
    if (!restored) return null;
    const { data, error } = await getClient().auth.refreshSession({ refresh_token: restored.refresh_token });
    if (error || !data.session) return restored;
    session = data.session;
    saveConfig({ session });
    return session;
  }

  async function accessToken() {
    const active = await refresh();
    return active?.access_token || null;
  }

  async function user() {
    const token = await accessToken();
    if (!token) return null;
    const { data, error } = await getClient().auth.getUser(token);
    if (error) return null;
    return data.user ?? null;
  }

  async function logout() {
    try {
      if (session) await getClient().auth.signOut({ scope: "local" });
    } finally {
      session = null;
      clearSession();
    }
  }

  return { accessToken, completeProfile, getClient, login, loginWithGoogle, loginWithQr, logout, refresh, restore, user };
}
