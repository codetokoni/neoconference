# Runbooks

Two dashboard configuration tasks the codebase can't do on its own —
LiveKit Cloud webhook subscriptions (FRS §4) and Clerk 2FA
enforcement (FRS §12). Each runbook is written so a browser-equipped
Claude (or a human) can execute it start to finish.

Every runbook has the same structure:

1. **Purpose** — the FRS section it closes, the practical effect.
2. **Prerequisites** — required credentials + which browser tool to use.
3. **Steps** — navigate → click → verify, one action per numbered item.
4. **Verification** — how to confirm the change actually took effect
   from outside the dashboard.
5. **Rollback** — how to undo it if something looks wrong.

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

For any of them, the runbook's URL and "look for" cues are what you
navigate by. Don't fabricate selectors — read the page state first,
find the matching text or aria-label, then click.

## Runbooks

- [Enable LiveKit Cloud webhook subscriptions](./setup-livekit-webhooks.md) — FRS §4 belt-and-suspenders coverage for attendance capture.
- [Enable Clerk multi-factor authentication](./setup-clerk-2fa.md) — FRS §12.1 2FA for Owner (platform-admin) accounts.

## Verification endpoint

After running `setup-livekit-webhooks.md`, hit
`GET /api/admin/verify-webhooks` (platform-admin gated) to confirm the
subscribed events are actually landing. Response shape:

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
fired; `stale` lists ones that fired but not recently. The runbook
uses this endpoint as its "green light" before declaring done.
