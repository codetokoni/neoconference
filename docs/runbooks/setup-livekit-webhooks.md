# Setup: LiveKit Cloud webhook delivery

> **Verified against the live LiveKit Cloud dashboard on 2026-08-22.**
> An earlier revision of this runbook described a per-event subscription
> checklist that does not exist. See "What changed" at the bottom.

## Purpose

FRS §4 requires attendance capture across the entire meeting. The
NeoConference codebase handles the `participant_joined` and
`participant_left` webhook events (see
`src/app/api/livekit/webhook/route.ts`), and client-side beacons cover
most cases. The webhooks exist to catch what beacons miss: users who
close their laptop mid-meeting, kill the browser process, or lose
network before `beforeunload` can fire.

**There is nothing to subscribe to.** LiveKit Cloud has no per-event
subscription model. A registered webhook endpoint receives *every*
event type the project emits. So the only questions this runbook can
answer are:

1. Is an endpoint registered, and does it point at production?
2. Are events actually arriving and being counted?

If both are yes, FRS §4 is closed on the LiveKit side.

## Prerequisites

- A browser tool is available (`claude-in-chrome` preferred; see
  `docs/runbooks/README.md`).
- The user is signed in to https://cloud.livekit.io — or is prepared
  to sign in when prompted. Do not attempt to enter credentials on
  their behalf.
- The user knows which LiveKit project powers NeoConference. **Ask
  them by name; do not infer it from the project name.** As of
  2026-08-22 the production endpoint lives in a project named
  `neoconference-dev` (`p_gsua63jiy5v`) — the name is misleading and
  there is no separate "prod" project.

## Steps

1. **Navigate to the LiveKit Cloud console.**
   - URL: `https://cloud.livekit.io/`
   - After sign-in the console lands on the projects list.

2. **Open the target project.**
   - Click the tile matching the project the user named.

3. **Open the Webhooks page.**
   - Left nav: **Settings**, then **Webhooks** in the settings sidebar.
   - Direct URL: `https://cloud.livekit.io/projects/<project_id>/settings/webhooks`

4. **Confirm the production endpoint is registered.**
   - Expect one entry named `neoconference`, with URL
     `https://www.neoconference.app/api/livekit/webhook` and a signing
     API key.
   - **If it is present, there is nothing to configure.** Skip to
     step 6.
   - If it is absent, continue to step 5.

5. **(Only if missing) Register the endpoint.**
   - Click **Create new webhook**. The dialog has exactly three
     fields: **Name**, **URL**, **Signing API key**. There is no event
     selection — this is expected.
   - Name: `neoconference`
   - URL: `https://www.neoconference.app/api/livekit/webhook`
   - Signing API key: select the project key the app is configured
     with. The app verifies the signature, so a mismatch here means
     every delivery is rejected.
   - Click **Create**.

6. **Confirm events are landing.**
   - Have the user hit
     `https://www.neoconference.app/api/admin/verify-webhooks`
     while signed in as a platform admin (email in `ADMIN_EMAILS`).
   - Expect `"healthy": true` with non-null `lastAtMs` for
     `room_started`, `room_finished`, `participant_joined` and
     `participant_left`.
   - **Counters only reflect traffic since the telemetry deploy.** All
     zeros on a freshly deployed build means "no meetings yet", not
     "misconfigured". Run a real meeting before concluding anything.

## Verification (external)

Run one real meeting on `https://www.neoconference.app/` — sign in,
start a meeting, join, leave, end — then re-check
`GET /api/admin/verify-webhooks`. That exercises all four required
events in one pass.

- `"healthy": true` and the `missing` array is empty.
- The `participant_joined` counter increments on each subsequent join.
- The attendance XLSX from `GET /api/events/[id]/attendance` shows both
  `webhook` and `beacon` sources represented.

> **The green light is weaker than it looks.** `verify-webhooks` counts
> anything that POSTs to the route, including LiveKit's dashboard
> **Actions → Send a test event**. A `healthy: true` produced by test
> events proves the route and the KV counters work; it does not prove
> that real meetings emit the events. Only a real meeting proves that.

## Troubleshooting

- **All counters at 0 after a real meeting.** Check that the endpoint's
  signing API key matches the key pair the app verifies with — a
  signature mismatch is rejected before `recordWebhookEvent` runs.
  Check the route's logs for `[webhook-metrics] KV write failed`.
- **Counters reset or never move despite deliveries.** `webhookMetrics.ts`
  falls back to a module-level in-memory `Map` when `KV_REST_API_URL` /
  `KV_REST_API_TOKEN` are unset. On serverless, the instance handling
  the LiveKit POST is rarely the one serving the admin GET, so with KV
  unconfigured the endpoint reads 0 forever. Confirm those vars are set
  on the Vercel project. (Verified set and working on 2026-08-22.)
- **A single event type is silent.** Use **Actions → Send a test event**
  on the endpoint and pick that event type. If the counter moves, the
  delivery path is fine and the event simply isn't being emitted by real
  traffic.

## Rollback

Nothing in steps 1-4 changes anything, so there is normally nothing to
roll back. If step 5 registered an endpoint that shouldn't exist, delete
it via **Actions → Delete webhook**. The codebase degrades to
beacon-only attendance capture; no app-side cleanup is needed.

## What changed (2026-08-22)

The previous revision instructed the operator to open the endpoint's
edit panel and tick `participant_joined` / `participant_left` in "a
checklist of event types". No such checklist exists: **Edit webhook
endpoint** exposes only Name and URL, and **New webhook endpoint** only
Name, URL and Signing API key. A dashboard test event of type
`participant_joined` was delivered and counted with zero configuration
changes, confirming LiveKit already sends it. The FRS §4 "dashboard-only
gap" was a false premise.
