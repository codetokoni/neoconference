import Link from "next/link";
import TierCheckoutButton from "@/components/TierCheckoutButton";

export const metadata = {
  title: "Pricing — NeoConference",
  description: "Simple, host-based pricing. Free forever for casual calls. Upgrade for unlimited length, recording, breakouts, and branding.",
};


type Tier = {
  id: "free" | "pro" | "business";
  name: string;
  tagline: string;
  price: { monthly: number; annual: number };
  cta: string;
  ctaHref: string;
  highlight?: boolean;
  features: { label: string; included: boolean | string }[];
};

const TIERS: Tier[] = [
  {
    id: "free",
    name: "Free",
    tagline: "For quick chats and trying things out.",
    price: { monthly: 0, annual: 0 },
    cta: "Get started free",
    ctaHref: "/dashboard",
    features: [
      { label: "20-minute meeting cap", included: true },
      { label: "Up to 10 participants", included: true },
      { label: "HD video & crystal-clear audio", included: true },
      { label: "Live captions", included: true },
      { label: "Polls, chat, reactions, raise hand", included: true },
      { label: "Waiting room", included: true },
      { label: "Cloud recording", included: false },
      { label: "Breakout rooms", included: false },
      { label: "Custom branding", included: false },
      { label: "Community support", included: true },
    ],
  },
  {
    id: "pro",
    name: "Pro",
    tagline: "For freelancers, teachers, and small teams.",
    price: { monthly: 20, annual: 240 },
    cta: "Upgrade to Pro",
    ctaHref: "/api/billing/checkout?plan=pro",
    highlight: true,
    features: [
      { label: "Unlimited meeting length", included: true },
      { label: "Up to 100 participants", included: true },
      { label: "Everything in Free", included: true },
      { label: "Cloud recording (10 hrs/mo)", included: true },
      { label: "Breakout rooms", included: true },
      { label: "Email support", included: true },
      { label: "Custom branding", included: false },
    ],
  },
  {
    id: "business",
    name: "Business",
    tagline: "For organizations that need polish and scale.",
    price: { monthly: 30, annual: 360 },
    cta: "Go Business",
    ctaHref: "/api/billing/checkout?plan=business",
    features: [
      { label: "Up to 300 participants", included: true },
      { label: "Everything in Pro", included: true },
      { label: "Cloud recording (50 hrs/mo)", included: true },
      { label: "Custom branding (logo + room URL)", included: true },
      { label: "Priority email support", included: true },
    ],
  },
];

function formatPrice(amount: number) {
  if (amount === 0) return "0 Espees";
  return amount + " Espees";
}

export default function PricingPage() {
  return (
    <div className="relative overflow-hidden">
      {/* Animated background orbs */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute -top-40 -left-32 h-[34rem] w-[34rem] rounded-full bg-cyan-500/20 blur-3xl animate-orb" />
        <div className="absolute top-20 -right-32 h-[28rem] w-[28rem] rounded-full bg-indigo-500/20 blur-3xl animate-orb" style={{ animationDelay: "-6s" }} />
        <div className="absolute inset-0 neo-grid-bg opacity-60" />
      </div>

      <section className="relative mx-auto max-w-7xl px-6 pt-16 sm:pt-24 pb-12">
        <div className="text-center max-w-3xl mx-auto">
          <div className="inline-flex items-center gap-2 rounded-full neo-glass px-3 py-1 text-xs text-cyan-200/90">
            <span className="relative inline-flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75 animate-ping" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-cyan-300" />
            </span>
            Simple, host-based pricing
          </div>
          <h1 className="mt-6 text-5xl sm:text-6xl font-bold tracking-tight leading-[1.05]">
            <span className="text-white/90">Pick a plan that</span>{" "}
            <span className="neo-gradient-text neo-text-glow">scales with you.</span>
          </h1>
          <p className="mt-6 text-lg text-cyan-100/70">
            Free forever for quick chats. Upgrade only when you need unlimited length, recording, or breakouts.
          </p>
          <p className="mt-2 text-xs text-cyan-100/50">
            Billing is per host. Guests join free.
          </p>
        </div>

        {/* Tier cards */}
        <div className="mt-14 grid gap-6 lg:grid-cols-3">
          {TIERS.map((tier) => {
            const monthly = tier.price.monthly;
            const annual = tier.price.annual;
            const annualSaved = monthly * 12 - annual;
            return (
              <div
                key={tier.id}
                className={
                  "relative rounded-2xl p-7 border transition " +
                  (tier.highlight
                    ? "bg-gradient-to-b from-cyan-500/10 to-indigo-500/5 border-cyan-300/40 shadow-[0_0_60px_rgba(34,211,238,0.15)]"
                    : "neo-glass border-white/10")
                }
              >
                {tier.highlight && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-cyan-400 text-slate-900 text-[11px] font-bold px-3 py-1 tracking-wide">
                    MOST POPULAR
                  </div>
                )}
                <h3 className="text-xl font-semibold text-white">{tier.name}</h3>
                <p className="mt-1 text-sm text-cyan-100/60">{tier.tagline}</p>

                <div className="mt-6 flex items-baseline gap-1">
                  <span className="text-5xl font-bold text-white">
                    {formatPrice(monthly)}
                  </span>
                  {monthly > 0 && (
                    <span className="text-sm text-cyan-100/60">/mo</span>
                  )}
                </div>
                {annual > 0 && (
                  <p className="mt-1 text-xs text-cyan-100/60">
                    or <span className="text-white">{formatPrice(annual)}</span>/yr
                    {annualSaved > 0 && (
                      <span className="ml-1 text-emerald-300">
                        — save {formatPrice(annualSaved)}
                      </span>
                    )}
                  </p>
                )}

                {tier.id === "free" ? (
                  <Link
                    href={tier.ctaHref}
                    className={
                      "mt-8 inline-flex w-full items-center justify-center rounded-xl px-5 py-3 text-sm font-semibold transition " +
                      (tier.highlight
                        ? "bg-cyan-400 text-slate-950 hover:bg-cyan-300"
                        : "bg-white/10 text-white ring-1 ring-white/20 hover:bg-white/15")
                    }
                  >
                    {tier.cta}
                  </Link>
                ) : (
                  <div className="mt-8">
                    <TierCheckoutButton
                      plan={tier.id as "pro" | "business"}
                      label={tier.cta}
                      highlight={tier.highlight}
                    />
                  </div>
                )}

                <ul className="mt-6 space-y-2.5">
                  {tier.features.map((f, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm">
                      {f.included ? (
                        <svg viewBox="0 0 24 24" className="mt-0.5 h-4 w-4 flex-none text-cyan-300" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M5 12l5 5L20 7" />
                        </svg>
                      ) : (
                        <svg viewBox="0 0 24 24" className="mt-0.5 h-4 w-4 flex-none text-white/30" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
      </section>

      {/* FAQ */}
      <section className="relative mx-auto max-w-5xl px-6 pb-24">
        <h2 className="text-2xl sm:text-3xl font-bold text-white/90 text-center">Frequently asked</h2>
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          <Faq q="What counts as a host?">
            A host is anyone who creates or starts a meeting. Guests who only join meetings never need a paid plan.
          </Faq>
          <Faq q="What happens after 20 minutes on Free?">
            The meeting ends automatically. You can immediately start a new one — but for uninterrupted long calls, upgrade to Pro.
          </Faq>
          <Faq q="Can I cancel anytime?">
            Yes. Cancel from your dashboard and you keep your plan until the end of the billing period.
          </Faq>
          <Faq q="What payment methods do you accept?">
            We accept Espees. All plans are billed in Espees through the eSPees payment network.
          </Faq>
          <Faq q="Is there a refund policy?">
            Cancel within 14 days of your first paid charge for a full refund, no questions asked.
          </Faq>
          <Faq q="Do recording hours roll over?">
            No — recording hours reset each billing cycle. We will warn you before you hit your cap.
          </Faq>
        </div>

        <div className="mt-16 rounded-2xl neo-glass border border-white/10 p-8 sm:p-10 text-center">
          <h3 className="text-2xl font-semibold text-white">Need a custom plan?</h3>
          <p className="mt-2 text-cyan-100/70 text-sm max-w-xl mx-auto">
            Schools, churches, and large organizations can get volume discounts, SSO, and custom limits. Tell us what you need.
          </p>
          <a href="mailto:hello@neoconference.app" className="mt-5 inline-flex neo-btn text-sm">
            Contact us
          </a>
        </div>
      </section>
    </div>
  );
}

function Faq({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <div className="neo-glass rounded-xl p-5 border border-white/10">
      <h4 className="font-semibold text-white text-sm">{q}</h4>
      <p className="mt-2 text-sm text-cyan-100/70 leading-relaxed">{children}</p>
    </div>
  );
}
