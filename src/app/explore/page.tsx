// src/app/explore/page.tsx
// Public discovery feed of NeoEvents.
// Lists all events whose visibility is "public".
// Replay-ready events float to the top.

import Link from "next/link";
import { eventStore } from "@/lib/eventStore";
import type { NeoEvent } from "@/types/event";

export const dynamic = "force-dynamic";
export const revalidate = 30;

function gradientFor(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const a = h % 360;
  const b = (a + 60) % 360;
  return "linear-gradient(135deg, hsl(" + a + " 80% 28%) 0%, hsl(" + b + " 75% 18%) 100%)";
}

function fmt(iso?: string | number) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function rankWeight(ev: NeoEvent) {
  if (ev.state === "live") return 0;
  if (ev.state === "waiting") return 1;
  if (ev.state === "replay") return 2;
  if (ev.state === "scheduled") return 3;
  if (ev.state === "ended") return 4;
  return 5;
}
export default async function ExplorePage() {
  const all = await eventStore.listAll(200);
  const list = all
    .filter((e) => e.visibility === "public" && e.state !== "archived")
    .sort((a, b) => {
      const w = rankWeight(a) - rankWeight(b);
      if (w !== 0) return w;
      return (b.updatedAt || "").localeCompare(a.updatedAt || "");
    });

  return (
    <main className="min-h-screen bg-[#05060a] text-slate-100">
      <div className="max-w-6xl mx-auto px-6 py-12 space-y-10">
        <header className="flex items-end justify-between flex-wrap gap-4">
          <div className="space-y-2">
            <p className="text-xs uppercase tracking-[0.2em] text-cyan-300">Explore</p>
            <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight">Public events on NeoConference</h1>
            <p className="text-slate-400 text-sm max-w-2xl">
              Live broadcasts, scheduled keynotes, and on-demand replays from creators around the world.
            </p>
          </div>
          <Link href="/" className="text-xs text-slate-400 hover:text-cyan-300 transition">
            ← Home
          </Link>
        </header>

        {list.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-800 bg-slate-900/30 p-10 text-center">
            <div className="text-5xl mb-3">🌌</div>
            <h2 className="text-lg font-semibold">No public events yet</h2>
            <p className="text-slate-400 text-sm mt-1">Be the first to host one.</p>
            <Link href="/dashboard/new" className="inline-flex mt-4 items-center gap-2 px-4 py-2 rounded-full bg-cyan-500 text-slate-950 font-medium hover:bg-cyan-400 transition">
              Create event →
            </Link>
          </div>
        ) : (
          <ul className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {list.map((ev) => (
              <li key={ev.id} className="group rounded-2xl overflow-hidden border border-slate-800 bg-slate-900/40 hover:border-cyan-400/40 transition">
                <Link href={"/e/" + ev.slug} className="block">
                  <div
                    className="aspect-[16/9] relative"
                    style={{ background: gradientFor(ev.qrSeed || ev.slug) }}
                  >
                    <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
                    <div className="absolute top-3 left-3 flex items-center gap-2">
                      <span className={"px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wider border " + (ev.state === "live"
                        ? "bg-rose-500/30 text-rose-100 border-rose-300/50 animate-pulse"
                        : ev.state === "waiting"
                        ? "bg-amber-500/25 text-amber-100 border-amber-300/40"
                        : ev.state === "replay"
                        ? "bg-cyan-500/25 text-cyan-100 border-cyan-300/40"
                        : "bg-slate-800/70 text-slate-200 border-slate-500/40")}>
                        {ev.state}
                      </span>
                    </div>
                    <div className="absolute bottom-3 left-3 right-3">
                      <h3 className="text-lg font-semibold tracking-tight line-clamp-2">{ev.name}</h3>
                      {ev.scheduledAt ? (
                        <p className="text-xs text-slate-300 mt-1">{fmt(ev.scheduledAt)}</p>
                      ) : null}
                    </div>
                  </div>
                  <div className="px-4 py-3 flex items-center justify-between text-xs text-slate-400">
                    <span>
                      {(ev.recordings || []).filter((r) => r.kind !== "transcript").length} recording{(ev.recordings || []).filter((r) => r.kind !== "transcript").length === 1 ? "" : "s"}
                    </span>
                    <span className="text-cyan-300 group-hover:text-cyan-200 transition">
                      Open →
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}

        <footer className="pt-8 border-t border-slate-900 text-xs text-slate-600">
          {list.length} public event{list.length === 1 ? "" : "s"} · updated live
        </footer>
      </div>
    </main>
  );
}
