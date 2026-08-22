# Setup: Clerk multi-factor authentication for owner accounts

## Purpose

FRS §12.1 requires two-factor authentication for Owner accounts. The
NeoConference codebase uses Clerk for authentication, and Clerk's 2FA
support is a project-level toggle in the Clerk dashboard — no code
change unlocks it. This runbook flips the toggle for the NeoConference
Clerk application.

Enabling MFA does not force-enroll every existing user. It exposes the
option in the sign-in flow and lets the account owner (platform admin)
opt in from their account page. Once enrolled, that user is required
to complete a second factor at every sign-in.

## Prerequisites

- A browser tool is available (`claude-in-chrome` preferred; see
  `docs/runbooks/README.md`).
- The user is signed in to https://dashboard.clerk.com — or prepared
  to sign in when prompted. Do not attempt to enter credentials on
  their behalf.
- The user knows which Clerk application powers NeoConference (name
  typically contains "neoconference"). Ask if unsure.

## Steps

1. **Navigate to the Clerk dashboard.**
   - URL: `https://dashboard.clerk.com/`
   - After sign-in Clerk lands on the applications list.

2. **Open the NeoConference application.**
   - Click the application card matching the name the user gives.

3. **Open the Multi-factor settings page.**
   - Left nav: **User & authentication** → **Multi-factor**.
   - The URL pattern is
     `https://dashboard.clerk.com/apps/app_<id>/user-authentication/multi-factor`
     though the specific app id will differ per environment.

4. **Enable a second factor.**
   - The page lists methods: **Authenticator app (TOTP)**,
     **SMS**, **Backup codes**.
   - Toggle **Authenticator app (TOTP)** **on**. TOTP is the
     recommended default — no phone-number handling, works with any
     standard authenticator (1Password, Authy, Google Authenticator).
   - Optional: also enable **Backup codes** so a user who loses their
     authenticator can recover.
   - Leave **SMS** disabled unless the user specifically asks for it
     — SMS 2FA has known deliverability and swap-attack risks.

5. **Save.**
   - Clerk auto-saves on toggle; watch for the confirmation toast
     ("Multi-factor authentication settings saved" or equivalent).

6. **(Optional) Require MFA for admin accounts.**
   - Still on the Multi-factor page, look for a **Required for**
     section or **Enforcement** dropdown.
   - If present, set it to require MFA for accounts in the admin
     role. If not present at this Clerk plan, the codebase-level
     enforcement will need to happen in `src/lib/roles.ts` in a
     follow-up PR — flag it back to the user rather than trying to
     configure it here.

## Verification (external)

- Sign out of `https://www.neoconference.app/`.
- Visit any protected page (e.g. `/dashboard`) — Clerk should
  redirect to `/sign-in`.
- Sign back in with an account. After password, Clerk should now
  either prompt to enroll in TOTP (first sign-in after enabling) or
  ask for a TOTP code (subsequent sign-ins after enrollment).
- Owner account (email in `ADMIN_EMAILS`) should be prompted the same
  way — this runbook doesn't create an admin-only path, it enables the
  feature project-wide.

## Rollback

- Reopen the Multi-factor page from step 3.
- Toggle **Authenticator app (TOTP)** **off** (and any other factor
  that this runbook enabled).
- Confirm the removal.
- Users who had already enrolled retain their enrollment but the
  factor no longer triggers on sign-in.
- No code changes are required to roll back — the toggle is the only
  switch.
