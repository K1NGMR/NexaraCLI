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

// The Supabase JS client's auth calls take no AbortSignal, so a hung network
// request here cannot be interrupted -- and accessToken() runs before EVERY
// chat request, ahead of the AbortController that Ctrl+C is wired to. A stall
// here previously froze the whole CLI with no way out, not even Ctrl+C. This
// cannot cancel the underlying request, but it stops the CLI from waiting on
// it forever and gives the caller a clear, actionable error instead.
export function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(message), { code: "AUTH_TIMEOUT" })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function createAuth(config = loadConfig()) {
  let client;
  let session = config.session;
  let refreshPromise = null;
  // A freshly constructed client (clientFor) has NO session attached until
  // one of the client's own auth methods (setSession/signInWithPassword/
  // verifyOtp/exchangeCodeForSession/refreshSession) runs on it -- that is a
  // local/network call on the CLIENT object itself, separate from just
  // holding a still-valid token string in this closure's `session` variable.
  // Without this flag, refresh()'s "reuse a still-valid token" shortcut
  // skipped restore() (and therefore setSession()) whenever the loaded
  // config already had an unexpired access_token, leaving every request
  // that goes through getClient().from(...) (createThread, listThreads,
  // loadThread, ...) running with NO Authorization attached at all --
  // auth.uid() resolves to NULL server-side, so every insert/select governed
  // by a `auth.uid() = user_id` RLS policy failed. accessToken()/user()
  // still "worked" because getUser(token) takes the token directly and
  // doesn't depend on the client's attached session, which is why `whoami`
  // succeeded while every actual chat/thread operation failed.
  let sessionAttachedToClient = false;

  function getClient() {
    return (client ??= clientFor(config));
  }

  async function restore() {
    if (!session?.access_token || !session?.refresh_token) return null;
    const { data, error } = await withTimeout(
      getClient().auth.setSession({
        access_token: session.access_token,
        refresh_token: session.refresh_token,
      }),
      20_000,
      "Nexara session restore timed out. Check your connection and try again.",
    );
    if (error || !data.session) {
      session = null;
      clearSession();
      return null;
    }
    session = data.session;
    sessionAttachedToClient = true;
    saveConfig({ session });
    return session;
  }

  async function login(email, password) {
    const { data, error } = await getClient().auth.signInWithPassword({ email, password });
    if (error || !data.session) throw new Error(error?.message || "Sign-in did not return a session.");
    session = data.session;
    sessionAttachedToClient = true;
    saveConfig({ session });
    return data.user;
  }

  async function loginWithQr(appUrl, onStatus = () => {}) {
    const base = appUrl.replace(/\/+$/, "");
    const callback = `${base}/auth#qr-callback=1`;
    const created = await fetch(`${base}/api/qr-auth?action=create&callback=${encodeURIComponent(callback)}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    let challenge;
    try {
      challenge = await created.json();
    } catch {
      throw new Error("Could not start QR sign-in: the server sent an unexpected response.");
    }
    if (!created.ok) throw new Error(challenge.error || "Could not start QR sign-in.");
    onStatus({ type: "code", url: challenge.scanUrl, expiresAt: challenge.expiresAt });
    const started = Date.now();
    while (Date.now() - started < 125_000) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      let response;
      let result;
      try {
        response = await fetch(`${base}/api/qr-auth?action=poll`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pollToken: challenge.pollToken }),
          cache: "no-store",
          // Without this, one stuck poll request could block well past the
          // outer 125s window -- the while condition is only checked BETWEEN
          // iterations, not while a fetch is in flight.
          signal: AbortSignal.timeout(10_000),
        });
        result = await response.json();
      } catch {
        // A single dropped/slow/non-JSON poll (proxy hiccup, transient 5xx)
        // must not kill the whole sign-in attempt -- just try again next
        // tick, same as an explicit "waiting" status.
        onStatus({ type: "waiting" });
        continue;
      }
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
      sessionAttachedToClient = true;
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
    // Supabase requires EXACT redirect URLs. An ephemeral fallback looks
    // convenient but produces a redirect that is not in the provider's
    // allowlist, so Google login then fails after the browser step.
    let listenPort = null;
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
    if (listenPort === null) {
      throw new Error("Nexara CLI could not start Google sign-in because ports 54321 and 54322 are busy. Close the app using one and try again.");
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
          sessionAttachedToClient = true;
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

  function tokenExpiry(token) {
    try {
      const payload = JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString("utf8"));
      return Number(payload.exp) || 0;
    } catch {
      return 0;
    }
  }

  async function refresh({ signal } = {}) {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      if (!session) return null;
      // Restore once per process, then reuse a still-valid access token.
      // Calling setSession + refreshSession for every getUser/chat operation
      // rotates refresh tokens unnecessarily and races concurrent requests.
      // But a freshly constructed client has no session attached until one
      // of its own auth methods actually runs on it -- skipping restore()
      // just because `session.access_token` looks unexpired left the client
      // with no Authorization at all, so every request that depends on the
      // CLIENT's own attached session (createThread, listThreads,
      // loadThread, ...) ran unauthenticated and failed RLS checks, even
      // though accessToken()/user() looked fine (getUser(token) takes the
      // token directly and doesn't need the client's session).
      const restored = session.access_token && sessionAttachedToClient ? session : await restore();
      if (!restored?.access_token) return null;
      if (tokenExpiry(restored.access_token) > Math.floor(Date.now() / 1000) + 60) return restored;
      if (!restored.refresh_token) {
        session = null;
        clearSession();
        return null;
      }
      const refreshCall = withTimeout(
        getClient().auth.refreshSession({ refresh_token: restored.refresh_token }),
        20_000,
        "Nexara token refresh timed out. Check your connection and try again.",
      );
      const { data, error } = await (signal ? Promise.race([
        refreshCall,
        new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")), { once: true })),
      ]) : refreshCall);
      if (error || !data?.session) {
        session = null;
        clearSession();
        return null;
      }
      session = data.session;
      sessionAttachedToClient = true;
      saveConfig({ session });
      return session;
    })();
    try {
      return await refreshPromise;
    } finally {
      refreshPromise = null;
    }
  }

  async function accessToken(options = {}) {
    const active = await refresh(options);
    return active?.access_token || null;
  }

  async function user() {
    const token = await accessToken();
    if (!token) return null;
    const { data, error } = await withTimeout(
      getClient().auth.getUser(token),
      20_000,
      "Nexara account lookup timed out. Check your connection and try again.",
    );
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
