import type { Metadata } from "next";
import Link from "next/link";
import SupportChatOpener from "./SupportChatOpener";
import ContactForm from "./ContactForm";

export const metadata: Metadata = {
  title: "Help & support — NeoConference",
  description: "Chat with the NeoConference team, send a support request, or browse the help centre.",
};

// The page the app's "Help & support" opens: the chat opens on arrival, and
// below it the help centre, the contact form and the user's tickets.
export default function SupportPage() {
  return (
    <section className="mx-auto max-w-2xl px-6 py-20 text-center">
      <SupportChatOpener />
      <h1 className="text-3xl sm:text-4xl font-semibold text-white tracking-tight">Help &amp; support</h1>
      <p className="mt-4 text-cyan-100/70 leading-relaxed">
        Ask us anything about NeoConference: joining a meeting, live translation, recording, or
        your plan. The chat opens at the bottom of this page; if it doesn&apos;t, tap the chat
        button.
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-3 text-sm">
        <Link href="/help" className="rounded-lg border border-cyan-400/40 px-3.5 py-2 font-medium text-cyan-100 hover:bg-cyan-400/10">
          Browse the help centre
        </Link>
        <Link href="/support/tickets" className="rounded-lg border border-white/15 px-3.5 py-2 text-cyan-100/80 hover:bg-white/5">
          My tickets
        </Link>
      </div>

      <div id="contact" className="mt-12 rounded-2xl border border-white/10 bg-white/[0.03] p-5 sm:p-6">
        <h2 className="text-left text-xl font-semibold text-white">Contact support</h2>
        <p className="mb-4 mt-1 text-left text-sm text-cyan-100/60">Not urgent, or need to send details? Send a request and we&apos;ll reply by email.</p>
        <ContactForm />
      </div>

      <p className="mt-6 text-sm text-cyan-100/50">
        Or email{" "}
        <a href="mailto:info@neoconference.app" className="text-cyan-200 hover:text-cyan-100">
          info@neoconference.app
        </a>
        .
      </p>
    </section>
  );
}
