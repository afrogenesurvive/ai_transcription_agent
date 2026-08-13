/**
 * Shared desktop OAuth authorization-code flow for meeting providers
 * (Microsoft Teams, Zoom).
 *
 * Runs the consent -> loopback redirect -> token-exchange flow entirely in the
 * main process, mirroring gmailOAuth.ts but generalized:
 *   - loopback server on 127.0.0.1:0 with a `state` check
 *   - optional PKCE (Teams requires it; Microsoft blocks the implicit flow)
 *   - optional client secret (Zoom) vs public client (Teams, no secret)
 *   - best-effort signed-in user fetch after token exchange
 *
 * The renderer never sees the auth code or tokens mid-flight — only the final
 * result is returned.
 */

import http from "http";
import crypto from "crypto";
import { shell } from "electron";
import { addLog } from "../logger";

export interface OAuthFlowResult {
  ok: boolean;
  refreshToken?: string;
  accessToken?: string;
  user?: string;
  error?: string;
}

export interface OAuthFlowOptions {
  /** Human-readable provider name used in logs/errors (e.g. "Microsoft Teams"). */
  provider: string;
  clientId: string;
  /** Client secret (Zoom). Omit for public clients (Teams PKCE). */
  clientSecret?: string;
  /** Enable PKCE (S256) — required by Microsoft; optional elsewhere. */
  usePkce?: boolean;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  /** Extra query params for the authorize URL (e.g. tenant, prompt). */
  extraAuthorizeParams?: Record<string, string>;
  /** Extra fields appended to the token-exchange body (e.g. code_verifier). */
  extraTokenParams?: (code: string, redirectUri: string) => Record<string, string>;
  /** Best-effort fetch of the signed-in user's id/email from the access token. */
  fetchUser?: (accessToken: string) => Promise<string>;
}

/** How long to wait for the user to finish authorizing in the browser. */
const AUTH_TIMEOUT_MS = 10 * 60 * 1000;

interface PendingFlow {
  settle: (result: OAuthFlowResult) => void;
}

let pending: PendingFlow | null = null;

/** Cancel any pending flow (user closed the panel / clicked away). */
export function cancelOAuthFlow(provider?: string): void {
  if (!pending) return;
  addLog("main", "info", `[${provider || "meetings"}] authorization cancelled`);
  pending.settle({ ok: false, error: "cancelled" });
}

/** Minimal HTML served at the loopback redirect so the browser tab ends cleanly. */
const CLOSE_PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Authorization complete</title></head>
<body style="font-family:system-ui,sans-serif;background:#0d1117;color:#c9d1d9;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center"><h2 style="color:#3fb950">✓ Authorization complete</h2>
<p>You can close this tab and return to the app.</p></div></body></html>`;

function base64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Run the consent → redirect → token-exchange → userinfo flow for one attempt. */
export async function runOAuthFlow(opts: OAuthFlowOptions): Promise<OAuthFlowResult> {
  if (pending) return { ok: false, error: `A ${opts.provider} authorization flow is already in progress.` };
  if (!opts.clientId.trim()) return { ok: false, error: `${opts.provider} is not configured — set the Client ID and connect your account.` };

  const state = crypto.randomBytes(16).toString("hex");
  const codeVerifier = opts.usePkce ? base64Url(crypto.randomBytes(32)) : "";

  return new Promise<OAuthFlowResult>((resolve) => {
    let flowRef: PendingFlow | null = null;
    let server: http.Server | null = null;
    let timer: NodeJS.Timeout | null = null;
    let settled = false;

    const settle = (result: OAuthFlowResult): void => {
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
      addLog("main", "warn", `[${opts.provider}] authorization timed out`);
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
        settle({ ok: false, error: `${opts.provider} authorization failed: ${errParam}` });
        return;
      }
      if (!code) {
        settle({ ok: false, error: `${opts.provider} authorization returned no code.` });
        return;
      }
      const redirectUri = `http://127.0.0.1:${port}/`;
      exchangeCode(opts, code, redirectUri, codeVerifier)
        .then(settle)
        .catch((err) => settle({ ok: false, error: err?.message || `Failed to exchange authorization code.` }));
    });

    server.on("error", (err) => {
      addLog("main", "error", `[${opts.provider}] loopback server error: ${err.message}`);
      settle({ ok: false, error: `Could not start local redirect server: ${err.message}` });
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server?.address();
      if (!addr || typeof addr === "string") {
        settle({ ok: false, error: "Could not open a local redirect port." });
        return;
      }
      const redirectUri = `http://127.0.0.1:${addr.port}/`;
      const params = new URLSearchParams({
        client_id: opts.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: opts.scopes.join(" "),
        state,
        ...(opts.extraAuthorizeParams || {}),
      });
      if (opts.usePkce) {
        params.set("code_challenge", base64Url(crypto.createHash("sha256").update(codeVerifier).digest()));
        params.set("code_challenge_method", "S256");
      }
      const consentUrl = `${opts.authorizeUrl}?${params.toString()}`;

      addLog("main", "info", `[${opts.provider}] opening consent page (redirect ${redirectUri})`);
      shell.openExternal(consentUrl).catch((err) => {
        addLog("main", "error", `[${opts.provider}] could not open browser: ${err?.message || "unknown"}`);
        settle({ ok: false, error: "Could not open your browser. Check your default browser settings." });
      });
    });
  });
}

/** Exchange the authorization code for a refresh token, then fetch the user. */
async function exchangeCode(opts: OAuthFlowOptions, code: string, redirectUri: string, codeVerifier: string): Promise<OAuthFlowResult> {
  const body: Record<string, string> = {
    code,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
    client_id: opts.clientId,
  };
  if (opts.clientSecret) body.client_secret = opts.clientSecret;
  if (opts.usePkce) body.code_verifier = codeVerifier;
  if (opts.extraTokenParams) Object.assign(body, opts.extraTokenParams(code, redirectUri));

  const tokenRes = await fetch(opts.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tokenJson: any = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokenJson.refresh_token) {
    const detail = tokenJson.error_description || tokenJson.error || `HTTP ${tokenRes.status}`;
    addLog("main", "error", `[${opts.provider}] token exchange failed: ${detail}`);
    return { ok: false, error: `${opts.provider} token exchange failed: ${detail}` };
  }

  const refreshToken: string = tokenJson.refresh_token;
  const accessToken: string = tokenJson.access_token || "";
  let user = "";
  if (accessToken && opts.fetchUser) {
    try {
      user = await opts.fetchUser(accessToken);
    } catch {
      /* non-fatal */
    }
  }

  return { ok: true, refreshToken, accessToken, user };
}
