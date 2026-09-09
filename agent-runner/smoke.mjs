/**
 * Bundle smoke test — imports the same Google client modules tool-executor.js
 * uses (google-auth-library + the Gmail subpath) and constructs a client.
 *
 * Purpose: catch the packaged-only "Dynamic require of ... is not supported"
 * crash. That crash lives at MODULE INITIALIZATION inside the esbuild ESM
 * bundle: google-auth-library lazy-requires `child_process` (pluggable-auth-
 * handler.js / googleauth.js) and gaxios requires `https`. Dev (`node index.js`)
 * has a real require and never reproduces it, so this smoke must run against the
 * BUILT bundle: `npm run smoke` (after `npm run build`, which emits
 * dist/smoke.mjs with the same createRequire banner as dist/bundle.js).
 *
 * Exit 0 = the Google client stack initializes fine inside the bundle.
 * A "Dynamic require of ... is not supported" throw here means the banner fix
 * regressed.
 */
import { OAuth2Client } from "google-auth-library";
import { gmail_v1 } from "googleapis/build/src/apis/gmail/index.js";

// Constructing the client forces module init. No network calls are made with
// these placeholder credentials — we are only verifying the modules load.
const oauth = new OAuth2Client("smoke-client-id", "smoke-client-secret");
oauth.setCredentials({ refresh_token: "smoke-refresh-token" });
const _gmail = new gmail_v1.Gmail({ auth: oauth });

console.log("[SMOKE] OK — google-auth-library + gmail_v1 initialized inside the bundle");
