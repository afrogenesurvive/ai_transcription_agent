"""License revocation tests.

Confirms revoked seats are rejected by verify_cert in the shipped Python
verifier.

The authoritative blocklist lives in a separate, local-only key-manager repo
(not part of this project), which rewrites the REVOKED_SEATS constant in
python-backend/license.py and electron/src/main/license.ts. Parity between the two
is enforced there, so it is not re-asserted here — these tests exercise the
verifier and its embedded blocklist, with no dependency on the key store.
"""

import base64
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from license import REVOKED_SEATS, LicenseError, verify_cert  # noqa: E402


def _b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _make_cert(sub: str) -> tuple[str, str]:
    """A structurally valid cert (any pub) + a bogus signature.

    Revocation is checked BEFORE signature verification in verify_cert, so a
    revoked sub is rejected as revoked_seat regardless of signature validity.
    """
    cert = {"app": "transcription-agent", "v": 1, "sub": sub, "exp": 0, "kid": "mk-dev", "pub": "x" * 32}
    cert_b64 = _b64u(json.dumps(cert).encode())
    sig_b64 = _b64u(b"bogus-signature")
    return cert_b64, sig_b64


def test_every_revoked_seat_is_rejected():
    assert len(REVOKED_SEATS) > 0, "no revoked seats configured — nothing to assert"
    for sub in REVOKED_SEATS:
        cert_b64, sig_b64 = _make_cert(sub)
        try:
            verify_cert(cert_b64, sig_b64)
            raise AssertionError(f"revoked seat {sub!r} was accepted")
        except LicenseError as e:
            assert "revoked_seat" in str(e)


def test_non_revoked_bad_signature_is_rejected_as_bad_signature():
    cert_b64, sig_b64 = _make_cert("nobody@example.com")
    try:
        verify_cert(cert_b64, sig_b64)
        raise AssertionError("bogus-signature cert was accepted")
    except LicenseError as e:
        assert "bad_signature" in str(e)
