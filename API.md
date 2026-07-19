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
