import type { Metadata } from "next";
import SessionManager from "@/components/SessionManager";

export const metadata: Metadata = {
  title: "Account & security — NeoConference",
};

export const dynamic = "force-dynamic";

export default function SettingsPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 sm:px-6 py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-cyan-100">
          Account &amp; security
        </h1>
        <p className="mt-1 text-sm text-zinc-400">
          Manage where you&apos;re signed in.
        </p>
      </header>

      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-medium text-cyan-100">Signed-in devices</h2>
          <p className="mt-1 text-sm text-zinc-400">
            You stay signed in on every device until you sign out. If you see a device
            you don&apos;t recognise, sign out everywhere and change your password.
          </p>
        </div>

        <SessionManager />
      </section>
    </div>
  );
}
