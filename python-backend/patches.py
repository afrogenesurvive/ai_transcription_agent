"""
Consolidated monkey-patches for third-party library compatibility.

Applied once at import time (imported by main.py before any other module).
All patches are idempotent — importing multiple times is safe.

Patches:
  1. speechbrain LazyModule.__getattr__ — prevents crash on __file__ access
  2. torchaudio.list_audio_backends — avoids deprecated API that pyannote triggers
  3. pyannote.audio get_torchaudio_info — replaces deprecated torchaudio.info call
"""

import soundfile
import torchaudio as _torchaudio


# ── 1. speechbrain LazyModule workaround ──
# speechbrain 1.0+ uses lazy imports for optional integrations (k2, flair, etc.).
# When PyTorch Lightning calls inspect.stack() → linecache → getattr(mod, '__file__'),
# the LazyModule.__getattr__ triggers, tries to import the missing dependency, and
# crashes the whole pipeline. We patch LazyModule to avoid triggering on __file__.
# This must run BEFORE importing pyannote.audio.
try:
    import speechbrain.utils.importutils as _sb_utils
    _orig_lazy_getattr = _sb_utils.LazyModule.__getattr__

    def _safe_lazy_getattr(self, attr):
        if attr == "__file__":
            raise AttributeError(attr)
        return _orig_lazy_getattr(self, attr)

    _sb_utils.LazyModule.__getattr__ = _safe_lazy_getattr
    print("[patches] ✅ Patched speechbrain LazyModule.__getattr__ (safe __file__)")
except Exception:
    pass  # speechbrain may not be installed


# ── 2. torchaudio compat patch ──
# pyannote.audio uses torchaudio.list_audio_backends() — deprecated since
# torchaudio 2.5+ and scheduled for removal in torchaudio 2.9.
# Since all pipeline audio is 16kHz mono WAV, we hardcode to "soundfile".
# IMPORTANT: Must run BEFORE any pyannote import, because
# pyannote.audio.utils.protocol creates Audio(mono="downmix") at module level.
_torchaudio.list_audio_backends = lambda: ["soundfile"]
print("[patches] ✅ Patched torchaudio.list_audio_backends → soundfile")


# ── 3. pyannote.audio get_torchaudio_info patch ──
# pyannote.audio uses torchaudio.info(backend=...), also deprecated.
# We replace get_torchaudio_info with a soundfile-based implementation.
class _SafeAudioMetaData:
    """Duck-typed replacement for torchaudio.AudioMetaData.
    Avoids the in-place deprecation wrapper on torchaudio's AudioMetaData.__init__."""
    def __init__(self, sample_rate, num_frames, num_channels):
        self.sample_rate = sample_rate
        self.num_frames = num_frames
        self.num_channels = num_channels
        self.bits_per_sample = 0
        self.encoding = "PCM_S"


try:
    import pyannote.audio.core.io as _pyannote_io

    def _patched_get_torchaudio_info(file, backend=None):
        sinfo = soundfile.info(file["audio"])
        return _SafeAudioMetaData(sinfo.samplerate, sinfo.frames, sinfo.channels)

    _pyannote_io.get_torchaudio_info = _patched_get_torchaudio_info
    print("[patches] ✅ Patched pyannote.audio → soundfile (avoids torchaudio deprecations)")
except Exception:
    pass  # pyannote may not be installed
