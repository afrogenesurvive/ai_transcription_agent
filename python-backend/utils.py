"""
Shared utility functions for the transcription backend.
"""

import os


def is_network_error(exc: Exception) -> bool:
    """Check if an exception is caused by a network connectivity issue.

    Distinguishes network failures (DNS, timeout, connection refused)
    from genuine model errors (gated model, missing cache). When a
    network error is detected, model loading retries with
    local_files_only=True instead of crashing.
    """
    msg = str(exc).lower()
    err_type = type(exc).__name__.lower()
    for keyword in (
        "connectionerror", "timeout", "maxretryerror",
        "nameresolutionerror", "connectionreseterror",
        "sslerror", "certificateerror", "tlserror",
    ):
        if keyword in err_type:
            return True
    for keyword in (
        "connection refused", "connection reset",
        "name resolution", "nodename nor servname",
        "max retries exceeded", "failed to resolve",
        "connection timeout", "network unreachable",
        "host unreachable", "temporarily unavailable",
        "ssl", "tls", "certificate verify failed",
        "wrong version number",
    ):
        if keyword in msg:
            return True
    if isinstance(exc, OSError) and getattr(exc, 'errno', None) in (
        8, 51, 54, 57, 60, 61, 64, 65, 66,
    ):
        return True
    return False
