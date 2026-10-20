# Partner zones: a meeting per zone on a partner's website

A partner website embeds NeoLinguaMeet so that each of its zones has one meeting. PrayerClouds is the first: `herald.prayerclouds.org/zone/FALF` shows the FALF meeting. Every visitor joins that meeting under their own name, with the usual meeting, live captions and translation. Visitors never see a NeoLinguaMeet sign-in.

Code: `src/lib/partners/` (store, join, protocol, embed session), `src/app/api/partner/`, `src/app/embed/zone/`, `public/widget/v1.js`. Admin: `src/app/api/admin/partners/` and Admin > Integrations > Partner zones. Sample partner side: `examples/prayerclouds/`.

## How it fits together

```
 visitor's browser                         partner's server                NeoLinguaMeet
 ─────────────────                         ────────────────                ─────────────
 /zone/FALF (partner page)
   loads /widget/v1.js ──────────────────────────────────────────────────▶ (static script)
   widget makes <iframe src=/embed/zone> ────────────────────────────────▶ page, framed only by
                                                                            approved origins (CSP)
   iframe ── request-session ─▶ widget
   widget ── POST /api/prayer-meeting/session ─▶ checks its own login
                                             ── POST /api/partner/v1/join-sessions ─▶ key → integration
                                                Bearer nlm_pk_…                       zone → meeting (made once)
                                             ◀─ { code } (2 min, 1 use, bound to origin)
   widget ◀─ { code }
   widget ── session {code} ─▶ iframe (postMessage to the exact NeoLinguaMeet origin)
   iframe ── POST /api/partner/embed/redeem { code, parentOrigin: event.origin } ───▶ origin must match
         ◀─ signed meeting session (2 h, memory only)
   iframe ── prejoin (devices) ── POST /api/partner/embed/join ──────────▶ lock, cap, waiting room,
         ◀─ LiveKit participant token                                      wait-for-host
   iframe ── LiveKit ──▶ the zone's meeting
```

Who someone is comes only from the partner's server, which calls with its secret key. Nothing in the browser can change the name, the user id or the role. The browser cannot pick the meeting either. Everyone joins as a participant.

## Setting up a partner (administrator)

1. Admin > Integrations > **Partner zones** > **Add a partner website**:
   - **Name**: for example PrayerClouds.
   - **Owner**: the email of an existing account. Zone meetings belong to it, and its plan sets their limits: participant cap and translation (Pro and above).
   - **Websites allowed to embed it**: one origin per line, for example `https://herald.prayerclouds.org`. Use https; http is allowed only for localhost. A pasted page address keeps only its origin.
   - **Meeting title**: for example `{zone} Prayer Meeting`.
   - **Make a zone's meeting on its first visit**: on by default. Off means an administrator connects each zone.
   - **Allow guests**: off by default. Guests join by name only and are shown as "(guest)".
2. Copy the **secret key** when it is shown. It is shown once only. Hand it to the partner's developers over a safe channel; it belongs in their server's environment.
3. Give them `examples/prayerclouds/` and this document.

Managing a partner later:
- Edit any setting, or disable the partner. Disabling stops new codes, and pages already open cannot join.
- Make a new key. Old keys keep working until revoked, so the partner can switch over first. Revoke the old key afterwards.
- Zones:
  - switch a zone off or on;
  - give a zone's meeting to another account;
  - connect a zone to an existing meeting by its address.
- Read the partner's history.

Every change needs a fresh two-factor code and is written to the admin audit log. Keys only ever appear there masked.

## The partner's server: `POST /api/partner/v1/join-sessions`

Call it from your server only, once per visitor and visit, right before showing the widget. The widget calls your endpoint, and your endpoint calls this one.

```http
POST https://neolinguameet.com/api/partner/v1/join-sessions
Authorization: Bearer nlm_pk_…
Content-Type: application/json

{
  "zoneId": "FALF",
  "origin": "https://herald.prayerclouds.org",
  "user": { "id": "u_123", "displayName": "Grace Okafor" }
}
```

- `zoneId`: letters, digits, `-` and `_`, up to 40 characters. Case does not matter: `falf` and `FALF` are the same zone.
- `origin`: the origin of the page the widget runs on. It must be one of the approved websites.
- `user.id`: your stable id for this person, `[A-Za-z0-9_.:@|+=-]`, up to 128. The same id is always the same participant: a reload or second tab replaces the old connection instead of adding a duplicate.
- `user.displayName`: 1–60 characters. Control and direction-override characters are removed.
- Guests (only if the integration allows them): `"user": { "guest": true, "displayName": "Grace" }`, optionally with your own `id` for the visit.

`201`:
```json
{
  "code": "nlm_jc_…",
  "expiresAt": "2026-10-20T18:02:00.000Z",
  "meeting": { "zoneId": "FALF", "title": "FALF Prayer Meeting" },
  "embed": { "page": "https://neolinguameet.com/embed/zone", "sdk": "https://neolinguameet.com/widget/v1.js" }
}
```

The code lasts two minutes and can be used once, and only from `origin`. Hand it to the widget straight away.

Errors are `{ "error": { "code", "message" } }`:

| Status | code | Meaning |
|---|---|---|
| 400 | `invalid_body`, `invalid_zone`, `invalid_origin`, `invalid_name`, `invalid_user` | The request is malformed. |
| 401 | `invalid_key` | Missing, wrong or revoked key. |
| 403 | `origin_not_approved` | That website is not approved for this integration. |
| 403 | `guests_not_allowed` | A guest was sent, but guests are off. |
| 403 | `integration_disabled` / `zone_disabled` | Switched off by an administrator. |
| 404 | `zone_not_found` | Automatic zones are off and this zone has not been connected. |
| 409 | `zone_slug_taken` | The zone's meeting address belongs to something else. Ask NeoLinguaMeet to connect the zone. |
| 429 | `rate_limited` | Over 600 a minute per key, or 300 a minute per zone. |
| 503 | `zone_create_failed` | Making the zone's meeting failed. Try again. |

## The widget: `/widget/v1.js`

```html
<div id="meeting"></div>
<script src="https://neolinguameet.com/widget/v1.js"></script>
<script>
  const widget = NeoLinguaMeetWidget.mount({
    container: "#meeting",                                     // element or selector
    sessionEndpoint: "/api/prayer-meeting/session?zone=FALF",  // YOUR endpoint
    height: 640,                                               // px or a CSS length; default 600px
    theme: "dark",                                             // "dark" | "light" (screens around the meeting)
    // sessionBody: { displayName: "Grace" },                  // optional JSON body, e.g. a guest's name
  });
  widget.on("joined", () => {});
</script>
```

`sessionEndpoint` is called on your own site with the visitor's cookies, as a POST. It must answer `{ "code": "nlm_jc_…" }`, or an error status with `{ error: { code, message } }`, which the widget passes on as an `error` event. It is called again whenever the meeting needs a new code: after two hours, or when the visitor retries. Never put who the visitor is in its address; send it in `sessionBody` if you must.

**Methods**
- `join()`: join with the visitor's device choices, skipping the prejoin button. Call it after `ready`.
- `leave()`: leave. The frame offers Rejoin.
- `requestFullscreen()`: full screen for the frame. Must be called from a click.
- `on(event, fn)`, `off(event, fn?)`.
- `destroy()`: remove the frame and its listeners.

`widget.iframe` is the element itself. `NeoConferenceWidget` is an alias.

**Events** (each handler receives one object):

| event | fields |
|---|---|
| `ready` | `meeting: { title, zoneId }`, `participant: { name, verified }` |
| `waiting` | `reason`: `waiting_room` or `wait_for_host` |
| `joined` | — |
| `left` | `reason`: `left`, `removed`, `opened_in_tab`, `replaced` (joined elsewhere) or `disconnected` |
| `meeting-ended` | — |
| `permission-denied` | `device`: `camera`, `microphone` or `media` (once per device) |
| `error` | `code`, `message` (and `status` for your endpoint's failures) |

The frame is created with `allow="camera; microphone; fullscreen; display-capture; autoplay; clipboard-write"`. If you write the iframe yourself instead, keep those and follow the protocol below.

Inside the frame, the visitor has:
- a prejoin with camera and microphone choice;
- the meeting itself;
- captions, once the host turns them on;
- live translation into their language;
- full screen;
- **Open in new tab**: the meeting moves to a tab of its own. The code passes by postMessage, never in the address, and the frame steps aside.

The meeting chat is not in the embed yet, because sending to it needs an account.

## postMessage protocol, v1

Every message is `{ nlm: 1, type, …fields }`. Anything else is ignored, so a later version can change shapes safely.

**Parent page to frame**: always posted to the frame's exact origin, never `*`.
- `session { code }`
- `join`
- `leave`

The frame takes `session` only from its own parent window. It sends the code to the server with `event.origin`, the browser's word for who sent it, and the server accepts it only if that is the origin the code was issued for. It takes `join` and `leave` only from that origin after that.

**Frame to parent page**:
- `request-session` asks for a code. It carries nothing, and it is the only message posted to `*`, because at that point the frame does not yet know who framed it.
- Every event above is posted only to the origin the code was redeemed for. An error before that goes only to the origin that sent the code.

The widget accepts messages only from its own frame (`event.source`) and from the NeoLinguaMeet origin it was loaded from.

## Security

**Secrets**
- The partner key is server-side only. Only its SHA-256 is stored, and it is shown once.
- Codes are random (256 bits), hashed at rest, single-use (a set-if-absent claim), last two minutes, and are bound to one origin.
- The meeting session is HMAC-signed with `PARTNER_EMBED_SECRET` and lasts two hours. It lives in the frame's memory only: no cookie, no storage, never in a URL.

**Who may frame or call what**
- `/embed/zone` sends `Content-Security-Policy: frame-ancestors 'self' <approved origins of active integrations>`, read from KV and cached for a minute. If KV can't be read, the header is `'self'` only.
- Every other page is unchanged.

**Who someone is**
- Identity and role come from the partner's server only.
- Each partner user always gets the same LiveKit identity, `pz-<integration>-<hash>`.
- The role is always `attendee`: no partner input can make anyone a host or co-host. The host is the zone owner, who joins through NeoLinguaMeet as usual.

**One partner can't reach another**
- The integration comes from the key, never from the request body.
- Zones belong to one integration: one partner's FALF is not another's.

**Rules a meeting already has still apply**
- Lock, the owner's participant cap, the waiting room (knocks show in the host's usual list) and wait-for-host.

**Translation without an account**
- `/api/translate` and `/api/voice/speak` accept the frame's session in the `x-neo-embed-session` header, for that session's meeting only.
- They are rate limited, and refused once the integration or zone is switched off.

**Rate limits**
- join-sessions: 600 a minute per key, and 300 a minute per zone.
- redeem: 60 a minute per address.
- join: 30 a minute per visitor, and 1200 a minute per address.
- hand-off: 30 a minute per address.
- translate and speak: 120 a minute per embedded visitor.

## Data (Upstash KV)

There is no SQL, so uniqueness uses set-if-absent keys:

| Key | Holds |
|---|---|
| `neo:partner:<id>` | the integration (`pi_<12 hex>`) |
| `neo:partner:all`, `neo:partner:origins` | all integrations; approved origins of active ones (for framing) |
| `neo:partner:<id>:keys`, `neo:partner:keymeta:<keyId>`, `neo:partner:keyhash:<keyId>`, `neo:partner:key:<sha256>` | keys: list, masked metadata, hash, lookup |
| `neo:partner:<id>:zone:<ZONE>` (set NX), `neo:partner:<id>:zones` | zone → meeting mapping; the zone list |
| `neo:partner:code:<sha256>` (expires 2 min), `neo:partner:codeused:<sha256>` (NX) | one-time codes and their use |
| `neo:partner:<id>:audit` | the partner's own history (newest first, 500 kept) |

**One zone, one meeting**
- A zone's meeting has a fixed address per integration and zone: `z-<integration 6>-<zone>`.
- It is created with `createIfSlugFree`, and the mapping with set-if-absent. Concurrent first visits therefore make one meeting; twelve at once are tested.
- The meeting is `unlisted`, `isPermanent`, with no waiting room or wait-for-host by default (the owner can change those), and marked `partner: { integrationId, zoneId }`.

**Lifecycle**
- A zone is one permanent room. When a session ends, the next visitor reopens it.

## Deployment

- Set **`PARTNER_EMBED_SECRET`** in Vercel (Production and Preview): a long random value. Until it is set, sessions are signed with `CLERK_SECRET_KEY`. Changing it ends open embed sessions, and visitors are asked for a new code automatically.
- Nothing else is required. LiveKit, DeepL and Cartesia are the same as for the rest of the site.
- The partner deploys their side (see `examples/prayerclouds/`), and an administrator adds their website.

## Testing

**Automated**
- `npx tsx src/lib/__tests__/partnerZones.smoke.ts`: issue, redeem, join, codes, origins, guests, waiting room, lock, cap, reopen, switches, key rotation, framing and embedded translation.
- `npx tsx src/lib/__tests__/adminPartners.smoke.ts`: the admin routes.
- Both run in `npm run test:smoke`.

**By hand with the sample**
1. Run `examples/prayerclouds/server.mjs` against production. The key comes from an integration whose approved website is `http://localhost:4000`.
2. Open `/demo-login?name=Grace`, then `/zone/FALF`, in one browser.
3. Open `/demo-login?id=pc_2&name=Ben`, then `/zone/FALF`, in another.
4. Both should land in the same meeting under their own names.
