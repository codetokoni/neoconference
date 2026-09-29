import type { Metadata } from "next";
import SupportChatOpener from "./SupportChatOpener";

export const metadata: Metadata = {
  title: "Help & support — NeoConference",
  description: "Chat with the NeoConference team.",
};

// The page the app's "Help & support" opens: the chat opens on arrival.
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
