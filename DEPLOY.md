# DEPLOY.md

Production deployment runbook for **NeoConference**.

Live: https://neoconference.vercel.app

---

## 1. Architecture summary

- **App framework:** Next.js (App Router) deployed on Vercel.
- **Auth:** Clerk (email + Google SSO) plus a custom KingsChat OAuth flow at `/api/auth/kingschat/start` and `/api/auth/kingschat/callback`. KingsChat does **not** use Clerk SSO connections.
- **Realtime media:** LiveKit Cloud (rooms, recording/egress).
- **Object storage:** S3-compatible bucket (R2) for recordings and assets.
- **KV / cache:** Upstash Redis (rate limiting, ephemeral state).
- **Payments / redemption:** ESPEES integration + a Vercel Cron at 14:00 UTC daily (see `vercel.json`).
- **Observability:** `/api/health`, Vercel Speed Insights (`<SpeedInsights />` in `src/app/layout.tsx`).

## 2. Required environment variables

See `.env.local.example` for the canonical list. Set these in Vercel **Project Settings → Environment Variables** for `Production`, `Preview`, and `Development` as appropriate.

Groups:

- **Clerk:** `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, sign-in/sign-up URLs.
- **LiveKit:** `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `NEXT_PUBLIC_LIVEKIT_URL`.
- **S3 / R2:** `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_PUBLIC_BASE_URL`.
- **Upstash Redis:** `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`.
- **KingsChat:** `KINGSCHAT_CLIENT_ID`, `KINGSCHAT_CLIENT_SECRET`, `KINGSCHAT_REDIRECT_URI`.
- **ESPEES:** `ESPEES_API_KEY`, `ESPEES_API_BASE_URL`, plus webhook secret if applicable.
- **Bootstrap:** `BOOTSTRAP_ADMIN_EMAILS` (comma-separated list seeded at first sign-in).

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
2. Confirm `KINGSCHAT_CLIENT_ID`, `KINGSCHAT_CLIENT_SECRET`, and `KINGSCHAT_REDIRECT_URI` in Vercel match the portal.
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
- Confirm `S3_PUBLIC_BASE_URL` is the public CDN/base URL, not the API endpoint.

## 7. Vercel project hygiene

- **Speed Insights:** enabled. Component mounted in `src/app/layout.tsx`.
- **Spend Management:** set a monthly cap in Vercel → Team → Billing → Spend Management to avoid runaway charges from Speed Insights data points or function invocations.
- **Cron:** `vercel.json` declares a daily cron at 14:00 UTC for ESPEES redemption. Verify it appears in Vercel → Project → Cron Jobs after deploy.
- **Build:** `next build` via Vercel default. ESLint + TS errors are skipped during build (`next.config.mjs`); fix them locally before pushing.

## 8. Health checks & smoke tests

After every production deploy, verify:

1. `GET https://neoconference.vercel.app/api/health` → `{ "status": "ok", ... }` with all services reporting `configured: true`.
2. Sign in with email (Clerk) succeeds.
3. Sign in with Google (Clerk SSO) succeeds.
4. Sign in with KingsChat succeeds and lands the user signed-in.
5. Create a room, join from a second browser, confirm media flows.
6. Start and stop a recording; confirm the egress completes and the artifact appears in the S3 bucket.
7. Check `/admin` (or equivalent) loads for an email in `BOOTSTRAP_ADMIN_EMAILS`.

## 9. Rollback

- In Vercel → Deployments, find the last known-good production deployment and click **Promote to Production**.
- Env var changes are versioned per environment; revert by editing the variable and redeploying.
- Database / KV state is not rolled back automatically — be cautious with destructive migrations.

## 10. Incident playbook (quick)

- **Sign-in broken:** check Clerk status, verify keys match the active instance, check `/api/health`.
- **No video / can't join room:** check LiveKit Cloud dashboard, verify `NEXT_PUBLIC_LIVEKIT_URL` and API key/secret.
- **Recordings missing:** check LiveKit Egress events, check S3 bucket permissions and CORS, check `S3_*` env vars.
- **5xx spike:** check Vercel Logs, then `/api/health`, then upstream provider status pages.

---

_Last updated: 2026-05-10._
