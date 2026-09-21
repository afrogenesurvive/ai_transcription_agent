/**
 * dsmonCopy.ts — user-facing copy for DS-mon error codes.
 *
 * The hardened DS-mon host (2026-09-16) requires the push token on EVERY route
 * and refuses to start its sync server without one, so a missing or rejected
 * token comes back as `no-token` / `unauthorized`. Those are CONFIGURATION
 * errors: wording them as "couldn't reach DS-mon" sends the operator off to
 * debug the tunnel/network instead of the setting that is actually wrong.
 */

/**
 * Human-readable description of a `DsmonAuthorityState.error` value.
 *
 * @param error - The raw code from the main process (`no-token`, `unauthorized`, `HTTP <n>`, …)
 * @param fallback - Text to use when no code is present at all
 */
export function describeDsmonError(error: string | null | undefined, fallback = "unreachable"): string {
  const code = (error || "").trim();
  switch (code) {
    case "":
      return fallback;
    case "no-token":
      return "no push token is configured — set DSMON_PUSH_TOKEN in Config → Usage Tracking";
    case "unauthorized":
      return "DS-mon rejected the push token — it must match the token set on the DS-mon host (Config → Usage Tracking)";
    case "no-push-url":
      return "no DS-mon push URL is configured — set DSMON_PUSH_URL in Config → Usage Tracking";
    case "no-license":
      return "no licence is installed";
    case "disabled":
      return "the DS-mon licence check is turned off";
    default:
      // HTTP <n> / a transport error message — already descriptive.
      return code;
  }
}

/** True when the DS-mon error is a push-token configuration problem, not an outage. */
export function isDsmonAuthError(error: string | null | undefined): boolean {
  const code = (error || "").trim();
  return code === "no-token" || code === "unauthorized";
}
