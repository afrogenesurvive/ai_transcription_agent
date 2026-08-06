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

import os
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
    print("[patches] [OK] Patched speechbrain LazyModule.__getattr__ (safe __file__)")
except Exception:
    pass  # speechbrain may not be installed


# ── 6. speechbrain find_imports resilience (PyInstaller) ──
# speechbrain's lazy loader scans package dirs with os.listdir(). Under PyInstaller
# those directories aren't always extracted to disk (modules can live in the PYZ), so
# lobes/__init__.py -> lazy_export_all -> find_imports can crash with
# FileNotFoundError [WinError 3] '..._internal\speechbrain\lobes'.
# Make it return [] when the directory is missing; explicit imports
# (speechbrain.inference) still resolve from the bundle.
try:
    import speechbrain.utils.importutils as _sb_importutils
    _orig_sb_find_imports = _sb_importutils.find_imports

    def _safe_sb_find_imports(file_path, find_subpackages=False):
        try:
            return _orig_sb_find_imports(
                file_path, find_subpackages=find_subpackages
            )
        except OSError:
            return []

    _sb_importutils.find_imports = _safe_sb_find_imports
    print("[patches] [OK] Patched speechbrain.find_imports -> resilient to missing package dirs (PyInstaller)")
except Exception:
    pass  # speechbrain may not be installed


# ── 2. torchaudio compat patch ──
# pyannote.audio uses torchaudio.list_audio_backends() — deprecated since
# torchaudio 2.5+ and scheduled for removal in torchaudio 2.9.
# Since all pipeline audio is 16kHz mono WAV, we hardcode to "soundfile".
# IMPORTANT: Must run BEFORE any pyannote import, because
# pyannote.audio.utils.protocol creates Audio(mono="downmix") at module level.
_torchaudio.list_audio_backends = lambda: ["soundfile"]
print("[patches] [OK] Patched torchaudio.list_audio_backends -> soundfile")


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
    print("[patches] [OK] Patched pyannote.audio -> soundfile (avoids torchaudio deprecations)")
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
print("[patches] [OK] Patched torch.load -> forces weights_only=False")


# ── 5. tqdm download progress capture ──
# huggingface_hub renders model download progress with tqdm. We wrap tqdm to
# record (done, total) bytes into a global so the backend can report a live
# percentage to the UI while the diarization model downloads on first run.
_dl_progress = {"active": False, "done": 0, "total": 0}


def get_dl_progress():
    """Return a snapshot of the current download progress (bytes)."""
    return dict(_dl_progress)


try:
    import tqdm as _tqdm_mod

    def _set_progress(tq):
        """Record current byte progress into the shared dict (best-effort)."""
        try:
            _dl_progress["active"] = True
            _dl_progress["done"] = int(getattr(tq, "n", 0) or 0)
            _dl_progress["total"] = int(getattr(tq, "total", 0) or 0)
        except Exception:
            pass

    class _TrackingTqdm(_tqdm_mod.tqdm):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            _set_progress(self)

        def update(self, n=1):
            result = super().update(n)
            _set_progress(self)
            return result

        def close(self):
            try:
                super().close()
            finally:
                # Guarded: at interpreter shutdown the module globals may be
                # torn down (None), so never assume _dl_progress exists.
                try:
                    _dl_progress["active"] = False
                except Exception:
                    pass

    # Patch the concrete tqdm classes huggingface_hub may reference (lazy
    # imports resolve to these at call time).
    _tqdm_mod.tqdm = _TrackingTqdm
    try:
        import tqdm.std as _tqdm_std
        _tqdm_std.tqdm = _TrackingTqdm
    except Exception:
        pass
    try:
        import tqdm.auto as _tqdm_auto
        _tqdm_auto.tqdm = _TrackingTqdm
    except Exception:
        pass
    print("[patches] [OK] Patched tqdm -> records download progress for UI feedback")
except Exception:
    pass  # tqdm unavailable


def force_offline():
    """Force huggingface_hub into offline/local-cache mode for the whole process.

    Sets ``HF_HUB_OFFLINE`` and patches the ``HF_HUB_OFFLINE`` constant on the
    huggingface_hub modules that captured it at import time, so all subsequent
    ``hf_hub_download``/``snapshot_download`` calls (including pyannote's internal
    sub-model loads) read from the local cache only and never touch the network.
    """
    os.environ["HF_HUB_OFFLINE"] = "1"
    try:
        import huggingface_hub.constants as _hf_const
        _hf_const.HF_HUB_OFFLINE = True
        for _mod_name in ("file_download", "_snapshot_download", "hf_hub_download"):
            try:
                _mod = __import__(
                    "huggingface_hub." + _mod_name, fromlist=["HF_HUB_OFFLINE"]
                )
                if hasattr(_mod, "HF_HUB_OFFLINE"):
                    _mod.HF_HUB_OFFLINE = True
            except Exception:
                pass
        return True
    except Exception:
        return False
