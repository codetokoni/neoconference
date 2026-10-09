# Plans, coupons and subscriptions (admin)

What `/admin/plans` and `/admin/subscriptions` do, and the rules behind them. The code is in `src/lib/billing/` (`model.ts` is the pure part, `store.ts` the catalog in KV, `subscriptions.ts` the per-account records).

## Plan ids and the `Plan` type

- The five tiers (`free`, `starter`, `pro`, `business`, `enterprise`) are plans in the catalog under their own ids. Until someone edits one, it reads as its built-in **version 1**: the limits in `getPlanLimits` and the prices in `ESPEES_AMOUNTS`, which is what the app enforced and charged before the catalog.
- A plan made in the admin has its own id and **names a base tier** (Starter, Pro, Business or Enterprise; never Free). Clerk `publicMetadata.plan` always holds a base tier, so every code path that switches on `Plan` (labels, "is this paid", `getPlanForUserId`) keeps working and sees, for example, a "Schools" plan as Enterprise. Its own limits come from `publicMetadata.planLimits` (below), and `publicMetadata.planId` names the plan.
- Plans are archived, never deleted. An archived plan is not sold, listed or assignable; its subscribers keep it.

## Versions

- A plan's **terms** (name, description, prices, trial days, limits) are versioned. Saving changed terms makes the next version, and new purchases get it. Order, archived, on sale, listed and highlighted are settings and are not versioned.
- A subscription keeps a snapshot of the version it was bought on. On every change its effective limits (version, plus add-ons, plus custom terms) are written to Clerk `publicMetadata.planLimits`, which is what enforcement reads (`getPlanLimitsForUserId` in `src/lib/plan.ts`). An account without that snapshot uses its tier's built-in limits, which are version 1.
- Subscribers move to another version only through **Migrate** on the plan's version list: previewed (who moves, which limits change), then confirmed by typing `migrate`. Period, price paid and add-ons stay as they are.
- **Free** has no buyers, so its current version applies to every account without a plan as soon as it is saved (cached for 30 s per server instance). It cannot be priced, given a trial, sold or archived.
- Buying a plan again (a renewal) buys its current version at its current price.

## Limits: enforced or only shown

Enforced today: meeting length (the in-room countdown, from the host's token), participants per meeting (token), meetings ever created, cloud recording, recording hours per month, breakout rooms, choosing translation languages, livestream, group members (`memberLimitFor`; empty means as many as the plan allows in a meeting, the old behaviour).

Shown but **not enforced yet**: custom branding, host seats, storage. The admin marks these "shown, not enforced yet".

## Checkout, coupons and offers

- eSPees checkout charges the plan's current **ESP** price from the catalog. ESP is the only currency connected to a payment gateway; prices in USD, EUR, GBP and NGN can be set and shown and are labelled "not connected to a payment gateway".
- A plan is sold online only if it is marked "on sale" and has an ESP price (by default Starter, Pro and Business; Enterprise goes to email).
- A **coupon** (percent or ESP off; plans, cycles, start and expiry, max redemptions, once per account) is entered on /pricing and checked by the checkout route. It is counted as redeemed when its payment comes back paid, so an abandoned checkout does not use it up; several checkouts in flight at once can take it past its limit by that many.
- A **promotional offer** is a discount without a code, applied while it runs and labelled on /pricing. An offer and a coupon do not stack: the larger discount applies.
- Nothing brings a price below 1 ESP; a free period is a complimentary grant.
- **Add-ons** (extra participants, recording hours, members, seats, storage, or a feature switched on) are attached to a subscription by an administrator and enforced like the plan's limits. They cannot be bought at checkout yet.

## Subscriptions

One record per account in KV (`neo:sub:<userId>`, history in `neo:sub:h:<userId>`), indexed by period end (`neo:subs:by_end`) and end date (`neo:subs:ended`). Status is one of trialing, active, paused, cancelled, expired, complimentary. Actions: assign, change plan, extend, pause/resume, cancel (now or at period end), complimentary, custom arrangement (limits, price in any currency, notes), add-ons, withdraw a scheduled change. Each is previewed by the server, then confirmed with a reason, written to Clerk first (a Clerk failure changes nothing), added to the account's history and to the admin audit log with before and after.

- **Paused**: the account is on Free; the time left is kept and starts again on resume.
- **Trials** are started by an administrator (Assign → start with the plan's trial). When a trial ends the account goes back to Free unless paid for. There is no self-serve trial yet.
- The daily cron (`/api/cron/downgrade-expired-plans`) first sweeps the records whose period has ended: a **scheduled change** starts the new plan for a new period; anything else expires to Free. Then the old Clerk sweep runs as before.
- **Backfill** (Subscriptions → Backfill from Clerk) records every account with a paid plan in Clerk and no record, on version 1 of its tier, without touching Clerk. It is safe to run again.
- **The platform owner is never affected.** Every subscription action refuses the owner (`owner_protected`, and the attempt is audited), checkout refuses the owner, the Clerk write itself refuses the owner, the backfill skips the owner, and the owner stays enterprise in every plan lookup.

## The proration rule

eSPees can neither charge a saved wallet nor refund, so nothing here moves money: it moves time. The rule is shown in every confirmation dialog.

1. **Upgrade** (the new plan costs more per day): applies now. The unused days are valued at the price paid and converted into days on the new plan at its price. Example: 30 days left on Pro at 25 ESP/month (0.83/day) become 25 days on Business at 30 ESP/month (1.00/day). An administrator can also add a new period the customer paid for off-band.
2. **Downgrade** (costs less per day): applies at the end of the current period by default, with no refund. Applied now instead, the unused value converts the same way, which gives more days on the cheaper plan.
3. **Same plan again** (a renewal, including through checkout): the new period starts when the current one ends, so no paid day is lost.
4. **Moving to Free, complimentary or custom**: unused paid days are not converted.
5. Time without a recorded price (a backfilled account with no payment record, a complimentary grant) cannot be valued, so it is not converted.

Price per day is the ESP price paid for the period (or the version's list price) divided by 30 (monthly) or 365 (annual), as `computePlanExpiry` counts them.

## Needs a payment-provider integration that does not exist yet

- **Recurring charges and automatic renewal.** eSPees has no saved-wallet charge, so nothing renews by itself and a scheduled change at period end is in effect complimentary unless payment is collected off-band.
- **Refunds.** No refund API; cancelling never refunds, and a refund is made outside the app.
- **Payment verification.** The eSPees return redirect is still trusted without a webhook or status lookup (docs/BILLING-HANDOFF.md §2). Coupon redemptions are counted on that same unverified return.
- **Proration as money.** Upgrade credit and partial-period charges are converted into time because no gateway can charge a difference or refund one.
- **Any currency but ESP.** USD, EUR, GBP and NGN prices are display and configuration only.
- **Buying add-ons, starting a trial or buying a custom plan at checkout.** These are administrator actions today.
- **The mobile app** (`mobile/lib/src/billing/upgrade.dart`) still shows its own built-in prices. Checkout charges the catalog price and returns it, but the app should read `/api/billing/plans` before showing a price.
