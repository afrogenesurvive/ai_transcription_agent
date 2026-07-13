"""
Consolidated monkey-patches for third-party library compatibility.

Applied once at import time (imported by main.py before any other module).
All patches are idempotent — importing multiple times is safe.

Patches:
  1. speechbrain LazyModule.__getattr__ — prevents crash on __file__ access
  2. torchaudio.list_audio_backends — avoids deprecated API that pyannote triggers
  3. pyannote.audio get_torchaudio_info — replaces deprecated torchaudio.info call
  4. torch.load weights_only — PyTorch 2.6+ defaults weights_only=True, which
     breaks loading pyannote checkpoints (contain pytorch_lightning callback
     classes not in the safe globals allowlist). The checkpoints come from
     HuggingFace (trusted source), so we default to weights_only=False.
"""

import soundfile
import torch
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


# ── 4. torch.load weights_only workaround ──
# PyTorch 2.6+ changed the default of `weights_only` from False to True.
# pyannote checkpoints contain pytorch_lightning callback classes (e.g.
# EarlyStopping) that aren't in the safe globals allowlist, causing:
#   _pickle.UnpicklingError: Weights only load failed.
# The checkpoints come from HuggingFace (trusted source), so we default
# to weights_only=False to restore the pre-2.6 behaviour.
_orig_torch_load = torch.load


def _patched_torch_load(f, *args, **kwargs):
    # Force weights_only=False regardless of what callers pass.
    # lightning_fabric.utilities.cloud_io._load explicitly passes
    # weights_only=True (PyTorch 2.6+ default), which breaks loading
    # pyannote checkpoints from HuggingFace (trusted source).
    kwargs["weights_only"] = False
    return _orig_torch_load(f, *args, **kwargs)


torch.load = _patched_torch_load
print("[patches] ✅ Patched torch.load → forces weights_only=False")
