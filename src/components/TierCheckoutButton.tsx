"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";

type Plan = "starter" | "pro" | "business";
type BillingCycle = "monthly" | "annual";

export default function TierCheckoutButton({
  plan,
  billingCycle,
  label,
  highlight,
}: {
  plan: Plan;
  billingCycle: BillingCycle;
  label: string;
  highlight?: boolean;
}) {
  const { isLoaded, isSignedIn } = useUser();
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const base =
    "inline-flex w-full items-center justify-center rounded-xl px-5 py-3 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-60";
  const styles = highlight
    ? "bg-cyan-400 text-slate-950 hover:bg-cyan-300"
    : "bg-white/10 text-white ring-1 ring-white/20 hover:bg-white/15";

  async function onClick() {
    setError(null);
    if (!isLoaded) return;
    if (!isSignedIn) {
      const next = encodeURIComponent("/pricing");
      router.push(`/sign-in?redirect_url=${next}`);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/billing/espees/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan, billingCycle }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.url) {
        setError(data?.error || "Could not start checkout. Please try again.");
        setLoading(false);
        return;
      }
      window.location.href = data.url as string;
    } catch (e) {
      setError("Network error. Please try again.");
      setLoading(false);
    }
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={onClick}
        disabled={loading || !isLoaded}
        className={`${base} ${styles}`}
      >
        {loading ? "Redirecting…" : label}
      </button>
      {error ? (
        <p className="text-xs text-rose-300">{error}</p>
      ) : null}
    </div>
  );
}
