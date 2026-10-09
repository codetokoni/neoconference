// /unsubscribe?t=<token> — the link at the foot of every announcement email.
//
// Works signed out: the signed token names the account and the category
// (src/lib/comms/prefs.ts). Opening the page changes nothing — mail systems
// open links to scan them — the button does.

import type { Metadata } from "next";
import Link from "next/link";
import { getPrefs, PREF_CATEGORIES, readUnsubscribeToken } from "@/lib/comms/prefs";

export const metadata: Metadata = { title: "Email preferences — NeoConference", robots: { index: false } };
export const dynamic = "force-dynamic";

export default async function UnsubscribePage({ searchParams }: { searchParams: { t?: string; done?: string } }) {
  const token = searchParams.t ?? "";
  const who = readUnsubscribeToken(token);
  const box = "mx-auto mt-16 max-w-md rounded-2xl border border-white/10 bg-white/[0.03] p-6 text-zinc-200";
  if (!who) {
    return (
      <main className="px-4">
        <div className={box}>
          <h1 className="text-xl font-semibold text-white">This link does not work</h1>
          <p className="mt-2 text-sm text-zinc-400">
            It may have been cut short by your email app. Sign in and choose what you hear about in{" "}
            <Link href="/dashboard/settings#notifications" className="text-cyan-300 underline">
              Account settings
            </Link>
            .
          </p>
        </div>
      </main>
    );
  }
  const cat = PREF_CATEGORIES.find((c) => c.key === who.category)!;
  const on = (await getPrefs(who.uid)).categories[who.category].email;
  const done = searchParams.done;
  return (
    <main className="px-4">
      <div className={box}>
        <h1 className="text-xl font-semibold text-white">{cat.label} by email</h1>
        <p className="mt-1 text-sm text-zinc-400">{cat.description}</p>
        {done === "unsubscribed" && (
          <p role="status" className="mt-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">
            Done. You will not get {cat.label.toLowerCase()} by email any more.
          </p>
        )}
        {done === "resubscribed" && (
          <p role="status" className="mt-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">
            You will get {cat.label.toLowerCase()} by email again.
          </p>
        )}
        <form method="post" action="/api/comms/unsubscribe" className="mt-5">
          <input type="hidden" name="t" value={token} />
          <input type="hidden" name="from" value="page" />
          <input type="hidden" name="action" value={on ? "unsubscribe" : "resubscribe"} />
          <button
            type="submit"
            className={
              on
                ? "w-full rounded-lg bg-cyan-500 px-4 py-2.5 text-sm font-semibold text-black hover:bg-cyan-400"
                : "w-full rounded-lg border border-white/15 px-4 py-2.5 text-sm text-zinc-200 hover:bg-white/5"
            }
          >
            {on ? `Unsubscribe from ${cat.label.toLowerCase()}` : `Get ${cat.label.toLowerCase()} by email again`}
          </button>
        </form>
        <p className="mt-4 text-xs text-zinc-500">
          Emails about your own account and meetings — invitations, sign-in and security notices, receipts — and service notices are always sent. More
          choices in{" "}
          <Link href="/dashboard/settings#notifications" className="text-cyan-300 underline">
            Account settings
          </Link>
          .
        </p>
      </div>
    </main>
  );
}
