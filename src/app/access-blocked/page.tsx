// /access-blocked — where the middleware sends a new account the
// registration rules (admin settings) refuse, with the reason by name.

import type { Metadata } from "next";
import Link from "next/link";
import { REGISTRATION_MESSAGES, type RegistrationRefusal } from "@/lib/platform/model";
import { getPlatformSettings } from "@/lib/platform/settings";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Account not available", robots: { index: false } };

export default async function AccessBlockedPage({ searchParams }: { searchParams: { reason?: string } }) {
  const settings = await getPlatformSettings();
  const reason = searchParams.reason as RegistrationRefusal | undefined;
  const message =
    (reason && REGISTRATION_MESSAGES[reason]) || "This account cannot be used on this platform at the moment.";
  const { supportEmail, supportPhone } = settings.contacts;
  return (
    <section className="mx-auto max-w-xl px-6 py-20 text-center" data-registration-blocked={reason || "unknown"}>
      <h1 className="text-3xl font-semibold tracking-tight text-white">Account not available</h1>
      <p className="mt-4 leading-relaxed text-cyan-100/80">{message}</p>
      {reason === "email_unverified" && (
        <p className="mt-3 text-sm text-cyan-100/60">
          Add or verify an email address in your account settings, then come back to this page.
        </p>
      )}
      <p className="mt-6 text-sm text-cyan-100/60">
        Think this is a mistake? Contact{" "}
        {supportEmail ? (
          <a className="text-cyan-200 hover:text-cyan-100" href={`mailto:${supportEmail}`}>
            {supportEmail}
          </a>
        ) : (
          <Link className="text-cyan-200 hover:text-cyan-100" href="/support">
            support
          </Link>
        )}
        {supportPhone ? ` or call ${supportPhone}` : ""}.
      </p>
      <div className="mt-8 flex justify-center gap-3">
        <Link href="/sign-out" className="rounded-lg border border-white/15 px-4 py-2 text-sm text-zinc-200 hover:bg-white/5">
          Sign out
        </Link>
        <Link href="/support" className="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-black hover:bg-cyan-400">
          Help &amp; support
        </Link>
      </div>
    </section>
  );
}
