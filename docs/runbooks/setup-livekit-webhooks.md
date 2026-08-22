# Setup: LiveKit Cloud webhook subscriptions

## Purpose

FRS §4 requires attendance capture across the entire meeting. The
NeoConference codebase already handles the `participant_joined` and
`participant_left` webhook events (see `src/app/api/livekit/webhook/route.ts`)
but LiveKit Cloud only delivers events that the project owner has
explicitly subscribed to. This runbook enables those two subscriptions
so the belt-and-suspenders attendance capture the codebase is written
for actually engages.

Client-side beacons already cover most cases. What this runbook fixes:
users who close their laptop mid-meeting, kill their browser process,
or lose network before the `beforeunload` beacon can fire. LiveKit's
server-side webhook catches those.

## Prerequisites

- A browser tool is available (`claude-in-chrome` preferred; see
  `docs/runbooks/README.md` for the selection guidance).
- The user is signed in to https://cloud.livekit.io — or is prepared
  to sign in when prompted. Do not attempt to enter credentials on
  their behalf.
- The user knows which LiveKit project powers NeoConference. If
  unsure, ask them before proceeding — the wrong project will silently
  configure webhooks for something unrelated.

## Steps

1. **Navigate to the LiveKit Cloud console.**
   - URL: `https://cloud.livekit.io/`
   - After sign-in the console lands on the projects list. If the user
     has more than one project, they will need to pick the correct one
     — ask them by name rather than guessing.

2. **Open the target project.**
   - Look for the tile or row matching the project the user names
     (typically "neoconference" or similar).
   - Click it. The project overview page loads.

3. **Open the Webhooks settings page.**
   - Look for a left-hand nav item labeled **Settings** (gear icon),
     then a sub-item labeled **Webhooks**. On some plans it may be a
     top-level tab labeled **Webhooks** directly.
   - The Webhooks page lists existing endpoints (URL + subscribed
     events). NeoConference should already have one endpoint pointing
     at `https://www.neoconference.app/api/livekit/webhook`; if it
     doesn't, this runbook cannot finish — bail out and tell the user.

4. **Edit the existing NeoConference endpoint.**
   - Click the row whose URL contains `neoconference.app`.
   - LiveKit opens an edit panel with a checklist of event types.

5. **Enable the missing event types.**
   - Ensure the following boxes are **checked**:
     - `room_started`
     - `room_finished`
     - `egress_ended`
     - **`participant_joined`** — this is the important one this runbook
       exists to enable.
     - **`participant_left`** — this is the other important one.
   - Do NOT uncheck anything that was already ticked; some of them
     (`room_started` in particular) are load-bearing for other features.

6. **Save the endpoint.**
   - Click **Save** / **Update endpoint** / whatever the action label
     is. LiveKit briefly shows a success toast.

7. **Verify with a test meeting.**
   - In a separate tab, open the NeoConference app
     (`https://www.neoconference.app/`), sign in as any user, start a
     new meeting, join, then leave. That triggers exactly one
     `room_started`, one `participant_joined`, one `participant_left`,
     and one `room_finished` on the LiveKit side.

8. **Confirm the events landed.**
   - Have the user hit `https://www.neoconference.app/api/admin/verify-webhooks`
     while signed in as a platform admin (email in `ADMIN_EMAILS`).
   - Expected response body: `"healthy": true` with non-null `lastAtMs`
     values for `participant_joined` and `participant_left` in the
     `metrics` array.
   - If those two events still show `count: 0` after a two-minute wait,
     go back to step 5 — LiveKit occasionally silently rejects a save
     when the endpoint URL doesn't respond quickly enough.

## Verification (external)

- `GET /api/admin/verify-webhooks` returns `"healthy": true` and the
  `missing` array is empty.
- The `metrics` entry for `participant_joined` shows `count` incrementing
  each time a participant joins a meeting.
- The attendance XLSX from `GET /api/events/[id]/attendance` shows both
  `webhook` and `beacon` sources represented (visible in the raw journal
  via a KV inspection or by joining and leaving multiple times).

## Rollback

- Reopen the endpoint from step 3.
- Uncheck `participant_joined` and `participant_left`.
- Save.
- The codebase silently degrades to beacon-only attendance capture
  (which was the state before this runbook ran). No further cleanup
  needed on the app side.
