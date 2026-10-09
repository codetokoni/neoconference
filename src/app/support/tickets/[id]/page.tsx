import type { Metadata } from "next";
import TicketThread from "./TicketThread";

export const metadata: Metadata = { title: "Support ticket — NeoConference", robots: { index: false } };

// Signed in only (middleware); the API answers 404 for anyone else's ticket.
export default function TicketPage({ params }: { params: { id: string } }) {
  return (
    <section className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <TicketThread id={params.id} />
    </section>
  );
}
