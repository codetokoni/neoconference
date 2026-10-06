# NeoConference API

The NeoConference API lets you create meetings, mint guest join tokens, and access events, replays and recordings programmatically.

- Base URL: `https://www.neoconference.app/api/v1`
- Interactive reference: `https://www.neoconference.app/docs`
- Spec: `https://www.neoconference.app/openapi.json`

## Authentication

All requests require an API key, sent as a Bearer token:

```
Authorization: Bearer nc_live_xxxxxxxxxxxxxxxxxxxx
```

Create and revoke keys from your dashboard at **Dashboard -> Developers -> API Keys**. Keys are shown only once at creation time; store them securely. We store only a hash of each key, never the raw value.

## Rate limits

Requests are limited per key, per minute, based on your plan:

| Plan       | Requests / min |
| ---------- | -------------- |
| Free       | 60             |
| Starter    | 120            |
| Pro        | 300            |
| Business   | 600            |
| Enterprise | 2000           |

Every response includes `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` headers. Exceeding the limit returns `429 rate_limited`.

## Response shape

Successful responses are wrapped in a `data` envelope:

```json
{ "data": { "id": "..." } }
```

Errors use a consistent shape:

```json
{ "error": { "code": "not_found", "message": "Meeting not found." } }
```

## Quickstart

### Create a meeting

```bash
curl -X POST https://www.neoconference.app/api/v1/meetings \\
  -H "Authorization: Bearer $NC_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "name": "Weekly sync", "maxParticipants": 50 }'
```

### Mint a guest join token

```bash
curl -X POST https://www.neoconference.app/api/v1/meetings/$MEETING_ID/tokens \\
  -H "Authorization: Bearer $NC_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "identity": "guest-123", "displayName": "Ada" }'
```

The response contains a LiveKit `token` and `url` your client SDK uses to join.

### List recordings

```bash
curl https://www.neoconference.app/api/v1/meetings/$MEETING_ID/recordings \\
  -H "Authorization: Bearer $NC_API_KEY"
```

Each recording includes a short-lived `downloadUrl` (valid for 1 hour).

## Endpoints

| Method | Path                      | Description             |
| ------ | ------------------------- | ----------------------- |
| GET    | /meetings                 | List meetings           |
| POST   | /meetings                 | Create a meeting        |
| GET    | /meetings/{id}            | Get a meeting           |
| DELETE | /meetings/{id}            | End a meeting           |
| POST   | /meetings/{id}/tokens     | Mint a guest join token |
| GET    | /meetings/{id}/recordings | List recordings         |
| GET    | /events                   | List events             |
| GET    | /events/{slug}            | Get an event / replay   |

## Embed on your website

You can drop a live, interactive NeoConference meeting directly into any website using an iframe. The flow has two steps:

1. **Server-side:** mint a short-lived guest join token for the current user.
2. **Client-side:** load the embed URL (or the loader script) with that token.

### 1. Mint a token (server-side)

```bash
curl -X POST https://www.neoconference.app/api/v1/meetings/$MEETING_ID/tokens \\
  -H "Authorization: Bearer $NC_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "identity": "guest-123", "displayName": "Ada" }'
```

The response contains a `token` you pass to the embed.

### 2a. Drop-in iframe

```html
<iframe
  src="https://www.neoconference.app/embed/meeting?token=GUEST_JOIN_TOKEN"
  allow="camera; microphone; fullscreen; display-capture; autoplay"
  style="width:100%;height:600px;border:0;border-radius:12px"
  allowfullscreen
></iframe>
```

### 2b. One-line loader script

Prefer not to hand-write the iframe? Add a container and the loader script, and the embed mounts itself:

```html
<div data-neo-meeting data-token="GUEST_JOIN_TOKEN" data-height="600px"></div>
<script src="https://www.neoconference.app/embed.js" async></script>
```

Supported container attributes: `data-token` (required), `data-height`, `data-url` (custom LiveKit server), and `data-base` (custom embed origin). For single-page apps, call `window.NeoConference.mountEmbeds()` after inserting new containers.

### Security notes

- Mint tokens **server-side**, one per user, right before rendering. Never expose your `nc_live_...` API key in client code.
- Join tokens are scoped to a single meeting and expire, so treat each embed URL as a short-lived, per-user credential rather than a static link.

## Groups, notifications and scheduler (app routes)

These routes serve the NeoConference web and mobile apps, under `/api/...`. They use the signed-in Clerk session, not an `nc_live_` key. Errors are `{ "error": "<code>" }`. For group routes: 401 means signed out; 404 means the group doesn't exist or you aren't in it; 403 means your role is too low.

Group roles, highest first: **Owner > Host > Moderator > Member**. The "Permission" column names the role that permission needs.

### Groups

| Method | Path | Permission | Body / query | Response |
| --- | --- | --- | --- | --- |
| GET | /api/groups | signed in | — | `{ groups: [{ …group, role, memberCount }] }` |
| POST | /api/groups | signed in (host+ on `fromEventId`) | `{ name, description?, iconUrl?, fromEventId?, memberUserIds? }` | 201 `{ ok, group }` |
| GET | /api/groups/{id} | group:read (Member) | — | `{ group, members, activity, me, capabilities, nextMeeting }` |
| PATCH | /api/groups/{id} | group:settings (Owner) | `{ name?, description?, iconUrl?, settings?: { retryIntervalMin, maxAttempts } }` | `{ ok, group }` |
| DELETE | /api/groups/{id} | group:delete (Owner) | `{ confirmName }` | `{ ok }` |
| POST | /api/groups/{id}/members | group:members:manage (Moderator) | `{ emails?, userIds? }` | `{ ok, added, alreadyMembers, notFound }` |
| PATCH | /api/groups/{id}/members | Host (Owner for `role: "owner"`) | `{ userId, role }` | `{ ok, member }` |
| DELETE | /api/groups/{id}/members?userId= | group:members:manage; none = leave | — | `{ ok, removed }` / `{ ok, left }` |
| POST | /api/groups/{id}/invite | group:members:manage | — | `{ ok, token, url, expiresAt }` (72 h) |
| GET | /api/groups/invite/{token} | public | — | `{ invite, group, signedIn, alreadyMember }`; 410 when expired |
| POST | /api/groups/invite/{token} | signed in | — | `{ ok, groupId, role, alreadyMember }` |
| GET | /api/events/{id}/attendees | host+ on the event | — | `{ event, attendees, guests }` |

### Group meetings

| Method | Path | Permission | Body / query | Response |
| --- | --- | --- | --- | --- |
| GET | /api/groups/{id}/meetings?scope=upcoming\|past&cursor= | group:read | — | `{ items, nextCursor }` |
| POST | /api/groups/{id}/meetings | group:schedule / group:start (Moderator) | `{ mode: "scheduled"\|"now", title, description?, scheduledAt?, durationMin?, timezone?, password?, waitingRoom?, extraEmails?, recurrence? }` | 201 `{ ok, slug, eventUrl, roomUrl, events, notified }` |
| PATCH | /api/groups/{id}/meetings/{eid} | group:schedule | `{ scope: "this"\|"following", title?, description?, scheduledAt?, durationMin?, password?, waitingRoom? }` | `{ ok, updated, notified }` |
| DELETE | /api/groups/{id}/meetings/{eid}?scope= | group:schedule | — | `{ ok, cancelled, notified }` |
| POST | /api/groups/{id}/calls | group:call (Moderator) | `{ userIds, title? }` | 201 `{ ok, slug, eventUrl, roomUrl, notified }` |
| GET | /api/events/{id}/participants | group:read | — | `{ eventId, groupId, kind, canAdd, candidates }` |
| POST | /api/events/{id}/participants | group:participants:manage (Moderator) | `{ userIds?, emails? }` | `{ ok, added, notified }`; 409 unless live/scheduled |
| POST | /api/events/{id}/call-response | invited | `{ action: "answer"\|"decline", ringId? }` | `{ ok, status, roomUrl? }` |
| POST | /api/events/{id}/ring | group:participants:manage | `{ userIds }` | `{ ok, rung, busy }` |
| GET | /api/events/{id}/calls | group:participants:manage | — | `{ eventId, maxAttempts, people }` |

### Reports

| Method | Path | Permission | Body / query | Response |
| --- | --- | --- | --- | --- |
| GET | /api/groups/{id}/reports?cursor=&from=&to= | group:reports:view (Moderator) | dates `YYYY-MM-DD` | `{ items, nextCursor }` |
| GET | /api/groups/{id}/reports/{eid} | group:reports:view | `?format=xlsx` needs group:reports:export (Host) | `{ report }` or XLSX |
| GET | /api/groups/{id}/reports/export?from=&to= | group:reports:export | dates `YYYY-MM-DD` | XLSX |
| GET | /api/me/meetings?cursor= | signed in | — | `{ items, nextCursor }` (own rows only) |
| GET | /api/me/meetings/{eid} | signed in | — | `{ meeting }` (own row only) |

### Group chat

| Method | Path | Permission | Body / query | Response |
| --- | --- | --- | --- | --- |
| GET | /api/groups/{id}/messages?sinceVer=&before= | group:read | — | `{ unchanged, ver }` or `{ ver, messages, hasOlder, live }` |
| POST | /api/groups/{id}/messages | group:read | `{ text, replyToId?, attachments? }` | 201 `{ ok, message }`; 429 over 10 per 10 s |
| DELETE | /api/groups/{id}/messages/{mid} | own message, or group:members:manage | — | `{ ok, message }` |
| POST | /api/groups/{id}/messages/read | group:read | — | `{ ok }` |
| POST | /api/groups/{id}/upload | group:read | multipart `file` (≤ 10 MB) | `{ ok, attachment }` |

### Notifications and presence

| Method | Path | Permission | Body / query | Response |
| --- | --- | --- | --- | --- |
| POST | /api/push/subscribe | signed in | `{ subscription }` | `{ ok, device, evicted }`; 503 without VAPID keys |
| DELETE | /api/push/subscribe | signed in | `{ endpoint }` | `{ ok, removed }` |
| GET | /api/push/status?endpoint= | signed in | — | `{ configured, devices, thisDevice }` |
| GET | /api/me/notifications?cursor= | signed in | — | `{ items, unread, nextCursor }` |
| PATCH | /api/me/notifications | signed in | `{ ids }` or `{ all: true }` | `{ ok, unread }` |
| POST | /api/me/presence | signed in | `{ eventSlug }` | `{ ok }` (90 s) |
| DELETE | /api/me/presence | signed in | — | `{ ok }` |

### Internal

| Method | Path | Auth | Response |
| --- | --- | --- | --- |
| POST, GET | /api/internal/dispatch | `Authorization: Bearer <DISPATCH_SECRET>` (or `CRON_SECRET`) | `{ ran, skipped, errors, chat?, locked? }`; 401 otherwise |
