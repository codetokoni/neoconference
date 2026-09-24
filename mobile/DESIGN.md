# NeoConference mobile — UI

A Flutter UI for joining and running NeoConference meetings on iOS and
Android, built on the website's own brand rather than a new one.

Run the design showcase (sample data, no backend needed):

```bash
cd mobile
flutter run -t lib/main_showcase.dart
```

Run the production app (real Clerk sign-in, real API, real LiveKit):

```bash
flutter run            # uses lib/main.dart
```

---

## Reused brand assets

Nothing here was invented where the site already had an answer.

| Asset | Taken from | Used as |
|---|---|---|
| Logo mark | `src/app/layout.tsx`, inline `<svg viewBox="0 0 24 24">` | `NeoLogoMark` — the same camera path, redrawn as a Flutter `Path` |
| Tile gradient | `from-cyan-300 via-cyan-400 to-blue-500` on the header mark | `NeoPalette.markGradient` |
| Wordmark | `layout.tsx` — "Neo" + gradient "Conference" | `NeoWordmark`, via `ShaderMask` (the Flutter equivalent of `background-clip: text`) |
| Wordmark gradient | `globals.css` `.neo-gradient-text` | `#a5f3fc → #67e8f9 → #38bdf8 → #818cf8` |
| Dark palette | `globals.css` `:root` custom properties | `NeoPalette.dark`, verbatim |
| App icon | `src/app/icon.png`, `apple-icon.png` | reference for the mark's proportions |
| Voice | `src/app/page.tsx` — "Meetings reimagined. Cinematic. Instant. Yours." | welcome screen copy |
| Role names | `src/types/event.ts` | Host, Co-host, Speaker, Attendee |

The **light palette is derived, not lifted** — the site is dark-only. Its
foregrounds were chosen for contrast rather than by lightening the dark
ones: the website's cyan `#22D3EE` is about 1.9:1 on white and unusable as
a text colour, so light mode uses `#0E7490` (5.7:1).

---

## Screen map

```
Splash
└── Welcome ──────────► Sign in ──► Account recovery
                          │
                          ▼
                    App shell (bottom nav)
                    ├── Home
                    │   ├── Next up ──► Pre-join ──► Meeting
                    │   ├── Join (sheet: link / ID / invitation)
                    │   ├── Start ──► Pre-join ──► Meeting
                    │   └── Schedule
                    ├── History
                    │   ├── Meetings
                    │   └── Recordings (hidden without access)
                    ├── Alerts
                    └── Profile / settings
                        ├── State gallery
                        └── Role gallery

Meeting
├── Speaker view / Grid view
├── Controls: Mute · Video · Chat · More · Leave
├── Participants sheet ──► per-person actions (role-gated)
├── Chat sheet
└── More sheet
    ├── Raise hand, reaction, share screen, audio output, translation
    ├── Meeting details (link, share, QR)
    └── Host controls (role-gated)
```

### States

Empty, loading (skeletons), permission denied, weak connection,
reconnecting, and meeting ended are all built and reachable from
**Profile → States (for review)** rather than existing only in theory.

---

## Roles

One table, `MeetingPermissions`, consulted by every sheet — so a permission
cannot be enforced in one place and forgotten in another.

| | Owner | Host | Co-host | Moderator | Attendee |
|---|---|---|---|---|---|
| Mute / remove others | ✓ | ✓ | ✓ | ✓ | |
| Waiting room | ✓ | ✓ | ✓ | ✓ | |
| Lock meeting | ✓ | ✓ | ✓ | | |
| **Recording** | ✓ | ✓ | ✓ | **✗** | |
| Change roles | ✓ | ✓ | | | |
| End for everyone | ✓ | ✓ | | | |

A Moderator sees no recording controls **at all** — not greyed out, absent,
with a line explaining who does have them. A disabled control someone can
never enable is an invitation to keep trying.

> **Backend gap:** the product has no `moderator` role. `src/types/event.ts`
> defines host, cohost, speaker, viewer, attendee. Moderator is modelled in
> the UI only and needs adding server-side before it means anything.

---

## Design system

`lib/src/design/`

- **`tokens.dart`** — `NeoPalette` (light + dark), `NeoSpace`, `NeoRadius`,
  `NeoMotion`. Spacing is a 4pt scale; `NeoSpace.minTouch` is 44.
- **`brand.dart`** — `NeoLogoMark`, `NeoWordmark`, `NeoLogo`, and `NeoTheme`,
  which carries the palette down the tree.
- **`neo_theme.dart`** — `ThemeData` for both brightnesses, including
  platform-appropriate page transitions (Cupertino slide on iOS,
  fade-upwards on Android).
- **`components.dart`** — `NeoCard`, `NeoSection`, `NeoPill`, `NeoAvatar`,
  `NeoControlButton`, `NeoEmptyState`, `NeoSkeleton`, `NeoBanner`,
  `neoConfirm`, `neoSheet`.

### Accessibility

- Every control is at least 44×44pt, and meeting controls are labelled —
  an unlabelled icon row is a memory test under pressure, and the label is
  what a screen reader announces.
- Text scaling is honoured and clamped to 1.6× (a 3× system setting turns
  the control bar into a stack of words).
- Avatar colour is derived from the name, so the same person is the same
  colour in the grid, the participant list and chat.

---

## Sample data

`lib/src/mock/sample_data.dart`, and nothing outside the showcase imports
it. Realistic names and meeting titles on purpose: long names and wrapping
titles surface layout problems during design rather than after launch.

The production entrypoint (`lib/main.dart`) does not touch it.

---

## What is NOT implemented

This is a UI. The following are **designed and not built**, and no screen
should be read as evidence that they work:

### Native capabilities still required

| Capability | What is needed |
|---|---|
| **Background audio** | Android: a foreground service with `microphone` type, `FOREGROUND_SERVICE_MICROPHONE`, and a persistent notification. iOS: `UIBackgroundModes: audio` plus an `AVAudioSession` configured `.playAndRecord` with `.voiceChat` mode. Without these the OS suspends the connection — already observed on a real device, where the LiveKit socket died when the screen went off. |
| **Picture in Picture** | Android: `android:supportsPictureInPicture` and `enterPictureInPictureMode` with a `PictureInPictureParams` aspect ratio. iOS: `AVPictureInPictureController` over a sample-buffer display layer; Flutter texture views are **not** directly PiP-able and need a platform view. |
| **Incoming calls** | iOS: CallKit, so a meeting yields to a phone call and resumes. Android: `ConnectionService` or at minimum an audio-focus listener. |
| **Bluetooth routing** | Android: `AudioManager.setCommunicationDevice` plus `BLUETOOTH_CONNECT`. iOS: `AVAudioSession` port override. The route picker in pre-join is presentation only. |
| **Network changes** | `connectivity_plus` to observe Wi-Fi ↔ cellular handover and drive the weak/reconnecting states, which are currently driven by a parameter. |
| **Device enumeration** | The pre-join device checks show sample values. Real camera/mic listing comes from `flutter_webrtc`'s `navigator.mediaDevices`. |

### Backend integrations still required

- `GET /api/events/mine` returns owned events only — there is no reverse
  index from user to invited event, so **Upcoming** cannot yet show meetings
  someone was invited to.
- No scheduling endpoint. `POST /api/events/create` takes no `scheduledAt`
  from the app, and the schedule screen does not persist.
- No notifications backend: no push registration, no notification store.
- `moderator` role, as above.
- Recording playback: `egress/stop` returns a 24h presigned URL; there is no
  durable per-recording fetch for the history screen.
- **Inbound LiveKit data is broken on Flutter** (upstream
  [livekit/client-sdk-flutter#1221](https://github.com/livekit/client-sdk-flutter/issues/1221)),
  so live chat in the *production* app is delivered by polling, not the data
  channel.

### Verified

- `flutter analyze` clean; existing tests pass.
- Every screenshot below was taken from a release build on a physical
  Galaxy S25 Ultra (Android 16), not a simulator or a mockup.
