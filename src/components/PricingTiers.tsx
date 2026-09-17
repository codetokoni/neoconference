"use client";

import { useState } from "react";
import Link from "next/link";
import TierCheckoutButton from "@/components/TierCheckoutButton";
import type { BillingCycle } from "@/lib/espees";
import { getPlanLimits, type Plan } from "@/lib/plan";

type TierId = Plan; // "free" | "starter" | "pro" | "business" | "enterprise"

type Tier = {
  id: TierId;
  name: string;
  tagline: string;
  // null/null = "Custom" (Enterprise). 0/0 = free.
  price: { monthly: number | null; annual: number | null };
  cta: string;
  ctaHref: string;
  highlight?: boolean;
  /** Marketing-copy rows that describe things NOT modelled in
   *  getPlanLimits — "HD video", "Live captions", "Community support"
   *  etc. The plan-limit-driven rows (participants, recording,
   *  breakouts, branding, livestream) are appended by
   *  {@link planLimitFeatures} at render time so /pricing stays
   *  in lock-step with the actual server-side enforcement in
   *  src/lib/plan.ts. */
  extraFeatures: { label: string; included: boolean }[];
};

/**
 * Turn the plan's PlanLimits into the human-readable feature rows
 * the pricing table shows. Single source of truth: change plan.ts
 * and this reflects automatically.
 */
function planLimitFeatures(id: TierId): { label: string; included: boolean }[] {
  const l = getPlanLimits(id);
  const minutesLabel = l.meetingMinutes === 0
    ? "Unlimited meeting length"
    : l.meetingMinutes === 60
      ? "60-minute meeting cap"
      : Math.round(l.meetingMinutes / 60) + "-hour meeting cap";
  const participantsLabel = l.maxParticipants === 0
    ? "Unlimited participants"
    : "Up to " + l.maxParticipants + " participants";
  const lifetimeLabel = l.lifetimeMeetingCap === 0
    ? "Unlimited meetings"
    : l.lifetimeMeetingCap + " lifetime meetings";
  const recordingLabel = l.recording
    ? l.recordingHoursPerMonth === 0
      ? "Cloud recording"
      : "Cloud recording (" + l.recordingHoursPerMonth + " hrs/mo)"
    : "Cloud recording";
  return [
    { label: minutesLabel, included: true },
    { label: participantsLabel, included: true },
    { label: lifetimeLabel, included: true },
    { label: recordingLabel, included: l.recording },
    { label: "Breakout rooms", included: l.breakouts },
    { label: "Custom branding" + (l.branding ? " (logo + room URL)" : ""), included: l.branding },
    { label: "Livestream to RTMP / YouTube / Facebook / Twitch", included: l.livestream },
  ];
}

const TIERS: Tier[] = [
  {
    id: "free",
    name: "Free",
    tagline: "For quick chats and trying things out.",
    price: { monthly: 0, annual: 0 },
    cta: "Get started free",
    ctaHref: "/dashboard",
    extraFeatures: [
      { label: "HD video & crystal-clear audio", included: true },
      { label: "Live captions", included: true },
      { label: "Polls, chat, reactions, raise hand", included: true },
      { label: "Waiting room", included: true },
      { label: "Community support", included: true },
    ],
  },
  {
    id: "starter",
    name: "Starter",
    tagline: "For solo creators and small group calls.",
    price: { monthly: 10, annual: 100 },
    cta: "Upgrade to Starter",
    ctaHref: "",
    extraFeatures: [
      { label: "Everything in Free", included: true },
      { label: "Email support", included: true },
    ],
  },
  {
    id: "pro",
    name: "Pro",
    tagline: "For freelancers, teachers, and small teams.",
    price: { monthly: 20, annual: 200 },
    cta: "Upgrade to Pro",
    ctaHref: "",
    highlight: true,
    extraFeatures: [
      { label: "Everything in Starter", included: true },
      { label: "Email support", included: true },
    ],
  },
  {
    id: "business",
    name: "Business",
    tagline: "For organizations that need polish and scale.",
    price: { monthly: 30, annual: 300 },
    cta: "Go Business",
    ctaHref: "",
    extraFeatures: [
      { label: "Everything in Pro", included: true },
      { label: "Priority email support", included: true },
    ],
  },
  {
    id: "enterprise",
    name: "Enterprise",
    tagline: "For schools, churches, and large organizations.",
    price: { monthly: null, annual: null },
    cta: "Contact sales",
    ctaHref: "mailto:info@neoconference.app",
    extraFeatures: [
      { label: "Everything in Business", included: true },
      { label: "Volume discounts", included: true },
      { label: "Custom limits", included: true },
      { label: "Dedicated support", included: true },
    ],
  },
];

function formatPrice(amount: number): string {
  if (amount === 0) return "0 Espees";
  return amount + " Espees";
}

export default function PricingTiers() {
  const [cycle, setCycle] = useState<BillingCycle>("monthly");

  return (
    <>
      {/* Monthly / Annual toggle */}
      <div className="mt-10 flex justify-center">
        <div className="inline-flex items-center rounded-full neo-glass p-1 ring-1 ring-white/10 text-xs">
          <button
            type="button"
            onClick={() => setCycle("monthly")}
            aria-pressed={cycle === "monthly"}
            className={
              "px-4 py-1.5 rounded-full font-semibold transition " +
              (cycle === "monthly"
                ? "bg-cyan-400 text-slate-950"
                : "text-cyan-100/70 hover:text-white")
            }
          >
            Monthly
          </button>
          <button
            type="button"
            onClick={() => setCycle("annual")}
            aria-pressed={cycle === "annual"}
            className={
              "px-4 py-1.5 rounded-full font-semibold transition " +
              (cycle === "annual"
                ? "bg-cyan-400 text-slate-950"
                : "text-cyan-100/70 hover:text-white")
            }
          >
            Annual
          </button>
        </div>
      </div>

      {/* Tier cards */}
      <div className="mt-10 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-6">
        {TIERS.map((tier, idx) => {
          const isEnterprise = tier.id === "enterprise";
          const isFree = tier.id === "free";
          const monthly = tier.price.monthly;
          const annual = tier.price.annual;
          // Desktop bottom-row centering on a 6-col grid: every card spans 2 cols.
          // Cards 1-3 flow into row 1 cols 1-2, 3-4, 5-6. Card 4 (Business) starts at
          // col 2 (cols 2-3); card 5 (Enterprise) starts at col 4 (cols 4-5) — same
          // card width as row 1, centered pair in row 2.
          // Tablet (sm: 2-col grid): Enterprise spans both cols so the lone 5th card
          // isn't orphaned in row 3.
          const gridPos =
            idx === 3 ? "lg:col-start-2" :
            idx === 4 ? "sm:col-span-2 lg:col-start-4" :
            "";

          return (
            <div
              key={tier.id}
              aria-label={tier.highlight ? "Most popular plan" : undefined}
              className={
                "relative rounded-2xl p-7 border transition-transform lg:col-span-2 " +
                gridPos + " " +
                (tier.highlight
                  ? "bg-gradient-to-b from-cyan-500/10 to-indigo-500/5 border-2 border-cyan-400/50 shadow-2xl shadow-cyan-500/20 lg:scale-105"
                  : "neo-glass border-white/10")
              }
            >
              {tier.highlight && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-gradient-to-r from-cyan-400 to-purple-500 text-white text-[11px] font-bold px-3 py-1 tracking-wide shadow-lg">
                  MOST POPULAR
                </div>
              )}

              <h3 className="text-xl font-semibold text-white">{tier.name}</h3>
              <p className="mt-1 text-sm text-cyan-100/60">{tier.tagline}</p>

              {/* Price block — fixed minimum height keeps cards aligned across the row */}
              <div className="mt-6 min-h-[5.5rem]">
                {isEnterprise ? (
                  <div>
                    <div className="text-3xl font-bold text-white leading-tight">Custom</div>
                    <p className="mt-1 text-sm text-cyan-100/60">Talk to us</p>
                  </div>
                ) : isFree ? (
                  <div className="flex items-baseline gap-1">
                    <span className="text-4xl font-bold text-white">{formatPrice(0)}</span>
                  </div>
                ) : cycle === "monthly" ? (
                  <>
                    <div className="flex items-baseline gap-1">
                      <span className="text-4xl font-bold text-white">
                        {formatPrice(monthly ?? 0)}
                      </span>
                      <span className="text-sm text-cyan-100/60">/mo</span>
                    </div>
                    {annual !== null && monthly !== null && annual > 0 ? (
                      <p className="mt-1 text-xs text-cyan-100/60">
                        or <span className="text-white">{formatPrice(annual)}</span>/yr
                        {monthly * 12 - annual > 0 && (
                          <span className="ml-1 text-emerald-300">
                            — save {formatPrice(monthly * 12 - annual)}
                          </span>
                        )}
                      </p>
                    ) : null}
                  </>
                ) : (
                  <div className="flex items-baseline gap-1">
                    <span className="text-4xl font-bold text-white">
                      {formatPrice(annual ?? 0)}
                    </span>
                    <span className="text-sm text-cyan-100/60">/yr</span>
                  </div>
                )}
              </div>

              {/* CTA */}
              <div className="mt-6">
                {isFree ? (
                  <Link
                    href={tier.ctaHref}
                    className="inline-flex w-full items-center justify-center rounded-xl px-5 py-3 text-sm font-semibold transition bg-white/10 text-white ring-1 ring-white/20 hover:bg-white/15"
                  >
                    {tier.cta}
                  </Link>
                ) : isEnterprise ? (
                  <a
                    href={tier.ctaHref}
                    className="inline-flex w-full items-center justify-center rounded-xl px-5 py-3 text-sm font-semibold transition bg-white/10 text-white ring-1 ring-white/20 hover:bg-white/15"
                  >
                    {tier.cta}
                  </a>
                ) : (
                  <TierCheckoutButton
                    plan={tier.id as "starter" | "pro" | "business"}
                    billingCycle={cycle}
                    label={tier.cta}
                    highlight={tier.highlight}
                  />
                )}
              </div>

              {/* Features. Plan-limit rows come from getPlanLimits so
                  the pricing table can never drift from what the
                  server actually enforces; marketing-copy rows are
                  the static extraFeatures per tier. */}
              <ul className="mt-6 space-y-2.5">
                {[...planLimitFeatures(tier.id), ...tier.extraFeatures].map((f, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm">
                    {f.included ? (
                      <svg
                        viewBox="0 0 24 24"
                        className="mt-0.5 h-4 w-4 flex-none text-cyan-300"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="3"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M5 12l5 5L20 7" />
                      </svg>
                    ) : (
                      <svg
                        viewBox="0 0 24 24"
                        className="mt-0.5 h-4 w-4 flex-none text-white/30"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M6 6l12 12M18 6L6 18" />
                      </svg>
                    )}
                    <span className={f.included ? "text-cyan-100/90" : "text-white/40"}>
                      {f.label}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </>
  );
}
