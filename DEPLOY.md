# DEPLOY.md

Production deployment runbook for **NeoConference**.

Live: https://neoconference.vercel.app

---

## 1. Architecture summary

- **App framework:** Next.js (App Router) deployed on Vercel.
- **Auth:** Clerk (email + Google SSO) plus a custom KingsChat OAuth flow at `/api/auth/kingschat/start` and `/api/auth/kingschat/callback`. KingsChat does **not** use Clerk SSO connections.
- **Realtime media:** LiveKit Cloud (rooms, recording/egress).
- **Object storage:** S3-compatible bucket (Cloudflare R2 / AWS S3) for recordings and assets.
- **KV / cache:** Vercel KV / Upstash Redis (sessions, rate limiting, ephemeral state).
- **Payments / redemption:** ESPEES integration + a Vercel Cron at 14:00 UTC daily (see `vercel.json`).
- **Observability:** `/api/health`, Vercel Speed Insights (`<SpeedInsights />` in `src/app/layout.tsx`).

## 2. Required environment variables

See `.env.local.example` for the canonical list. Set these in Vercel **Project Settings → Environment Variables** for `Production`, `Preview`, and `Development` as appropriate.

Groups:

- **Clerk:** `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, plus optional `NEXT_PUBLIC_CLERK_SIGN_IN_URL` / `SIGN_UP_URL` / `AFTER_SIGN_IN_URL` / `AFTER_SIGN_UP_URL`.
- **LiveKit:** `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `NEXT_PUBLIC_LIVEKIT_URL`.
- **S3 / R2:** `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`.
- **Vercel KV / Upstash Redis:** `KV_REST_API_URL`, `KV_REST_API_TOKEN`, plus `KV_URL` / `REDIS_URL` / `KV_REST_API_READ_ONLY_TOKEN` (auto-injected by the Vercel KV integration).
- **KingsChat:** `KINGSCHAT_CLIENT_ID`, `KINGSCHAT_REDIRECT_URI`, `KINGSCHAT_STATE_SECRET` (long random string used to sign OAuth state).
- **ESPEES:** `ESPEES_MERCHANT_WALLET` (plus any future webhook secret).
- **Bootstrap:** `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_BUSINESS_EMAIL` (seeded on first deploy).

## 3. Going from Clerk Development → Production

Clerk is currently on the **Development** instance. Cutover steps:

1. In the Clerk dashboard, create or activate the **Production** instance for the `NeoConference` app.
2. Add the production domain (`neoconference.vercel.app` and any custom domain) to **Domains**.
3. Configure social connections you actually use (Google) with **your own OAuth credentials** — Clerk's shared dev credentials do not work in production.
4. Copy the new **Publishable Key** and **Secret Key** from the production instance.
5. In Vercel → Project → Settings → Environment Variables, replace `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` for the **Production** environment.
6. Redeploy production. Verify sign-in works end-to-end.
7. Optional cleanup: rotate any keys that were ever pasted in chats or screenshots.

## 4. KingsChat production cutover

1. In the KingsChat developer portal, ensure the redirect URI matches production exactly: `https://neoconference.vercel.app/api/auth/kingschat/callback` (and any custom domain).
2. Confirm `KINGSCHAT_CLIENT_ID`, `KINGSCHAT_REDIRECT_URI`, and `KINGSCHAT_STATE_SECRET` are set in Vercel for the Production environment.
3. The OAuth scope is hardcoded as `send_chat_message` in `src/app/api/auth/kingschat/start/route.ts`. Add more scopes there if/when needed.
4. Smoke test: hit `/api/auth/kingschat/start`, complete the flow, confirm a Clerk user is minted on callback.

## 5. LiveKit

- Project: `neoconference-dev` on LiveKit Cloud.
- For production, create a separate `neoconference-prod` project so dev egress/recording cannot collide with production.
- Update `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `NEXT_PUBLIC_LIVEKIT_URL` in Vercel Production env to point at the new project.
- Egresses with no events captured and very short duration are typically client-side aborts (closed tab, cancelled record); they are safe to ignore.

## 6. Storage (S3 / R2)

- Use a dedicated production bucket. Enable lifecycle rules for old recordings if cost is a concern.
- CORS: allow `https://neoconference.vercel.app` for `GET`, `PUT`, and `HEAD` if the client uploads directly.
- Confirm `S3_ENDPOINT` is the API endpoint (e.g. `https://<accountid>.r2.cloudflarestorage.com`) and that `S3_BUCKET` / `S3_REGION` match the bucket you created.

## 7. Vercel project hygiene

- **Speed Insights:** enabled. Component mounted in `src/app/layout.tsx`.
- **Spend Management:** set a monthly cap in Vercel → Team → Billing → Spend Management to avoid runaway charges from Speed Insights data points or function invocations.
- **Cron:** `vercel.json` declares a daily cron at 14:00 UTC for ESPEES redemption. Verify it appears in Vercel → Project → Cron Jobs after deploy.
- **Build:** `next build` via Vercel default. ESLint + TS errors are skipped during build (`next.config.mjs`); fix them locally before pushing.

## 8. Health checks & smoke tests

After every production deploy, verify:

1. `GET https://neoconference.vercel.app/api/health` → `{ "status": "ok", ... }` with `services.clerk`, `services.livekit`, `services.storage`, and `services.kv` all reporting `"ok"`.
2. Sign in with email (Clerk) succeeds.
3. Sign in with Google (Clerk SSO) succeeds.
4. Sign in with KingsChat succeeds and lands the user signed-in.
5. Create a room, join from a second browser, confirm media flows.
6. Start and stop a recording; confirm the egress completes and the artifact appears in the S3 bucket.
7. Check `/admin` (or equivalent) loads for the email in `BOOTSTRAP_ADMIN_EMAIL`.

## 9. Rollback

- In Vercel → Deployments, find the last known-good production deployment and click **Promote to Production**.
- Env var changes are versioned per environment; revert by editing the variable and redeploying.
- KV / storage state is not rolled back automatically — be cautious with destructive migrations.

## 10. Incident playbook (quick)

- **Sign-in broken:** check Clerk status, verify keys match the active instance, check `/api/health`.
- **No video / can't join room:** check LiveKit Cloud dashboard, verify `NEXT_PUBLIC_LIVEKIT_URL` and API key/secret.
- **Recordings missing:** check LiveKit Egress events, check S3 bucket permissions and CORS, check `S3_*` env vars.
- **5xx spike:** check Vercel Logs, then `/api/health`, then upstream provider status pages.

---

_Last updated: 2026-05-10._
