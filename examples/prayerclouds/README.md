# PrayerClouds adapter (sample)

This is what PrayerClouds adds so that `https://herald.prayerclouds.org/zone/FALF` shows the FALF meeting from NeoLinguaMeet, with each signed-in visitor joining under their own name. It is a sample: the PrayerClouds code itself is not in this repository. Copy these pieces into their site.

The full contract is in [`docs/integrations/partner-zones.md`](../../docs/integrations/partner-zones.md).

## What you need from NeoLinguaMeet

- A **secret key** (`nlm_pk_…`), from an administrator: Admin > Integrations > Partner zones. Keep it in your server's environment as `NLM_PARTNER_KEY`, and never put it in a web page or the browser.
- Your website's origin approved on that integration, for example `https://herald.prayerclouds.org`. Add `http://localhost:4000` too while you try this sample.

## The two pieces

1. **A session endpoint on your server**: `POST /api/prayer-meeting/session?zone=FALF`.
   - It checks who is signed in on your site, using your own login.
   - It calls NeoLinguaMeet's `POST /api/partner/v1/join-sessions` with the key, the zone, your page's origin, and the user's id and name.
   - It answers `{ "code": "…" }`.
   - Two versions are here: [`server.mjs`](server.mjs) (Node 18+, no dependencies) and [`session.php`](session.php). In each, replace `current_user()` / `currentUser()` with your session lookup.
2. **The zone page**: `/zone/:zone`, with the widget:
   ```html
   <div id="meeting"></div>
   <script src="https://neolinguameet.com/widget/v1.js"></script>
   <script>
     NeoLinguaMeetWidget.mount({ container: "#meeting", sessionEndpoint: "/api/prayer-meeting/session?zone=FALF", height: 640 })
       .on("error", (e) => console.warn(e.code, e.message));
   </script>
   ```
   Take the zone from your own route (`/zone/:id`). `server.mjs` shows a complete page, with sign-in state, the optional guest form and every event.

## Try it

```bash
NLM_PARTNER_KEY=nlm_pk_... SITE_ORIGIN=http://localhost:4000 node examples/prayerclouds/server.mjs
```

1. In one browser, open http://localhost:4000/demo-login?name=Grace, which lands on `/zone/FALF`.
2. In another browser, open http://localhost:4000/demo-login?id=pc_2&name=Ben.
3. Both join the same FALF meeting, each under their own name.
4. `/zone/LAGOS-1` is a different meeting.

`/demo-login` sets a demo cookie so the sample runs on its own. Your site uses its real login instead.

To admit visitors without an account, set `ALLOW_GUESTS=1` here and switch on **Allow guests** for the integration. The page then asks for a name, and guests are shown as "(guest)".

## Rules worth knowing

- **Identity**: send your stable user id. The same id is the same participant, so a reload or second tab replaces the old connection instead of duplicating it.
- **Roles**: everyone joins as a participant. The zone's host is the meeting owner's NeoLinguaMeet account; it can't be set from your site.
- **Codes**: a code lasts two minutes and works once. The widget asks for a new one whenever it needs it, so don't cache codes.
- **Origins**: your `SITE_ORIGIN` must be exactly the origin your visitors see (scheme, host, port), and it must be approved. Otherwise the meeting refuses the code.
