# NeoConference → NeoLinguaMeet

The site and app become **NeoLinguaMeet** at **https://neolinguameet.com**.
`www.neolinguameet.com` and the old `neoconference.app` redirect there.
Accounts, meetings, recordings, plans and settings stay as they are: they
live in Clerk, KV and R2, and none of them is keyed on the domain.

One setting switches the website: `NEXT_PUBLIC_PRIMARY_DOMAIN=neolinguameet.com`
(`src/lib/brand.ts`). Until it is set, the site behaves exactly as before.

## What never moves

- **KingsChat identities.** `kc-<id>@kc.neoconference.app` is a KingsChat
  account's identity in Clerk (`src/lib/kc-signin.ts`). Changing it makes
  new, empty accounts.
- **The Android package.** `app.neoconference` and the signing key stay, so
  the renamed app installs as an update.
- **What the old domain keeps serving.** `neoconference.app` serves
  `/api/*`, `/.well-known/*` and `/app/*` itself and never redirects them:
  - installed apps call its API and sign in through `/app/auth`;
  - Android verifies App Links there;
  - LiveKit, Resend, Stripe and the scheduler post webhooks there.

  Only ordinary pages redirect (308, path and query kept).
- **The old domain itself.** Keep `neoconference.app` registered, renewed
  (next renewal is due 2027-10-15) and on Vercel's DNS. It also carries
  `translate.neoconference.app` for the translation worker.

## Order

| Step | Who | What |
|---|---|---|
| 1 | Claude | Website code behind the switch. Merged with the switch off, so nothing changes on the live site. |
| 2 | Claude, then the owner | App 1.2.6 "NeoLinguaMeet": same package, opens links for both domains, reads the Clerk address from the server. The owner uploads it to the LW AppStore. |
| 3 | Owner | The account steps below. Everything in them works before the switch. |
| 4 | Claude | Raise the app minimum to 1.2.6 (`APP_MIN_VERSION`). Then wait until most people have updated (attendance `client` counts). |
| 5 | Owner, with Claude | Switch-over: change the Clerk domain, update the Vercel settings, redeploy, then Claude verifies. |

**Step 5 is the only one that is hard to undo.** Clerk's domain change issues
a new publishable key. Apps up to 1.2.5 have `clerk.neoconference.app`
built in, so assume their sign-in stops working at that moment.

## Owner's account steps (step 3)

### DNS for neolinguameet.com (at its registrar)

1. Add both domains in Vercel first: Project → Settings → Domains.
   - Add `neolinguameet.com`. This is the primary; leave it unassigned to any
     redirect.
   - Add `www.neolinguameet.com`. Vercel offers to redirect it to the
     primary: accept (308). The site also redirects it itself.
2. Create the records Vercel shows for each domain:
   - The bare domain gets an `A` record, usually `76.76.21.21`.
   - `www` gets a `CNAME`, usually `cname.vercel-dns.com`.
   - Remove the current `www` record pointing at 104.219.250.36.
3. Vercel issues the TLS certificates once DNS resolves. Wait for "Valid
   Configuration" on both.

`neoconference.app` and `www.neoconference.app` stay in the project exactly
as they are. **Do not** set them to redirect in Vercel: the code redirects
pages and keeps `/api`, `/.well-known` and `/app` working.

### Email (Resend): info@neolinguameet.com

1. In Resend, go to Domains, add `neolinguameet.com`, and create the DNS
   records it lists (SPF, DKIM, and optionally MX for bounces).
2. Once it is verified, set `MAIL_FROM` in Vercel (step 5) to
   `NeoLinguaMeet <info@neolinguameet.com>`.
3. In Resend's Webhooks, the endpoint can stay at
   `https://www.neoconference.app/api/comms/resend-webhook`, because the old
   domain keeps `/api`. Optionally move it to
   `https://neolinguameet.com/api/comms/resend-webhook`.
4. Make sure the `info@neolinguameet.com` mailbox receives mail. Support
   links point at it after the switch.

### KingsChat (developer console)

Add `https://neolinguameet.com/api/auth/kingschat/callback` as an allowed
redirect URI. Keep the old one: the old domain still handles sign-ins started
there and from the app. If `KINGSCHAT_REDIRECT_URI` is set in Vercel, note
its value; it changes in step 5.

### NeoEmail (OAuth client)

Add `https://neolinguameet.com/api/auth/neoemail/callback` as a redirect URI,
and keep the old one. The same note applies to `NEOEMAIL_REDIRECT_URI`.

### Webhooks: optional, the old ones keep working

- **LiveKit Cloud** (Settings → Webhooks):
  `https://neolinguameet.com/api/livekit/webhook`
- **Stripe** (Developers → Webhooks):
  `https://neolinguameet.com/api/stripe/webhook`. Its signing secret
  changes, so update `STRIPE_WEBHOOK_SECRET` if you add a new endpoint.
- **Scheduler worker:** `DISPATCH_URL=https://neolinguameet.com/api/internal/dispatch`
- **Espees:** nothing to do. Its return addresses are built from the domain
  the payment started on.

### Cloudflare R2

Downloads use signed links, which need no CORS. If the bucket has a CORS
rule naming `neoconference.app` (for the in-page players), add
`https://neolinguameet.com` to it.

### LoveWorld AppStore

Update the listing:
- name: **NeoLinguaMeet**;
- icon: `public/brand/neolinguameet/icon-512.png`;
- release notes: see the app release.

### Google Search Console (optional)

Add `neolinguameet.com` and use **Change of address** from the old property.

## Switch-over (step 5)

1. **Clerk:** Dashboard → Domains → Danger → Change domain → `neolinguameet.com`.
   - Create the DNS records Clerk then lists at the registrar (`clerk.`,
     `accounts.`, `clkmail.` and the two DKIM CNAMEs).
   - Wait for Clerk to show them verified.
   - Copy the new **publishable key**. The secret key stays the same unless
     Clerk says otherwise.
2. **Vercel → Settings → Environment Variables (Production):**
   - `NEXT_PUBLIC_PRIMARY_DOMAIN` = `neolinguameet.com`
   - `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` = the new key
   - `NEXT_PUBLIC_SITE_URL` = `https://neolinguameet.com`. The code already
     ignores the old value, so this is for tidiness.
   - `MAIL_FROM` = `NeoLinguaMeet <info@neolinguameet.com>`
   - `KINGSCHAT_REDIRECT_URI` / `NEOEMAIL_REDIRECT_URI`, if set: the new
     callback URLs above.
3. **Redeploy production.** `NEXT_PUBLIC_*` values are built in, so a
   redeploy is required.
4. **Claude verifies:**
   - both domains are on HTTPS;
   - old URLs redirect with path and query;
   - `/api` and `/.well-known` on the old domain are not redirected;
   - meeting links open the same rooms;
   - sign-in, sign-up, password reset and KingsChat work;
   - joining, hosting and moderating work, with audio, video, screen
     share, chat and translation;
   - webhooks still arrive;
   - app 1.2.6 signs in;
   - no page shows the old name.

### What people notice

- **Everyone signs in once on neolinguameet.com.** Browsers keep sign-ins
  per domain. Accounts and everything in them are unchanged.
- **Website added to the home screen (PWA):** the old icon opens
  neoconference.app, which forwards to the new site. To get the new name and
  icon there, remove it and add it again from neolinguameet.com. Call alerts
  on an iPhone need that, plus turning alerts on again.
- **App 1.2.6** updates in place. On first open after the switch, sign in
  once.

## Rollback

- **Website:**
  1. Remove `NEXT_PUBLIC_PRIMARY_DOMAIN` (or set it to `neoconference.app`).
  2. Restore the previous `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, but only if
     Clerk is changed back too.
  3. Redeploy. The redirects stop and the old name returns.
- **Clerk:** change the domain back to `neoconference.app` in the same
  Danger tab. It issues another key, and everyone signs in again. Avoid this
  by doing step 5 only after the checks in step 3 pass.
- **DNS:** the new domain's records can stay. With the switch off, the new
  domain just serves the site.
