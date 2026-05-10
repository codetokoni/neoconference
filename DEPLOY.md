# DEPLOY.md

Production deployment runbook for **NeoConference**.

Live: https://www.neoconference.app

> **Status:** Production cutover completed **2026-05-10**. Clerk is on the **Production** instance, KingsChat OAuth is wired to the production callback, and all auth entry points route to dedicated `/sign-in` and `/sign-up` pages (no Clerk modals).

---

## 1. Architecture summary

- **App framework:** Next.js (App Router) deployed on Vercel.
- **Auth:** Clerk (email link + password) plus a custom KingsChat OAuth flow at `/api/auth/kingschat/start` and `/api/auth/kingschat/callback`. KingsChat is **not** a Clerk SSO connection — it is a server-side OAuth flow that mints / merges a Clerk user by email on callback. No Google SSO.
- **Auth entry points:** every "Sign in" / "Get started" / "Create free account" CTA in the app is a `<Link>` to `/sign-in` or `/sign-up`. Clerk's `mode="modal"` is **not** used anywhere, because the modal widget cannot render the KingsChat button. See §11.
- **Realtime media:** LiveKit Cloud (rooms, recording/egress).
- **Object storage:** S3-compatible bucket (Cloudflare R2 / AWS S3) for recordings and assets.
- **KV / cache:** Vercel KV / Upstash Redis (sessions, rate limiting, ephemeral state).
- **Payments / redemption:** ESPEES integration + a Vercel Cron at 14:00 UTC daily (see `vercel.json`).
- **Observability:** `/api/health`, Vercel Speed Insights (`<SpeedInsights />` in `src/app/layout.tsx`).

## 2. Required environment variables

See `.env.local.example` for the canonical list. Set these in Vercel **Project Settings → Environment Variables** for `Production`, `Preview`, and `Development` as appropriate.

Groups:

- **Clerk (production):** `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (`pk_live_…`), `CLERK_SECRET_KEY` (`sk_live_…`), plus optional `NEXT_PUBLIC_CLERK_SIGN_IN_URL` / `SIGN_UP_URL` / `AFTER_SIGN_IN_URL` / `AFTER_SIGN_UP_URL`.
- **LiveKit:** `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `NEXT_PUBLIC_LIVEKIT_URL`.
- **S3 / R2:** `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`.
- **Vercel KV / Upstash Redis:** `KV_REST_API_URL`, `KV_REST_API_TOKEN`, plus `KV_URL` / `REDIS_URL` / `KV_REST_API_READ_ONLY_TOKEN` (auto-injected by the Vercel KV integration).
- **KingsChat:** `KINGSCHAT_CLIENT_ID`, `KINGSCHAT_REDIRECT_URI` (= `https://www.neoconference.app/api/auth/kingschat/callback`), `KINGSCHAT_STATE_SECRET` (long random string used to sign OAuth state).
- **ESPEES:** `ESPEES_MERCHANT_WALLET` (plus any future webhook secret).
- **Bootstrap:** `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_BUSINESS_EMAIL` (seeded on first deploy).

## 3. Clerk Development → Production cutover (completed 2026-05-10)

The cutover from the Clerk Development instance to the Production instance is **complete**. Recorded steps:

1. Created the Clerk **Production** instance for the `NeoConference` app (app `app_3DI2471NceZ34xrrrxGI2tklTB5`, instance `ins_3DXgCr4XDskBMCnuD8koe90mnyH`).
2. Added the apex `neoconference.app` and `www.neoconference.app` as authorized domains. DNS + SSL via Vercel.
3. Configured auth methods: **Email link + Password**. No Google / no other social connections.
4. Replaced `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` in Vercel **Production** with the new `pk_live_…` / `sk_live_…` keys.
5. Updated `authorizedParties` in `src/middleware.ts` to include the apex and `www` host (see merged PR #1).
6. Redeployed production; verified `__client_uat` / `__session` cookies now scope to `neoconference.app`.
7. Verified the previously seeded dev users are gone (Production instance starts empty).

**If you ever rotate Clerk keys:** edit the two env vars in Vercel Production, redeploy, and check `/api/health` reports `services.clerk: "ok"`.

## 4. KingsChat production cutover (completed 2026-05-10)

1. Redirect URI registered in the KingsChat developer portal: `https://www.neoconference.app/api/auth/kingschat/callback`.
2. `KINGSCHAT_CLIENT_ID`, `KINGSCHAT_REDIRECT_URI`, and `KINGSCHAT_STATE_SECRET` are set in Vercel Production.
3. OAuth scope is hardcoded as `send_chat_message` in `src/app/api/auth/kingschat/start/route.ts`. Add more scopes there if/when needed.
4. Flow: `/api/auth/kingschat/start` builds the signed-state URL → user authenticates on `accounts.kingsch.at` → callback verifies state + token server-side and mints (or merges by email) a Clerk user via the Backend API.
5. Smoke-tested 2026-05-10: handshake URL contained correct `client_id`, `scopes`, `post_redirect=true`, and `redirect_uri`.

## 5. LiveKit

- Project: `neoconference-dev` on LiveKit Cloud.
- For production, create a separate `neoconference-prod` project so dev egress/recording cannot collide with production.
- Update `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `NEXT_PUBLIC_LIVEKIT_URL` in Vercel Production env to point at the new project.
- Egresses with no events captured and very short duration are typically client-side aborts (closed tab, cancelled record); they are safe to ignore.

## 6. Storage (S3 / R2)

- Use a dedicated production bucket. Enable lifecycle rules for old recordings if cost is a concern.
- CORS: allow `https://www.neoconference.app` (and `https://neoconference.app`) for `GET`, `PUT`, and `HEAD` if the client uploads directly.
- Confirm `S3_ENDPOINT` is the API endpoint (e.g. `https://<accountid>.r2.cloudflarestorage.com`) and that `S3_BUCKET` / `S3_REGION` match the bucket you created.

## 7. Vercel project hygiene

- **Speed Insights:** enabled. Component mounted in `src/app/layout.tsx`.
- **Spend Management:** set a monthly cap in Vercel → Team → Billing → Spend Management to avoid runaway charges from Speed Insights data points or function invocations.
- **Cron:** `vercel.json` declares a daily cron at 14:00 UTC for ESPEES redemption. Verify it appears in Vercel → Project → Cron Jobs after deploy.
- **Build:** `next build` via Vercel default. ESLint + TS errors are skipped during build (`next.config.mjs`); fix them locally before pushing.
- **Domains:** `www.neoconference.app` is the canonical host; apex `neoconference.app` 308-redirects to `www`. Both are listed as authorized parties in Clerk middleware.

## 8. Health checks & smoke tests

After every production deploy, verify:

1. `GET https://www.neoconference.app/api/health` → `{ "status": "ok", ... }` with `services.clerk`, `services.livekit`, `services.storage`, and `services.kv` all reporting `"ok"`.
2. **All six auth entry points** route to the dedicated pages and the Clerk widget + KingsChat button both render:
   - Header **Sign in** → `/sign-in`
   - Header **Get started** → `/sign-up`
   - Hero **Get started — it's free** → `/sign-up`
   - Hero **Sign in** → `/sign-in`
   - Final-CTA **Create free account** → `/sign-up`
   - Final-CTA **Sign in** → `/sign-in`
3. Email sign-in (Clerk) succeeds.
4. KingsChat sign-in succeeds and lands the user signed-in (Clerk `__session` cookie set).
5. Invite gate `/i/<token>` for an unauthenticated user shows the **Sign in to RSVP** button which routes to `/sign-in?redirect_url=/i/<token>` (preserves invite round-trip).
6. Create a room, join from a second browser, confirm media flows.
7. Start and stop a recording; confirm the egress completes and the artifact appears in the S3 bucket.
8. Check `/admin` (or equivalent) loads for the email in `BOOTSTRAP_ADMIN_EMAIL`.

## 9. Rollback

- In Vercel → Deployments, find the last known-good production deployment and click **Promote to Production**.
- Env var changes are versioned per environment; revert by editing the variable and redeploying.
- KV / storage state is not rolled back automatically — be cautious with destructive migrations.

## 10. Incident playbook (quick)

- **Sign-in broken:** check Clerk status, verify keys match the active instance, check `/api/health`.
- **KingsChat button missing on a new auth entry point:** likely a regression to a Clerk modal — see §11. The fix is to route the entry point through `/sign-in` or `/sign-up` instead.
- **No video / can't join room:** check LiveKit Cloud dashboard, verify `NEXT_PUBLIC_LIVEKIT_URL` and API key/secret.
- **Recordings missing:** check LiveKit Egress events, check S3 bucket permissions and CORS, check `S3_*` env vars.
- **5xx spike:** check Vercel Logs, then `/api/health`, then upstream provider status pages.

## 11. Auth entry-point architecture (KingsChat parity)

**Decision:** every CTA that opens authentication is a Next.js `<Link>` to `/sign-in` or `/sign-up` — never a Clerk `<SignInButton mode="modal">` or `<SignUpButton mode="modal">`.

**Why:** Clerk's modal widget only renders the Clerk-managed methods (email/password/SSO connections). Our KingsChat button lives **outside** the Clerk widget on the `/sign-in` and `/sign-up` pages, so users entering through a modal would never see it. Routing every entry point through the dedicated pages guarantees KingsChat parity everywhere.

**Files involved:**
- `src/app/layout.tsx` — header **Sign in** / **Get started** links.
- `src/app/page.tsx` — hero CTAs + final-CTA CTAs.
- `src/app/i/[token]/page.tsx` — invite gate uses `<Link href="/sign-in?redirect_url=/i/${token}">` to preserve round-trip.
- `src/app/sign-in/[[...sign-in]]/page.tsx` — Clerk `<SignIn />` + KingsChat button + `kc_error` banner.
- `src/app/sign-up/[[...sign-up]]/page.tsx` — Clerk `<SignUp />` + KingsChat button + `kc_error` banner (mirrors sign-in).

**Adding a new auth CTA:** import `Link` from `next/link` and render `<Link href="/sign-in">…</Link>` or `<Link href="/sign-up">…</Link>`. Do **not** import `SignInButton` / `SignUpButton` from `@clerk/nextjs`.

---

_Last updated: 2026-05-10 (post-cutover; auth entry points unified)._
