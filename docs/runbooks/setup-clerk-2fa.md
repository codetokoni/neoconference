# Setup: Clerk multi-factor authentication for owner accounts

> **Verified against the live Clerk dashboard on 2026-08-22.**
> This runbook cannot currently be completed: every MFA strategy is a
> paid (Pro) feature and the NeoConference workspace is on Hobby. See
> "Blocked on plan" below. An earlier revision also misdescribed the
> enforcement toggle in a way that could have forced every user into
> enrollment — see "What changed".

## Purpose

FRS §12.1 requires two-factor authentication for Owner accounts.
NeoConference uses Clerk, and MFA is a dashboard-level feature — no
code change unlocks it.

## Blocked on plan

As of 2026-08-22, on **both** the Production and Development instances:

| Strategy | State | Note |
|---|---|---|
| SMS verification code | Off, **Pro** | Also requires phone numbers to be enabled |
| Authenticator application | Off, **Pro** | The strategy this runbook wants |
| Backup codes | Off, **Pro** | Requires Authenticator application first |

The workspace (`Personal workspace`) is on the **Hobby** plan, so all
three toggles are inert. **Upgrading the Clerk plan is a billing
decision for the account owner — do not attempt it as part of this
runbook.** Confirm the upgrade has happened before running the steps
below.

## Prerequisites

- Clerk workspace on a plan that includes MFA strategies.
- A browser tool is available (`claude-in-chrome` preferred; see
  `docs/runbooks/README.md`).
- The user is signed in to https://dashboard.clerk.com — or prepared
  to sign in when prompted. Do not attempt to enter credentials on
  their behalf.
- **The user has stated which instance to configure.** See step 2 —
  this is not optional and there is no safe default.

## Steps

1. **Navigate to the Clerk dashboard.**
   - URL: `https://dashboard.clerk.com/`
   - Confirm the application selector in the top bar reads
     **NeoConference** (`app_3DI2471NceZ34xrrrxGI2tklTB5`).

2. **Select the correct instance. Do this first.**
   - The environment switcher sits in the top bar and offers
     **Production** and **Development**. **The dashboard opens on
     Development by default.**
   - Production is `ins_3DXgCr4XDskBMCnuD8koe90mnyH`; Development is
     `ins_3DI24GTJfIJbKeSagSI4b1ppfvy`. The instance id appears in the
     URL — check it before touching a toggle.
   - Configuring Development has no effect on users of
     `https://www.neoconference.app/`. Ask the user which they want;
     for FRS §12.1 the answer is Production.

3. **Open the Multi-factor page.**
   - Top nav: **Configure** tab → sidebar **User & authentication** →
     **Multi-factor**.
   - URL pattern:
     `https://dashboard.clerk.com/apps/<app_id>/instances/<instance_id>/user-authentication/multi-factor`

4. **Enable a second factor.**
   - Toggle **Authenticator application** on. (Labelled "Authenticator
     application", not "Authenticator app (TOTP)".) TOTP is the
     recommended default — no phone-number handling, works with any
     standard authenticator.
   - Optional: also enable **Backup codes** so a user who loses their
     authenticator can recover. This is only selectable once
     Authenticator application is on.
   - Leave **SMS verification code** disabled. Beyond the known
     deliverability and SIM-swap risks, it additionally requires phone
     numbers to be enabled as an identifier.

5. **Confirm the save.**
   - Clerk auto-saves on toggle; watch for the confirmation toast.

6. **Enforcement — read this before touching it.**
   - The control is a single toggle, **Require multi-factor
     authentication**: *"Will enforce users to setup multi-factor
     authentication after sign-in and sign-up."*
   - **It is global. It applies to every user of the instance, not
     just admins.** There is no "Required for" section and no
     role-scoping dropdown. Turning it on will push the entire
     NeoConference user base into TOTP enrollment at next sign-in.
   - It stays disabled until at least one strategy from step 4 is on.
   - Clerk warns to check that your SDK versions meet the minimum
     before enabling it; follow the "setup MFA guide" link on the page.
   - **For FRS §12.1 — Owner accounts specifically — do not use this
     toggle.** Admin-scoped enforcement has to happen in code, in
     `src/lib/roles.ts`, as a follow-up PR. Flag that back to the user
     rather than approximating it with a global switch.

## Verification (external)

- Sign out of `https://www.neoconference.app/`.
- Visit a protected page (e.g. `/dashboard`) — Clerk should redirect
  to `/sign-in`.
- Sign back in. Clerk should offer TOTP enrollment on the account page,
  and prompt for a code on subsequent sign-ins once enrolled.
- Note that enabling a strategy (steps 4-5) *exposes* MFA as an option;
  it does not enroll anyone. Only the step 6 toggle forces enrollment,
  and it forces it on everyone.

## Rollback

- Reopen the Multi-factor page for the same instance.
- Toggle off whatever this runbook enabled.
- If enforcement was enabled, turn it off first — otherwise users are
  mid-enrollment against strategies that are being withdrawn.
- Users who already enrolled retain their enrollment; the factor no
  longer triggers on sign-in.
- No code changes are required to roll back.

## What changed (2026-08-22)

- Added the plan blocker: all three strategies are Pro-gated and the
  workspace is on Hobby, so step 4 is not clickable today.
- Added instance selection (step 2). The previous revision never
  mentioned that Production and Development are separate instances, and
  the dashboard opens on Development — following it literally would
  have configured dev and left production untouched.
- Corrected the nav path: settings live under the **Configure** tab.
- Rewrote step 6. The previous revision said to "set it to require MFA
  for accounts in the admin role", describing a control that does not
  exist, and the Purpose section claimed "Enabling MFA does not
  force-enroll every existing user" — true of the strategy toggles,
  false of the enforcement toggle. Read together they invited an
  operator to flip a global switch believing it was admin-scoped.
