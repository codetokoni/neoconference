import type { Metadata } from "next";
import SupportChatOpener from "./SupportChatOpener";
import { getPlatformSettings } from "@/lib/platform/settings";

export const metadata: Metadata = {
  title: "Help & support — NeoConference",
  description: "Chat with the NeoConference team.",
};

export const dynamic = "force-dynamic";

// The page the app's "Help & support" opens: the chat opens on arrival.
// The contacts below come from the admin settings (/admin/settings).
export default async function SupportPage() {
  const { branding, contacts } = await getPlatformSettings();
  return (
    <section className="mx-auto max-w-2xl px-6 py-20 text-center">
      <SupportChatOpener />
      <h1 className="text-3xl sm:text-4xl font-semibold text-white tracking-tight">Help &amp; support</h1>
      <p className="mt-4 text-cyan-100/70 leading-relaxed">
        Ask us anything about {branding.platformName}: joining a meeting, live translation, recording, or
        your plan. The chat opens at the bottom of this page; if it doesn&apos;t, tap the chat
        button.
      </p>
      {(contacts.supportEmail || contacts.supportPhone) && (
        <p className="mt-6 text-sm text-cyan-100/50">
          Or{" "}
          {contacts.supportEmail && (
            <>
              email{" "}
              <a href={`mailto:${contacts.supportEmail}`} className="text-cyan-200 hover:text-cyan-100">
                {contacts.supportEmail}
              </a>
            </>
          )}
          {contacts.supportEmail && contacts.supportPhone && " or "}
          {contacts.supportPhone && (
            <>
              call{" "}
              <a href={`tel:${contacts.supportPhone.replace(/[^\d+]/g, "")}`} className="text-cyan-200 hover:text-cyan-100">
                {contacts.supportPhone}
              </a>
            </>
          )}
          .
        </p>
      )}
      {contacts.links.length > 0 && (
        <ul className="mt-4 flex flex-wrap justify-center gap-x-5 gap-y-2 text-sm">
          {contacts.links.map((l) => (
            <li key={l.url}>
              <a href={l.url} className="text-cyan-200 hover:text-cyan-100" rel="noopener noreferrer">
                {l.label}
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
