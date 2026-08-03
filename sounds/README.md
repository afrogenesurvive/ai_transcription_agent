# Alert Sounds

Drop your alert sound here as **`alert.wav`** (WAV, PCM 16‑bit, mono or stereo,
1–3 seconds, < ~1 MB).

- **Dev:** the app reads it directly from this folder — no rebuild needed.
- **Packaged builds:** this folder is bundled into the app via
  `electron-builder` `extraResources` (see `electron/package.json`) and played
  from `Contents/Resources/sounds/` (macOS) / `resources\sounds\` (Windows).
- **Missing file:** the app falls back to a short system beep.

Optional override: set the `ALERT_SOUND_PATH` environment variable to point at
any audio file to bypass this folder entirely.
