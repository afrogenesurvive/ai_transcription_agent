"""
Per-seat license verification + challenge-response for the Python bridge.

Mirrors electron/src/main/license.ts — embed the SAME master public key ring
(kept in sync per build):

  License key string: TA1.<b64url(certJson)>.<b64url(masterSig)>.<b64url(seatPriv)>
  certJson         = { app, v, sub, exp, kid, pub }   (pub = seat Ed25519 pubkey, b64url)
  exp              = 0 means UNLIMITED

Flow:
  POST /license/challenge  { cert, sig }  → verifies master sig + exp, returns
                                            { challenge_id, nonce }
  POST /license/respond    { challenge_id, sig }  → verifies the client's
                                            signature of the nonce against
                                            cert.pub, issues a short-lived
                                            HMAC session token
  Job-execution endpoints  (X-License-Token)  → validated by require_license_token

The bridge only ever receives the PUBLIC cert — the seat private key never
leaves the Electron main process. The session token secret is regenerated on
every bridge start, so a restart invalidates all tokens (client re-challenges).
"""

import base64
import hashlib
import hmac
import json
import secrets
import time

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from fastapi import APIRouter, Body, HTTPException, Header

APP_ID = "transcription-agent"
LICENSE_VERSION = 1
LICENSE_KEY_RE = r"^TA1\."
CHALLENGE_TTL_SECONDS = 60
TOKEN_TTL_SECONDS = int(__import__("os").environ.get("LICENSE_TOKEN_TTL_SECONDS", "3600"))  # 1h default — short window so a revoked seat's token expires quickly

# ── Master public key ring (keep in sync with electron/src/main/license.ts) ──
# not_after: unix seconds after which this kid's signatures are rejected; None = valid forever.
MASTER_KEY_RING: dict[str, dict] = {
    "mk-dev": {
        "public_key": "nHwVcrYKtcXv5SokVALtbhPcWR-ZgdmphKEPeAjDXnI",
        "not_after": None,
    },
}

REVOKED_KIDS: set[str] = set()
REVOKED_SEATS: set[str] = {"lic_test@test.com", "revoked-test-2", "revoke_test@test.com", "seat-test-1", "revoke-test-2", "revoke-test-3"}  # per-seat blocklist (cert "sub"); keep in sync with license.ts


def _b64u_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _b64u_encode(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def _verify_ed25519(public_key_bytes: bytes, message: bytes, signature: bytes) -> bool:
    try:
        Ed25519PublicKey.from_public_bytes(public_key_bytes).verify(signature, message)
        return True
    except (InvalidSignature, ValueError):
        return False


class LicenseError(Exception):
    pass


def verify_cert(cert_b64: str, sig_b64: str, now: int | None = None) -> dict:
    """Validate a seat certificate against the master ring.

    Verifies: parseable JSON → app/v → kid known/not revoked/not retired →
    master signature over the cert bytes → exp (0 = unlimited).
    Returns the cert dict on success; raises LicenseError otherwise.
    """
    now = now if now is not None else int(time.time())
    if not cert_b64 or not sig_b64:
        raise LicenseError("missing cert/sig")
    try:
        cert_bytes = _b64u_decode(cert_b64)
        cert = json.loads(cert_bytes.decode("utf8"))
    except Exception as e:
        raise LicenseError(f"malformed_cert: {e}") from e

    if cert.get("app") != APP_ID or cert.get("v") != LICENSE_VERSION:
        raise LicenseError("app_mismatch")

    kid = cert.get("kid")
    entry = MASTER_KEY_RING.get(kid)
    if entry is None:
        raise LicenseError("unknown_kid")
    if kid in REVOKED_KIDS:
        raise LicenseError("revoked_kid")
    not_after = entry.get("not_after")
    if not_after and now >= int(not_after):
        raise LicenseError("retired_kid")
    if cert.get("sub") in REVOKED_SEATS:
        raise LicenseError("revoked_seat")

    try:
        master_pub = _b64u_decode(entry["public_key"])
        signature = _b64u_decode(sig_b64)
    except Exception as e:
        raise LicenseError(f"bad_key_data: {e}") from e
    if not _verify_ed25519(master_pub, cert_bytes, signature):
        raise LicenseError("bad_signature")

    exp = cert.get("exp", 0)
    if exp != 0 and now >= int(exp):
        raise LicenseError("expired")

    return cert


# ── Challenge store ──

_challenges: dict[str, dict] = {}


def _cleanup_challenges(now: int) -> None:
    expired = [cid for cid, c in _challenges.items() if now - c["created"] > CHALLENGE_TTL_SECONDS]
    for cid in expired:
        _challenges.pop(cid, None)


# ── Session tokens (HMAC-SHA256, secret regenerated per bridge start) ──

_SECRET = secrets.token_bytes(32)


def _sign(payload_b64: str) -> str:
    return hmac.new(_SECRET, payload_b64.encode(), hashlib.sha256).hexdigest()


def issue_token(cert: dict) -> tuple[str, dict]:
    now = int(time.time())
    payload = {
        "sub": cert.get("sub", ""),
        "kid": cert.get("kid", ""),
        "exp": cert.get("exp", 0),
        "iat": now,
        "exp_token": now + TOKEN_TTL_SECONDS,
    }
    payload_b64 = _b64u_encode(json.dumps(payload, separators=(",", ":")).encode())
    token = f"{payload_b64}.{_sign(payload_b64)}"
    return token, payload


def verify_token(token: str, now: int | None = None) -> dict | None:
    now = now if now is not None else int(time.time())
    if not token:
        return None
    try:
        payload_b64, sig = token.split(".", 1)
        if not hmac.compare_digest(_sign(payload_b64), sig):
            return None
        payload = json.loads(_b64u_decode(payload_b64).decode("utf8"))
        if int(payload.get("exp_token", 0)) < now:
            return None
        return payload
    except Exception:
        return None


# ── FastAPI dependency guard for job-execution endpoints ──

def require_license_token(x_license_token: str | None = Header(default=None)) -> dict:
    payload = verify_token(x_license_token or "")
    if not payload:
        raise HTTPException(status_code=403, detail="Valid license token required")
    return payload


# ── Routes ──

router = APIRouter()


@router.post("/license/challenge")
async def license_challenge(payload: dict = Body(...)):
    try:
        cert = verify_cert(payload.get("cert", ""), payload.get("sig", ""))
    except LicenseError as e:
        return HTTPException(status_code=403, detail=f"license challenge rejected: {e}")

    now = int(time.time())
    _cleanup_challenges(now)
    cid = secrets.token_hex(8)
    nonce = secrets.token_bytes(32)
    _challenges[cid] = {"nonce": nonce, "cert": cert, "created": now}
    return {"challenge_id": cid, "nonce": _b64u_encode(nonce)}


@router.post("/license/respond")
async def license_respond(payload: dict = Body(...)):
    cid = payload.get("challenge_id", "")
    sig_b64 = payload.get("sig", "")
    ch = _challenges.pop(cid, None)
    if ch is None:
        raise HTTPException(status_code=403, detail="license challenge expired or not found")
    try:
        signature = _b64u_decode(sig_b64)
    except Exception as e:
        raise HTTPException(status_code=403, detail=f"bad response signature: {e}") from e

    cert = ch["cert"]
    try:
        seat_pub = _b64u_decode(cert["pub"])
    except Exception as e:
        raise HTTPException(status_code=403, detail=f"bad seat public key: {e}") from e

    if not _verify_ed25519(seat_pub, ch["nonce"], signature):
        raise HTTPException(status_code=403, detail="license response signature invalid")

    token, token_payload = issue_token(cert)
    return {"token": token, **token_payload}


# ── ASGI middleware: gate job-creation paths (single enforcement point) ──
#
# Enforced NOW (renderer → bridge): /transcribe/upload, /transcribe/upload_by_path
# are the job-submission endpoints the Electron renderer calls, so this is the
# "no submission without a license" backend gate.
#
# PENDING (agent-runner → bridge): /agent/refine, /agent/summarize,
# /agent/label_speakers, /agent/deliver and /transcribe/job/upsert are called by
# the separate agent-runner process. Gating them requires injecting a license
# token into the agent runner (and refreshing it across bridge restarts) —
# deferred to avoid breaking the pipeline. They are transitively gated today
# because jobs can't even start without a license.
GATED_PATHS = {
    "/transcribe/upload",
    "/transcribe/upload_by_path",
}


async def license_gate_middleware(request, call_next):
    """FastAPI/Starlette middleware — requires X-License-Token on gated paths."""
    if request.url.path in GATED_PATHS:
        token = request.headers.get("x-license-token", "")
        if verify_token(token) is None:
            from fastapi.responses import JSONResponse

            return JSONResponse(status_code=403, content={"detail": "Valid license token required"})
    return await call_next(request)
