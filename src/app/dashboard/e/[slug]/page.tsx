// src/app/dashboard/e/[slug]/page.tsx
// Per-event admin page. Owner-only.
// Shows artifacts inline, allows ending the event, opening the room,
// and viewing the public replay/stream destination.

import { auth, currentUser } from "@clerk/nextjs/server";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { eventStore } from "@/lib/eventStore";
import EndEventButton from "./EndEventButton";

export const dynamic = "force-dynamic";

function fmt(iso?: string | number) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

function StatePill({ state }: { state: string }) {
  const map: Record<string, string> = {
    scheduled: "bg-slate-700/40 text-slate-200 border-slate-500/40",
    waiting:   "bg-amber-500/15 text-amber-200 border-amber-400/40",
    live:      "bg-rose-500/20 text-rose-200 border-rose-400/50 animate-pulse",
    ended:     "bg-slate-700/40 text-slate-300 border-slate-500/40",
    replay:    "bg-cyan-500/15 text-cyan-200 border-cyan-400/40",
    archived:  "bg-slate-800/60 text-slate-400 border-slate-600/40",
  };
  const cls = map[state] || map.scheduled;
  return (
    <span className={"inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-medium uppercase tracking-wide " + cls}>
      {state}
    </span>
  );
}
export default async function EventAdminPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const { userId } = await auth();
  if (!userId) redirect("/sign-in?redirect_url=/dashboard");

  const ev = await eventStore.bySlug(slug);
  if (!ev) notFound();

  if (ev.ownerUserId !== userId) {
    return (
      <main className="min-h-screen bg-[#05060a] text-slate-100 flex items-center justify-center p-8">
        <div className="max-w-md text-center space-y-4">
          <div className="text-5xl">⚠️</div>
          <h1 className="text-2xl font-semibold">Not your event</h1>
          <p className="text-slate-400 text-sm">
            Only the event owner can open this admin page. If you were given a join link, head to the public event page instead.
          </p>
          <Link href={"/e/" + ev.slug} className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-cyan-500/15 border border-cyan-400/40 text-cyan-200 hover:bg-cyan-500/25 transition">
            Public event page →
          </Link>
        </div>
      </main>
    );
  }

  const user = await currentUser();
  const me = user ? (user.firstName || user.username || user.emailAddresses[0]?.emailAddress || "you") : "you";

  const recordings = ev.recordings || [];
  const transcripts = recordings.filter((r) => r.kind === "transcript");
  const videos = recordings.filter((r) => r.kind !== "transcript");
  const liveOrWaiting = ev.state === "live" || ev.state === "waiting";

  return (
    <main className="min-h-screen bg-[#05060a] text-slate-100">
      <div className="max-w-6xl mx-auto px-6 py-10 space-y-10">

        {/* Header */}
        <header className="flex flex-wrap items-start justify-between gap-6">
          <div className="space-y-3">
            <Link href="/dashboard" className="text-xs text-slate-400 hover:text-cyan-300 transition">
              ← All events
            </Link>
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-3xl font-semibold tracking-tight">{ev.name}</h1>
              <StatePill state={ev.state} />
            </div>
            {ev.description ? (
              <p className="text-sm text-slate-400 max-w-2xl">{ev.description}</p>
            ) : null}
            <p className="text-xs text-slate-500 font-mono">
              /e/{ev.slug} · owner {me}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href={"/room/" + ev.livekitRoom + "?event=" + ev.slug} className="px-4 py-2 rounded-full bg-cyan-500 text-slate-950 font-medium hover:bg-cyan-400 transition">
              {liveOrWaiting ? "Open room →" : "Start room →"}
            </Link>
            <Link href={"/e/" + ev.slug} className="px-4 py-2 rounded-full border border-slate-700 hover:border-cyan-400 hover:text-cyan-200 transition text-sm">
              Public page
            </Link>
            {ev.state !== "ended" && ev.state !== "archived" ? (
              <EndEventButton eventId={ev.id} />
            ) : null}
          </div>
        </header>
        {/* Stat strip */}
        <section className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
            <div className="text-xs text-slate-500 uppercase tracking-wider">Recordings</div>
            <div className="text-2xl font-semibold mt-1">{videos.length}</div>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
            <div className="text-xs text-slate-500 uppercase tracking-wider">Transcripts</div>
            <div className="text-2xl font-semibold mt-1">{transcripts.length}</div>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
            <div className="text-xs text-slate-500 uppercase tracking-wider">Roles</div>
            <div className="text-2xl font-semibold mt-1">{(ev.roles || []).length}</div>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
            <div className="text-xs text-slate-500 uppercase tracking-wider">Waiting</div>
            <div className="text-2xl font-semibold mt-1">{(ev.waitingRoom || []).length}</div>
          </div>
        </section>

        {/* Timeline */}
        <section className="grid md:grid-cols-3 gap-3 text-sm">
          <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
            <div className="text-xs text-slate-500 uppercase tracking-wider mb-1">Scheduled</div>
            <div className="text-slate-200">{fmt(ev.scheduledAt)}</div>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
            <div className="text-xs text-slate-500 uppercase tracking-wider mb-1">Started</div>
            <div className="text-slate-200">{fmt(ev.startedAt)}</div>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
            <div className="text-xs text-slate-500 uppercase tracking-wider mb-1">Ended</div>
            <div className="text-slate-200">{fmt(ev.endedAt)}</div>
          </div>
        </section>

        {/* Streaming bindings */}
        {ev.streamlab || ev.hsmoh ? (
          <section className="space-y-3">
            <h2 className="text-sm uppercase tracking-widest text-slate-400">Streaming bindings</h2>
            <div className="grid md:grid-cols-2 gap-3 text-sm">
              {ev.streamlab ? (
                <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4 space-y-1">
                  <div className="text-xs text-cyan-300 uppercase tracking-wider">StreamLab</div>
                  <div className="text-slate-300 font-mono text-xs break-all">stream id {ev.streamlab.streamId}</div>
                  {ev.streamlab.hlsUrl ? (
                    <div className="text-slate-400 text-xs break-all">hls: {ev.streamlab.hlsUrl}</div>
                  ) : null}
                </div>
              ) : null}
              {ev.hsmoh ? (
                <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4 space-y-1">
                  <div className="text-xs text-cyan-300 uppercase tracking-wider">Shortlink</div>
                  <a href={ev.hsmoh.shortUrl} target="_blank" rel="noreferrer" className="text-cyan-200 hover:text-cyan-100 font-mono text-xs break-all">
                    {ev.hsmoh.shortUrl}
                  </a>
                  {ev.hsmoh.fallback ? (
                    <div className="text-amber-300/70 text-xs">using fallback /e/&lt;slug&gt;</div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </section>
        ) : null}
        {/* Recordings */}
        <section className="space-y-3">
          <h2 className="text-sm uppercase tracking-widest text-slate-400">Recordings</h2>
          {videos.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-800 bg-slate-900/20 p-6 text-sm text-slate-500">
              No recordings yet. Hit Record from inside the room to capture a take.
            </div>
          ) : (
            <ul className="grid gap-2">
              {videos.map((r) => (
                <li key={r.key} className="rounded-xl border border-slate-800 bg-slate-900/40 p-3 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm text-slate-200 truncate font-mono">{r.key.split("/").pop()}</div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      {r.kind.toUpperCase()} · {fmt(r.createdAt)}{r.size ? " · " + Math.round(r.size / 1024) + " KB" : ""}
                    </div>
                  </div>
                  <Link href={"/e/" + ev.slug + "/replay"} className="text-xs px-3 py-1.5 rounded-full border border-slate-700 hover:border-cyan-400 hover:text-cyan-200 transition shrink-0">
                    Open replay
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Transcripts */}
        {transcripts.length > 0 ? (
          <section className="space-y-3">
            <h2 className="text-sm uppercase tracking-widest text-slate-400">Transcripts</h2>
            <ul className="grid gap-2">
              {transcripts.map((t, i) => (
                <li key={i} className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
                  <div className="text-xs text-slate-500 mb-2">{fmt(t.createdAt)}</div>
                  <p className="text-sm text-slate-200 leading-relaxed line-clamp-6 whitespace-pre-wrap">
                    {t.label || "(empty transcript)"}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* Roles */}
        <section className="space-y-3">
          <h2 className="text-sm uppercase tracking-widest text-slate-400">Roles</h2>
          {(ev.roles || []).length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-800 bg-slate-900/20 p-6 text-sm text-slate-500">
              No roles assigned yet. Anyone with the link joins as a viewer.
            </div>
          ) : (
            <ul className="grid gap-2">
              {(ev.roles || []).map((r, i) => (
                <li key={i} className="rounded-xl border border-slate-800 bg-slate-900/40 p-3 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm text-slate-200 truncate">{r.label || r.identifier}</div>
                    <div className="text-xs text-slate-500 mt-0.5 font-mono truncate">{r.identifier}</div>
                  </div>
                  <span className="text-xs px-2.5 py-1 rounded-full bg-slate-800/60 border border-slate-700 text-slate-300 uppercase tracking-wide shrink-0">
                    {r.role}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Waiting room */}
        {(ev.waitingRoom || []).length > 0 ? (
          <section className="space-y-3">
            <h2 className="text-sm uppercase tracking-widest text-slate-400">Waiting room</h2>
            <ul className="grid gap-2">
              {(ev.waitingRoom || []).map((w) => (
                <li key={w.id} className="rounded-xl border border-slate-800 bg-slate-900/40 p-3 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm text-slate-200 truncate">{w.name}</div>
                    <div className="text-xs text-slate-500 mt-0.5">{fmt(w.requestedAt)}</div>
                  </div>
                  <span className="text-xs px-2.5 py-1 rounded-full bg-amber-500/15 border border-amber-400/40 text-amber-200 uppercase tracking-wide shrink-0">
                    {w.status}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <footer className="pt-6 border-t border-slate-900 text-xs text-slate-600">
          updated {fmt(ev.updatedAt)} · created {fmt(ev.createdAt)}
        </footer>
      </div>
    </main>
  );
}
