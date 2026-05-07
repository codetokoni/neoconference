// src/app/e/[slug]/replay/page.tsx
//
// Public replay page for an ended NeoEvent. Renders:
//   - Event title + description + presenter
//   - HLS playback (when streamlab.hlsUrl is set)
//   - Recording downloads + transcript artifacts
//
// Uses PublicEventView so secrets (passwords, RTMP keys) are stripped.

import { notFound } from 'next/navigation';
import Link from 'next/link';
import { eventStore } from '@/lib/eventStore';
import { toPublicView, type PublicEventView } from '@/types/event';

export const dynamic = 'force-dynamic';

type Props = { params: { slug: string } };

export default async function ReplayPage({ params }: Props) {
  const event = await eventStore.bySlug(params.slug);
  if (!event) return notFound();
  const view = toPublicView(event);

  return <ReplayView view={view} />;
}

function ReplayView({ view }: { view: PublicEventView }) {
  const recordings = view.recordings || [];
  const transcripts = recordings.filter((r) => r.kind === 'transcript');
  const videos = recordings.filter((r) => r.kind === 'mp4' || r.kind === 'hls');
  const audios = recordings.filter((r) => r.kind === 'audio');

  return (
    <main className="min-h-screen bg-[#05070d] text-white relative overflow-hidden">
      <div className="pointer-events-none absolute inset-0 opacity-50">
        <div className="absolute -top-40 -left-40 h-[480px] w-[480px] rounded-full bg-cyan-500/15 blur-[120px]" />
        <div className="absolute bottom-0 right-0 h-[420px] w-[420px] rounded-full bg-fuchsia-500/10 blur-[120px]" />
      </div>

      <div className="relative mx-auto max-w-5xl px-4 sm:px-6 py-10 md:py-16">
        <div className="mb-6 sm:mb-8 flex items-center justify-between gap-4">
          <Link href="/" className="text-sm text-white/60 hover:text-white transition">← NeoConference</Link>
          <span className="text-[10px] sm:text-xs uppercase tracking-[0.3em] text-cyan-300/70">Replay</span>
        </div>

        <h1 className="text-3xl sm:text-4xl md:text-5xl font-semibold tracking-tight">{view.name}</h1>
        {view.ownerName && (
          <p className="mt-2 text-white/60 text-sm">Hosted by <span className="text-white/80">{view.ownerName}</span></p>
        )}
        {view.description && (
          <p className="mt-4 max-w-2xl text-white/70 text-sm sm:text-base whitespace-pre-line">{view.description}</p>
        )}

        <div className="mt-3 flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-white/45">
          {view.endedAt && <span>Ended {new Date(view.endedAt).toLocaleString()}</span>}
          {view.startedAt && view.endedAt && <span>·</span>}
          {view.startedAt && <span>Started {new Date(view.startedAt).toLocaleString()}</span>}
        </div>

        {/* HLS playback */}
        {view.hlsUrl && (
          <section className="mt-8 sm:mt-10 rounded-3xl border border-white/10 bg-black/60 backdrop-blur-xl overflow-hidden shadow-[0_0_60px_-20px_rgba(34,211,238,0.4)]">
            <div className="px-4 sm:px-5 py-3 border-b border-white/5 flex items-center gap-2">
              <span className="inline-flex h-1.5 w-1.5 rounded-full bg-cyan-300" />
              <span className="text-[11px] uppercase tracking-[0.22em] text-white/50">Live replay · HLS</span>
            </div>
            <video
              src={view.hlsUrl}
              controls
              playsInline
              className="w-full aspect-video bg-black"
            />
          </section>
        )}

        {/* Recordings */}
        {(videos.length > 0 || audios.length > 0) && (
          <section className="mt-8 sm:mt-10 rounded-3xl border border-white/10 bg-white/[0.03] backdrop-blur-xl p-5 sm:p-6 md:p-8">
            <h2 className="text-lg sm:text-xl font-semibold">Recordings</h2>
            <ul className="mt-4 space-y-3">
              {[...videos, ...audios].map((rec, i) => (
                <li key={rec.key + ':' + i} className="flex items-center justify-between gap-3 rounded-xl border border-white/5 bg-black/30 px-4 py-3 text-sm">
                  <div className="min-w-0">
                    <div className="font-mono text-white/85 truncate" title={rec.key}>{rec.label || rec.key}</div>
                    <div className="text-[10px] text-white/40 mt-0.5 uppercase tracking-[0.18em]">
                      {rec.kind} · {new Date(rec.createdAt).toLocaleString()}
                    </div>
                  </div>
                  {/* Replay artifacts only persist the key, not signed URLs - reader can find via dashboard. */}
                  <span className="shrink-0 text-[11px] text-white/40">Sign in to download</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Transcripts */}
        {transcripts.length > 0 && (
          <section className="mt-8 sm:mt-10 rounded-3xl border border-fuchsia-400/20 bg-gradient-to-br from-fuchsia-500/[0.05] to-transparent p-5 sm:p-6 md:p-8">
            <div className="flex items-center gap-2">
              <span className="inline-flex h-1.5 w-1.5 rounded-full bg-fuchsia-300 shadow-[0_0_8px_2px_rgba(232,121,249,0.7)]" />
              <h2 className="text-lg sm:text-xl font-semibold">AI transcripts</h2>
            </div>
            <p className="mt-1 text-white/55 text-xs">Auto-generated. Times are approximate.</p>
            <div className="mt-4 space-y-3">
              {transcripts.map((t, i) => (
                <details key={t.key + ':' + i} className="group rounded-xl border border-white/5 bg-black/30 p-4 text-sm">
                  <summary className="cursor-pointer list-none flex items-center justify-between gap-3">
                    <span className="font-medium text-white/90">{t.label || 'Transcript ' + (i + 1)}</span>
                    <span className="text-[11px] text-white/40 group-open:hidden">View</span>
                    <span className="text-[11px] text-white/40 hidden group-open:inline">Hide</span>
                  </summary>
                  <pre className="mt-3 text-xs text-white/75 whitespace-pre-wrap break-words leading-relaxed">{t.label || ''}</pre>
                  <div className="mt-2 text-[10px] text-white/30">{t.kind} · {new Date(t.createdAt).toLocaleString()}</div>
                </details>
              ))}
            </div>
          </section>
        )}

        {/* Empty state */}
        {!view.hlsUrl && videos.length === 0 && audios.length === 0 && transcripts.length === 0 && (
          <div className="mt-10 rounded-3xl border border-white/10 bg-white/[0.03] p-10 text-center text-white/55">
            <div className="text-4xl mb-3 opacity-40">···</div>
            <div>No replay artifacts yet for this event.</div>
            <div className="text-[11px] text-white/35 mt-1">Recording links and transcripts will appear here once processed.</div>
          </div>
        )}

        <div className="mt-10 text-center text-[11px] text-white/30 uppercase tracking-[0.22em]">
          Replay · NeoConference
        </div>
      </div>
    </main>
  );
}
