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
