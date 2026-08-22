# Runbooks

Two dashboard configuration tasks the codebase can't do on its own —
LiveKit Cloud webhook delivery (FRS §4) and Clerk MFA (FRS §12.1).
Each runbook is written so a browser-equipped Claude (or a human) can
execute it start to finish.

> **Both runbooks were audited against the live dashboards on
> 2026-08-22 and both had drifted from reality.** LiveKit needed no
> configuration at all; Clerk cannot be configured on the current plan.
> Each file carries a "What changed" section at the bottom. If you are
> reading a runbook that has no such section, or whose verification date
> is stale, re-check it against the dashboard before trusting its steps.

Every runbook has the same structure:

1. **Purpose** — the FRS section it closes, the practical effect.
2. **Prerequisites** — access needed + which browser tool to use.
3. **Steps** — navigate → click → verify, one action per numbered item.
4. **Verification** — how to confirm the change actually took effect
   from outside the dashboard.
5. **Rollback** — how to undo it if something looks wrong.

## Ground rules for whoever executes these

- **Never enter credentials on the user's behalf.** If a dashboard is
  signed out, hand it back to the user and wait.
- **Never guess which project, instance, or environment to configure.**
  Both of these runbooks previously omitted that choice, and in both
  cases the obvious-looking default was wrong: LiveKit's production
  endpoint lives in a project named `neoconference-dev`, and Clerk's
  dashboard opens on Development rather than Production. Ask by name.
- **Read the page before clicking.** Don't fabricate selectors; find the
  matching text or aria-label. If the UI doesn't match the runbook,
  stop and report the drift rather than improvising something close.
- **Billing changes are not part of any runbook.** If a feature is
  plan-gated, surface it and stop.

## Which browser tool to use

The runbooks are neutral about which browser toolkit executes them.
Pick based on what's available in the current session:

- **claude-in-chrome** (`mcp__claude-in-chrome__*`) — drives the user's
  real Chrome. Preferred when the user is already signed in to the
  dashboard being configured. No credential handling needed.
- **Claude Browser** (`mcp__Claude_Browser__*`) — sandboxed in-app
  browser. Use when the user isn't required to be signed in on their
  own machine (or when running headlessly).
- **computer-use** (`mcp__computer-use__*`) — native OS control.
  Fine for either browser but slower and more brittle than the two
  above; keep as fallback.

## Runbooks

- [LiveKit Cloud webhook delivery](./setup-livekit-webhooks.md) — FRS §4 belt-and-suspenders coverage for attendance capture.
- [Clerk multi-factor authentication](./setup-clerk-2fa.md) — FRS §12.1 2FA for Owner (platform-admin) accounts.

## Verification endpoint

`GET /api/admin/verify-webhooks` (platform-admin gated) reports which
LiveKit events have been counted. Response shape:

```json
{
  "ok": true,
  "healthy": true,
  "missing": [],
  "stale": [],
  "metrics": [
    { "event": "room_started",       "count": 12, "lastAtMs": 1740147600000 },
    { "event": "room_finished",      "count": 12, "lastAtMs": 1740148300000 },
    { "event": "participant_joined", "count": 47, "lastAtMs": 1740147600300 },
    { "event": "participant_left",   "count": 45, "lastAtMs": 1740148300500 },
    { "event": "egress_started",     "count": 3,  "lastAtMs": 1740147900000 },
    { "event": "egress_updated",     "count": 0,  "lastAtMs": null },
    { "event": "egress_ended",       "count": 3,  "lastAtMs": 1740148100000 }
  ],
  "generatedAt": 1740148900000
}
```

`healthy` is `true` when every event in `REQUIRED` has a non-zero count
in the last 24 hours. `missing` lists required events that have never
fired; `stale` lists ones that fired but not recently.

**Two caveats before treating this as a green light:**

- It counts *any* POST to the webhook route, including LiveKit's
  dashboard **Actions → Send a test event**. A `healthy: true` produced
  by test events proves the route and the counters work — not that real
  meetings emit the events. Only a real meeting proves that.
- Counters start empty at each telemetry deploy and are stored in
  Vercel KV (`neo:webhook:metrics`). All-zero on a fresh build means
  "no traffic yet". Persistent zeros despite real traffic can mean
  `KV_REST_API_URL` / `KV_REST_API_TOKEN` are unset, in which case
  `webhookMetrics.ts` falls back to a per-instance in-memory map and the
  endpoint can never go healthy on serverless.
