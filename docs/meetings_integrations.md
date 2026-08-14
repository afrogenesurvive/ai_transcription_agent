# Meetings Integrations (System Recording, Teams, Zoom)

Setup and usage guide for the three New Job sources added in 0.8.6-2.

## New Job — three sources

The New Job form has three tabs:

| Tab                  | What it does                                                                |
| -------------------- | --------------------------------------------------------------------------- |
| **Upload**           | Existing file upload (unchanged).                                           |
| **System Recording** | Records meeting audio live from system output.                              |
| **Teams/Zoom**       | Pulls a meeting's cloud recording + attendees from Microsoft Teams or Zoom. |

All three submit through the same in-app pipeline (diarization → ASR → voiceprints → agent). Job results show the audio **Source** in the Audio tab.

## System Recording

Records whatever audio your computer is playing (both sides of a meeting). No per-participant audio is exposed by Teams/Zoom, so speaker diarization + voiceprints still assign "who said what".

### Windows

Uses the built-in Windows system-audio capture (WASAPI loopback) — **no driver and no video**. Click **Start Recording**, play your meeting, click **Stop**. The audio is saved as a WebM and fed straight into transcription.

### macOS

macOS has no driver-free system-audio capture, so the free **BlackHole** virtual driver is required:

1. Install [BlackHole](https://github.com/ExistentialAudio/BlackHole) (BlackHole 2ch is fine).
2. Open **Audio MIDI Setup** → **+** → **Create Multi-Output Device**.
3. Add **BlackHole 2ch** and your speakers/headphones to the Multi-Output Device, then set it as the default output. This routes audio to BlackHole (for capture) **and** your speakers (so you can still hear).
4. In the app, the System Recording tab detects BlackHole and captures it with the bundled ffmpeg to an M4A.

The tab shows setup guidance when BlackHole isn't detected.

## Microsoft Teams

### App registration (Entra ID)

1. Go to the [Microsoft Entra admin center](https://entra.microsoft.com) → **App registrations** → **New registration**.
2. Name it, choose **Accounts in this organizational directory only** (work/school) — Teams cloud recordings require a work/school account.
3. Under **Platform** → **Add a platform** → **Mobile and desktop applications** → redirect URI `http://localhost` (native/public client — **no client secret**).
4. **API permissions** (delegated): `User.Read`, `Calendars.Read`, `OnlineMeetings.Read`, `Files.Read.All`.
5. Copy the **Application (client) ID** into Config → Services → **Teams Client ID**.

### Connecting in the app

1. Config → Services → **Microsoft Teams** accordion → set **Teams Client ID** (use the in-app "How to get these credentials" steps, or set it manually).
2. Click **Connect Microsoft Teams** right in the Services accordion (or in the Teams/Zoom tab) → approve the consent page.
3. **Refresh** to list your online meetings, select one, then **Fetch Recording & Attendees**.
4. Attendees (names + emails) are pre-filled; review, then **Start Transcription**.

> **Redirect URI:** the app's OAuth flow redirects to `http://localhost:<ephemeral port>/`.
> The native/public-client registration of `http://localhost` (above) matches any
> localhost port, so no port needs to be registered for Teams.

## Zoom

### App registration (Zoom Marketplace)

1. [Zoom Marketplace](https://marketplace.zoom.us) → **Build App** → **OAuth** (general purpose).
2. Redirect URL for OAuth: `http://localhost` (also add `http://localhost:PORT` if needed).
3. Scopes: `meeting:read`, `recording:read`, `user:read`.
4. Copy the **Client ID** and **Client Secret** into Config → Services.

### Connecting in the app

1. Config → Services → **Zoom** accordion → set **Zoom Client ID** and **Zoom Client Secret** (use the in-app "How to get these credentials" steps, or set them manually).
2. Click **Connect Zoom** right in the Services accordion (or in the Teams/Zoom tab) → approve the consent page.
3. **Refresh** to list meetings with cloud recordings (last 30 days), select one, **Fetch Recording & Attendees**.
4. Note: Zoom often hides participant emails — pre-filled attendees may need emails added manually for voiceprint matching.

> **Redirect URI:** the app's OAuth flow redirects to `http://localhost:<ephemeral port>/`.
> Zoom validates the redirect URL as an **exact match**, so an ephemeral port cannot be
> pre-registered. If "authorization failed" occurs, either register a fixed loopback
> port for the app (e.g. `http://localhost:8770`) and use that consistently, or add the
> exact redirect shown in the consent URL to your Zoom app's redirect allow-list.

## Config keys (Config → Services)

| Key                  | Meaning                                      |
| -------------------- | -------------------------------------------- |
| `MS_CLIENT_ID`       | Teams (Entra) application client ID          |
| `MS_REFRESH_TOKEN`   | Teams refresh token (auto-filled by Connect) |
| `MS_USER`            | Teams signed-in user                         |
| `ZOOM_CLIENT_ID`     | Zoom OAuth client ID                         |
| `ZOOM_CLIENT_SECRET` | Zoom OAuth client secret                     |
| `ZOOM_REFRESH_TOKEN` | Zoom refresh token (auto-filled by Connect)  |
| `ZOOM_USER`          | Zoom signed-in user                          |

These are regular config keys, so they participate in config export/import, "save as defaults", and "restore defaults" like every other setting.
