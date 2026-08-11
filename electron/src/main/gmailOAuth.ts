/**
 * Gmail OAuth — in-app "Connect with Google" flow.
 *
 * Registers IPC handlers that drive the OAuth authorization-code flow entirely
 * in the main process:
 *   - gmail:auth:start  — resolves Client ID/Secret (from the args or the
 *                         saved config), opens Google's consent page in the
 *                         system browser, listens on an ephemeral loopback port
 *                         for the redirect, exchanges the code for a refresh
 *                         token, fetches the user's email, and returns
 *                         { ok, refreshToken, clientId, clientSecret, user }.
 *   - gmail:auth:cancel — aborts a pending flow (closes the loopback server).
 *
 * The renderer never sees the auth code or tokens mid-flight — only the final
 * result is returned. No new npm dependency is needed: the main process has
 * global fetch (Electron 43 / Node 22+) and uses the same loopback-redirect
 * pattern Google requires for desktop OAuth clients.
 */

import http from "http";
import crypto from "crypto";
import { ipcMain, shell } from "electron";
import { getConfig } from "./config";
import { addLog } from "./logger";

/** OAuth result returned to the renderer. */
export interface GmailAuthResult {
  ok: boolean;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  user?: string;
  error?: string;
}

/** Scopes the refresh token must cover: gmail send, Drive, plus email. */
const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/drive", "openid", "email"];

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v2/userinfo";

/** How long to wait for the user to finish authorizing in the browser. */
const AUTH_TIMEOUT_MS = 10 * 60 * 1000;

interface PendingFlow {
  settle: (result: GmailAuthResult) => void;
}

let pending: PendingFlow | null = null;

/** Cancel any pending flow (user closed the panel / clicked away). */
export function cancelGmailAuth(): void {
  if (!pending) return;
  addLog("main", "info", "[gmail] authorization cancelled");
  pending.settle({ ok: false, error: "cancelled" });
}

/** Minimal HTML served at the loopback redirect so the browser tab ends cleanly. */
const CLOSE_PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Authorization complete</title></head>
<body style="font-family:system-ui,sans-serif;background:#0d1117;color:#c9d1d9;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center"><h2 style="color:#3fb950">✓ Authorization complete</h2>
<p>You can close this tab and return to the app.</p></div></body></html>`;

/** Run the consent → redirect → token-exchange → userinfo flow for a single attempt. */
async function runFlow(clientId: string, clientSecret: string): Promise<GmailAuthResult> {
  if (pending) return { ok: false, error: "An authorization flow is already in progress." };

  const state = crypto.randomBytes(16).toString("hex");

  return new Promise<GmailAuthResult>((resolve) => {
    let flowRef: PendingFlow | null = null;
    let server: http.Server | null = null;
    let timer: NodeJS.Timeout | null = null;
    let settled = false;

    const settle = (result: GmailAuthResult): void => {
      if (settled) return;
      settled = true;
      if (pending === flowRef) pending = null;
      if (timer) clearTimeout(timer);
      if (server) {
        try {
          server.close();
        } catch {
          /* already closed */
        }
      }
      resolve(result);
    };

    flowRef = { settle };
    pending = flowRef;

    timer = setTimeout(() => {
      addLog("main", "warn", "[gmail] authorization timed out");
      settle({ ok: false, error: "Authorization timed out — try again." });
    }, AUTH_TIMEOUT_MS);

    server = http.createServer((req, res) => {
      const addr = server?.address();
      const port = addr && typeof addr !== "string" ? addr.port : 0;
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.searchParams.get("state") !== state) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Invalid state parameter.");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(CLOSE_PAGE);

      const code = url.searchParams.get("code");
      const errParam = url.searchParams.get("error");
      if (errParam) {
        settle({ ok: false, error: `Google authorization failed: ${errParam}` });
        return;
      }
      if (!code) {
        settle({ ok: false, error: "Google authorization returned no code." });
        return;
      }
      const redirectUri = `http://127.0.0.1:${port}/`;
      exchangeCode(code, clientId, clientSecret, redirectUri)
        .then(settle)
        .catch((err) => settle({ ok: false, error: err?.message || "Failed to exchange authorization code." }));
    });

    server.on("error", (err) => {
      addLog("main", "error", `[gmail] loopback server error: ${err.message}`);
      settle({ ok: false, error: `Could not start local redirect server: ${err.message}` });
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server?.address();
      if (!addr || typeof addr === "string") {
        settle({ ok: false, error: "Could not open a local redirect port." });
        return;
      }
      const redirectUri = `http://127.0.0.1:${addr.port}/`;
      const consentUrl =
        "https://accounts.google.com/o/oauth2/v2/auth?" +
        new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          response_type: "code",
          scope: GMAIL_SCOPES.join(" "),
          access_type: "offline",
          prompt: "consent",
          state,
        }).toString();

      addLog("main", "info", `[gmail] opening consent page (redirect ${redirectUri})`);
      shell.openExternal(consentUrl).catch((err) => {
        addLog("main", "error", `[gmail] could not open browser: ${err?.message || "unknown"}`);
        settle({ ok: false, error: "Could not open your browser. Check your default browser settings." });
      });
    });
  });
}

/** Exchange the authorization code for a refresh token, then fetch the user's email. */
async function exchangeCode(code: string, clientId: string, clientSecret: string, redirectUri: string): Promise<GmailAuthResult> {
  const tokenRes = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }).toString(),
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tokenJson: any = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokenJson.refresh_token) {
    const detail = tokenJson.error_description || tokenJson.error || `HTTP ${tokenRes.status}`;
    addLog("main", "error", `[gmail] token exchange failed: ${detail}`);
    return { ok: false, error: `Google token exchange failed: ${detail}` };
  }

  const refreshToken: string = tokenJson.refresh_token;
  const accessToken: string = tokenJson.access_token || "";
  let user = "";

  // Best-effort email fetch so GMAIL_USER can be auto-filled. Falls back to
  // empty — tool-executor.js then uses "me" (the authenticated account).
  if (accessToken) {
    try {
      const infoRes = await fetch(USERINFO_ENDPOINT, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (infoRes.ok) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const infoJson: any = await infoRes.json().catch(() => ({}));
        user = typeof infoJson.email === "string" ? infoJson.email : "";
      }
    } catch {
      /* non-fatal */
    }
  }

  return { ok: true, refreshToken, clientId, clientSecret, user };
}

/** Validate the configured Gmail/Drive credentials by exchanging the refresh
 *  token for an access token and calling the Gmail API. Used by the New Job
 *  form before upload to fail fast instead of at delivery time. */
export async function validateGmailCredentials(opts?: { clientId?: string; clientSecret?: string; refreshToken?: string }): Promise<GmailAuthResult> {
  const cfg = getConfig();
  const clientId = (opts?.clientId || cfg.GMAIL_CLIENT_ID || "").trim();
  const clientSecret = (opts?.clientSecret || cfg.GMAIL_CLIENT_SECRET || "").trim();
  const refreshToken = (opts?.refreshToken || cfg.GMAIL_REFRESH_TOKEN || "").trim();

  if (!clientId || !clientSecret || !refreshToken) {
    return {
      ok: false,
      error: "Google integration is not configured — import the provided config (Client ID/Secret) and connect your Google account (Refresh Token).",
    };
  }

  try {
    const tokenRes = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }).toString(),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tokenJson: any = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !tokenJson.access_token) {
      const detail = tokenJson.error_description || tokenJson.error || `HTTP ${tokenRes.status}`;
      addLog("main", "warn", `[gmail] validation failed: ${detail}`);
      return { ok: false, error: `Google integration check failed: ${detail}` };
    }

    const gmailRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
      headers: { Authorization: `Bearer ${tokenJson.access_token}` },
    });
    if (!gmailRes.ok) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = await gmailRes.json().catch(() => ({}));
      const detail = body?.error?.message || `HTTP ${gmailRes.status}`;
      return { ok: false, error: `Google integration check failed: ${detail}` };
    }
    return { ok: true };
  } catch (err: any) {
    addLog("main", "error", `[gmail] validation error: ${err?.message || "unknown"}`);
    return { ok: false, error: err?.message || "Google integration check failed." };
  }
}

/** Register the gmail:* IPC handlers. Call once from index.ts. */
export function registerGmailOAuthIpc(): void {
  ipcMain.handle("gmail:auth:start", async (_event, opts: { clientId?: string; clientSecret?: string } = {}): Promise<GmailAuthResult> => {
    const cfg = getConfig();
    const clientId = (opts?.clientId || cfg.GMAIL_CLIENT_ID || "").trim();
    const clientSecret = (opts?.clientSecret || cfg.GMAIL_CLIENT_SECRET || "").trim();

    if (!clientId || !clientSecret) {
      return {
        ok: false,
        error: "No Gmail Client ID/Secret configured — import the provided config or enter them in Settings → Services.",
      };
    }
    if (pending) {
      return { ok: false, error: "An authorization flow is already in progress." };
    }
    try {
      return await runFlow(clientId, clientSecret);
    } catch (err: any) {
      addLog("main", "error", `[gmail] unexpected error: ${err?.message || "unknown"}`);
      return { ok: false, error: err?.message || "Google authorization failed — try again." };
    }
  });

  ipcMain.handle("gmail:auth:cancel", () => {
    cancelGmailAuth();
    return { ok: true };
  });

  ipcMain.handle("gmail:auth:validate", async (): Promise<GmailAuthResult> => {
    return validateGmailCredentials();
  });
}
