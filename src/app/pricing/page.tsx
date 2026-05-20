import PricingTiers from "@/components/PricingTiers";

export const metadata = {
  title: "Pricing — NeoConference",
  description: "Simple, host-based pricing. Free forever for casual calls. Five plans from Starter to Enterprise — choose the participant cap, recording, and branding that fit you.",
};

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
            Free forever for quick chats. Upgrade for longer meetings, bigger rooms, recording, and branding.
          </p>
          <p className="mt-2 text-xs text-cyan-100/50">
            Billing is per host. Guests join free.
          </p>
        </div>

        <PricingTiers />
      </section>

      {/* FAQ */}
      <section className="relative mx-auto max-w-5xl px-6 pb-24">
        <h2 className="text-2xl sm:text-3xl font-bold text-white/90 text-center">Frequently asked</h2>
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          <Faq q="What counts as a host?">
            A host is anyone who creates or starts a meeting. Guests who only join meetings never need a paid plan.
          </Faq>
          <Faq q="What happens after 60 minutes on Free?">
            The meeting ends automatically. You can immediately start a new one — but for uninterrupted long calls, upgrade to Starter or Pro.
          </Faq>
          <Faq q="What is the 5-lifetime-meeting cap?">
            The Free plan lets you create up to 5 meetings ever (across the lifetime of the account). Once you hit that, you'll need to upgrade to keep hosting. Joining other people's meetings stays free.
          </Faq>
          <Faq q="Do existing paid users get the new participant limits?">
            Yes. The new caps (Starter 100 / Pro 200 / Business 500) apply to every paid user on their next session — nothing to do, no migration needed.
          </Faq>
          <Faq q="Can I cancel anytime?">
            Yes. Cancel from your dashboard and you keep your plan until the end of the billing period.
          </Faq>
          <Faq q="What payment methods do you accept?">
            All paid plans are billed in Espees through the eSPees payment network.
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
            Schools, churches, and large organizations can get volume discounts and custom limits. Tell us what you need.
          </p>
          <a href="mailto:info@neoconference.app" className="mt-5 inline-flex neo-btn text-sm">
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
