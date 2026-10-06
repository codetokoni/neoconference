"use client";

// The way out when a plan limit stops something: a link to the plans, shown
// under an error only when the error is one of those limits.

import Link from "next/link";
import { isPlanLimitMessage } from "@/lib/groupMessages";

export default function UpgradeHint({ error }: { error: string | null | undefined }) {
  if (!error || !isPlanLimitMessage(error)) return null;
  return (
    <p className="text-xs text-slate-300">
      <Link href="/dashboard/billing" className="text-cyan-300 hover:text-cyan-200 underline underline-offset-2">
        See plans and upgrade
      </Link>{" "}
      — only the group&apos;s owner can.
    </p>
  );
}
