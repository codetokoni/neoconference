import type { Metadata } from "next";
import MyTickets from "./MyTickets";

export const metadata: Metadata = { title: "My tickets — NeoConference", robots: { index: false } };

// Signed in only (middleware): the user's support requests.
export default function MyTicketsPage() {
  return (
    <section className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <MyTickets />
    </section>
  );
}
