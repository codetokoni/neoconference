// src/app/embed/[slug]/page.tsx
// Public embeddable widget for an event.
// Renders a chromeless HLS player when the event is live or has a replay,
// otherwise shows a clean countdown + scheduled-time card.
// Use as: <iframe src="https://neoconference.vercel.app/embed/<slug>" allow="autoplay; fullscreen" />

import Link from "next/link";
import { eventStore } from "@/lib/eventStore";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";
export const revalidate = 30;

// Embeds opt out of X-Frame-Options/CSP frame-ancestors in middleware.ts.
// (App-router pages cannot set those headers; middleware whitelists /embed/.).

function pickHls(ev: { recordings?: Array<{ kind: string; key: string; label?: string }>; streamlab?: { hlsUrl?: string } }) {
  if (ev.streamlab && ev.streamlab.hlsUrl) return ev.streamlab.hlsUrl;
  const r = (ev.recordings || []).find((x) => x.kind === "hls");
  if (r && r.label) return r.label;
  return null;
}

function fmt(iso?: string) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
export default async function EmbedPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ev = await eventStore.bySlug(slug);
  if (!ev || ev.visibility === "private") notFound();

  const hls = pickHls(ev as any);
  const isLive = ev.state === "live" && hls;
  const isReplay = (ev.state === "replay" || ev.state === "ended") && hls;

  return (
    <html lang="en">
      <body className="m-0 bg-black text-slate-100 overflow-hidden">
        <div className="w-screen h-screen relative">
          {isLive || isReplay ? (
            <video
              src={hls!}
              controls
              playsInline
              autoPlay={isLive}
              muted={isLive}
              className="w-full h-full bg-black"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-center px-6">
              <div className="space-y-3 max-w-sm">
                <div
                  className="aspect-square w-20 mx-auto rounded-2xl"
                  style={{ background: "linear-gradient(135deg,#06b6d4 0%,#0e7490 100%)" }}
                />
                <h1 className="text-xl font-semibold tracking-tight">{ev.name}</h1>
                {ev.scheduledAt ? (
                  <p className="text-sm text-slate-300">Starts {fmt(ev.scheduledAt)}</p>
                ) : (
                  <p className="text-sm text-slate-400">Not yet started</p>
                )}
                <Link
                  href={"/e/" + ev.slug}
                  target="_top"
                  className="inline-flex mt-2 items-center gap-2 px-4 py-2 rounded-full bg-cyan-500 text-slate-950 font-medium hover:bg-cyan-400 transition text-sm"
                >
                  Open event →
                </Link>
              </div>
            </div>
          )}
          <div className="absolute top-3 left-3 flex items-center gap-2 pointer-events-none">
            {isLive ? (
              <span className="px-2 py-0.5 rounded-full bg-rose-500/30 text-rose-100 border border-rose-300/50 text-[10px] uppercase tracking-wider animate-pulse">
                Live
              </span>
            ) : null}
          </div>
          <Link
            href={"/e/" + ev.slug}
            target="_top"
            className="absolute bottom-3 right-3 text-[10px] uppercase tracking-wider text-slate-300/80 hover:text-cyan-200 transition bg-black/40 px-2 py-1 rounded backdrop-blur-sm"
          >
            NeoConference
          </Link>
        </div>
      </body>
    </html>
  );
}
