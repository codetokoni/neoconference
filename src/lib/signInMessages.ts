// src/lib/signInMessages.ts
//
// What the email-and-password sign-in says when it does not work, by Clerk's
// error code, in words that say what to do next. It used to show Clerk's own
// message ("Password is incorrect. Try again, or use another method."), and on
// 20 Nov 2026 pastors reported members whose "password is rejected": many had
// joined through KingsChat, whose accounts have no password at all.

const KC = "“Continue with KingsChat” above";

const BY_CODE: Record<string, string> = {
  form_password_incorrect: `That password isn’t right. Try again, or tap “Forgot password?” to set a new one. If you joined with KingsChat, use ${KC} instead.`,
  form_identifier_not_found: `There’s no account with this email. If you joined with KingsChat, use ${KC}. New here? Tap “Create account”.`,
  strategy_for_user_invalid: `This account doesn’t use a password: sign in with ${KC} (or Neoemail).`,
  form_password_pwned: "This password has appeared in a data leak elsewhere, so it can’t be used any more. Tap “Forgot password?” to set a new one.",
  form_password_length_too_short: "That password is too short. Tap “Forgot password?” to set a new one.",
  user_locked: "Too many wrong tries, so this account is locked for a while. Try again later, or tap “Forgot password?”.",
  too_many_requests: "Too many tries in a short time. Wait a minute, then try again.",
  form_param_format_invalid: "That doesn’t look like an email address. Check it and try again.",
  form_code_incorrect: "That code isn’t right. Check the newest email from us and try again.",
  verification_failed: "That code isn’t right. Check the newest email from us and try again.",
  verification_expired: "That code has expired. Tap “Send a new code”.",
};

/** The words for a failed sign-in: by Clerk's error code, else Clerk's own, else a general line. */
export function signInErrorText(err: { code?: string; message?: string; longMessage?: string } | undefined): string {
  const code = err?.code ?? "";
  return BY_CODE[code] ?? err?.longMessage ?? err?.message ?? "Sign-in didn’t work. Check your email and password and try again.";
}

/** "a•••@example.com": enough to recognise the address the code went to. */
export function maskEmail(email: string): string {
  const [user, domain] = email.split("@");
  if (!domain) return email;
  return `${user.slice(0, 1)}${"•".repeat(Math.max(1, Math.min(3, user.length - 1)))}@${domain}`;
}

const SIGN_UP: Record<string, string> = {
  form_identifier_exists: `This email already has an account. Sign in instead (tap “Sign in” below); if you joined with KingsChat, use “Continue with KingsChat” on the sign-in page.`,
  form_password_length_too_short: "Use a password of at least 8 characters.",
  form_password_not_strong_enough: "Choose a stronger password: longer, with letters and numbers.",
  form_password_pwned: "This password has appeared in a data leak elsewhere, so it can’t be used. Choose another one.",
  form_password_size_in_bytes_exceeded: "That password is too long. Choose a shorter one.",
  captcha_invalid: "The security check didn’t work. Refresh the page and try again.",
  captcha_unavailable: "The security check didn’t load. Refresh the page and try again.",
};

/** The words for a failed sign-up: its own cases, then those it shares with sign-in (codes, too many tries). */
export function signUpErrorText(err: { code?: string; message?: string; longMessage?: string } | undefined): string {
  return SIGN_UP[err?.code ?? ""] ?? signInErrorText(err);
}

/** What a sign-up still needs after the email code, in words (Clerk's missing_requirements). */
export function missingFieldsText(fields: string[] | undefined): string {
  const words: Record<string, string> = {
    first_name: "your first name",
    last_name: "your last name",
    username: "a username",
    phone_number: "a phone number",
    password: "a password",
    legal_accepted: "accepting the terms",
  };
  const list = (fields ?? []).map((f) => words[f] ?? f.replace(/_/g, " "));
  return list.length
    ? `Your email is confirmed, but the account also needs ${list.join(", ")}, which this page can’t ask for. Use “Continue with KingsChat” on the sign-in page, or contact support.`
    : "Your email is confirmed, but the account isn’t finished. Try again, or use “Continue with KingsChat” on the sign-in page.";
}
