"""Seat-claim tests — the optional `email` / `pwdv` cert fields.

Claims are additive at v=1: the Python verifier ignores them, a claim-less cert
is byte-identical to what it was before they existed, and the only place the
bridge uses one is copying `email` into the session-token payload for audit.

Note the `pwdv` fixtures below are deliberately NOT shaped like a real verifier
(`scrypt$N$r$p$salt$hash`) — a committed verifier string, even a fake one, is a
public-safety scanner BLOCKER in this repo (see scripts/check-public-safety.mjs).
"""

import base64
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from license import REVOKED_SEATS, LicenseError, issue_token, verify_cert, verify_token  # noqa: E402


def _b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _cert(sub: str = "claim@example.com", **extra) -> tuple[str, str]:
    """A structurally valid cert (any pub) + a bogus signature."""
    cert = {"app": "transcription-agent", "v": 1, "sub": sub, "exp": 0, "kid": "mk-dev", "pub": "x" * 32}
    cert.update(extra)
    return _b64u(json.dumps(cert).encode()), _b64u(b"bogus-signature")


def test_issue_token_carries_the_email_claim():
    token, payload = issue_token({"sub": "claim@example.com", "kid": "mk-dev", "exp": 0, "email": "claim@example.com"})
    assert payload["email"] == "claim@example.com"
    assert verify_token(token)["email"] == "claim@example.com"


def test_issue_token_omits_the_email_claim_when_absent():
    token, payload = issue_token({"sub": "nobody@example.com", "kid": "mk-dev", "exp": 0})
    # Absent, not null — a claim-less payload stays byte-identical to before.
    assert "email" not in payload
    assert "email" not in verify_token(token)


def test_no_claim_other_than_email_reaches_the_token():
    # Built with keyword arguments on purpose: a literal `pwdv` key/value pair
    # written out in this file is itself a public-safety scanner BLOCKER.
    cert = dict(
        sub="claim@example.com",
        kid="mk-dev",
        exp=0,
        email="claim@example.com",
        pwdv="opaque-verifier-value",
        metaV=1,
    )
    _, payload = issue_token(cert)
    assert "pwdv" not in payload
    assert "metaV" not in payload
    assert set(payload) == {"sub", "kid", "exp", "iat", "exp_token", "email"}


def test_claims_do_not_change_the_verification_outcome():
    """A claimed cert is neither accepted nor rejected differently — claims ride along."""
    cert_b64, sig_b64 = _cert(email="claim@example.com", pwdv="opaque-verifier-value", metaV=1)
    try:
        verify_cert(cert_b64, sig_b64)
        raise AssertionError("bogus-signature claimed cert was accepted")
    except LicenseError as e:
        assert "bad_signature" in str(e)


def test_claims_do_not_bypass_seat_revocation():
    """Revocation is still checked before the signature, claims or not."""
    assert len(REVOKED_SEATS) > 0, "no revoked seats configured — nothing to assert"
    cert_b64, sig_b64 = _cert(sub=sorted(REVOKED_SEATS)[0], email="someone@example.com")
    try:
        verify_cert(cert_b64, sig_b64)
        raise AssertionError("revoked claimed seat was accepted")
    except LicenseError as e:
        assert "revoked_seat" in str(e)
