"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

const PLAN_LABELS: Record<string, string> = {
  pro: "Pro",
  business: "Business",
};

export default function UpgradeBanner() {
  const params = useSearchParams();
  const router = useRouter();
  const upgraded = params.get("upgraded");
  const error = params.get("error");
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    if (!upgraded && !error) return;
    const t = setTimeout(() => {
      setVisible(false);
      router.replace("/dashboard");
    }, 6000);
    return () => clearTimeout(t);
  }, [upgraded, error, router]);

  if (!visible) return null;
  if (!upgraded && !error) return null;

  if (upgraded) {
    const planLabel = PLAN_LABELS[upgraded] || upgraded;
    return (
      <div className="mb-4 rounded-xl border border-emerald-400/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
        <span className="font-semibold">Welcome to {planLabel}!</span> Your plan is now active. Enjoy the upgrade.
      </div>
    );
  }

  return (
    <div className="mb-4 rounded-xl border border-rose-400/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
      <span className="font-semibold">Upgrade not completed.</span>{" "}
      {error === "payment_failed"
        ? "The payment did not go through. You can try again from the Pricing page."
        : error === "clerk_update_failed"
        ? "We received your payment but could not activate the plan. Please contact support."
        : "Something went wrong. Please try again."}
    </div>
  );
}
