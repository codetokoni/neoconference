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
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import ReplayShareBar from './ReplayShareBar';
import ReplayViewBumper from './ReplayViewBumper';
import { toPublicView, type PublicEventView } from '@/types/event';

export const dynamic = 'force-dynamic';

type Props = { params: { slug: string } };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = params;
  const ev = await eventStore.bySlug(slug);
  if (!ev) {
    return {
      title: 'Replay not found / NeoConference',
    };
  }
  const title = (ev.name || ev.slug) + ' / NeoConference replay';
  const description = ev.description
    ? ev.description.slice(0, 200)
    : 'Watch the recording, AI summary, chapters and transcript on NeoConference.';
  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: 'video.other',
      siteName: 'NeoConference',
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
    },
    robots: { index: true, follow: true },
  };
}

export default async function ReplayPage({ params }: Props) {
  const event = await eventStore.bySlug(params.slug);
  if (!event) return notFound();
  const view = toPublicView(event);
  const h = await headers();
  const proto = h.get("x-forwarded-proto") || "https";
  const host = h.get("x-forwarded-host") || h.get("host") || "neoconference.vercel.app";
  const replayUrl = `${proto}://${host}/e/${view.slug}/replay`;
  const replayShareTitle = (view.name || view.slug) + " replay";

  return <ReplayView view={view} replayUrl={replayUrl} replayShareTitle={replayShareTitle} />;
}

function ReplayView({ view, replayUrl, replayShareTitle }: { view: PublicEventView; replayUrl: string; replayShareTitle: string }) {
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
          <Link href="/" className="text-sm text-white/60 hover:text-white transition">â NeoConference</Link>
          <span className="text-[10px] sm:text-xs uppercase tracking-[0.3em] text-cyan-300/70">Replay</span>
        </div>

        <h1 className="text-3xl sm:text-4xl md:text-5xl font-semibold tracking-tight">{view.name}</h1>
        {view.ownerName && (
          <p className="mt-2 text-white/60 text-sm">Hosted by <span className="text-white/80">{view.ownerName}</span></p>
        )}
        {view.description && (
          <p className="mt-4 max-w-2xl text-white/70 text-sm sm:text-base whitespace-pre-line">{view.description}</p>
        )}

        <div className="mt-4">
          <ReplayShareBar url={replayUrl} title={replayShareTitle} />
          {(() => { const first = videos[0] || audios[0] || transcripts[0]; return first ? <ReplayViewBumper recordingKey={first.key} /> : null; })()}
        </div>

        <div className="mt-3 flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-white/45">
          {view.endedAt && <span>Ended {new Date(view.endedAt).toLocaleString()}</span>}
          {view.startedAt && view.endedAt && <span>Â·</span>}
          {view.startedAt && <span>Started {new Date(view.startedAt).toLocaleString()}</span>}
        </div>

        {/* HLS playback */}
        {view.hlsUrl && (
          <section className="mt-8 sm:mt-10 rounded-3xl border border-white/10 bg-black/60 backdrop-blur-xl overflow-hidden shadow-[0_0_60px_-20px_rgba(34,211,238,0.4)]">
            <div className="px-4 sm:px-5 py-3 border-b border-white/5 flex items-center gap-2">
              <span className="inline-flex h-1.5 w-1.5 rounded-full bg-cyan-300" />
              <span className="text-[11px] uppercase tracking-[0.22em] text-white/50">Live replay Â· HLS</span>
            </div>
            <video
              src={view.hlsUrl}
              controls
              playsInline
              data-replay-player="1"
              id="replay-video"
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
                      {rec.kind} Â· {new Date(rec.createdAt).toLocaleString()}
                    </div>
                  </div>
                  {/* Replay artifacts only persist the key, not signed URLs - reader can find via dashboard. */}
                  <span className="shrink-0 text-[11px] text-white/40">Sign in to download</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Chapters (AI-derived or manual) */}
        {Array.isArray(view.chapters) && view.chapters.length > 0 && (
          <section className="mt-8 sm:mt-10 rounded-3xl border border-cyan-400/20 bg-gradient-to-br from-cyan-500/[0.06] via-white/[0.02] to-transparent p-5 sm:p-6 md:p-8">
            <div className="flex items-center gap-2">
              <span className="inline-flex h-1.5 w-1.5 rounded-full bg-cyan-300 shadow-[0_0_8px_2px_rgba(34,211,238,0.7)]" />
              <h2 className="text-lg sm:text-xl font-semibold">Chapters</h2>
              <span className="ml-auto text-[10px] uppercase tracking-[0.22em] text-white/40">Tap to seek</span>
            </div>
            <p className="mt-1 text-white/55 text-xs">Auto-generated from the transcript. Click a chapter to jump in the player above.</p>
            <ol className="mt-4 grid sm:grid-cols-2 gap-2">
              {view.chapters.map((c, i) => {
                const h = Math.floor(c.startSec / 3600);
                const m = Math.floor((c.startSec % 3600) / 60);
                const s = c.startSec % 60;
                const pad = (n: number) => (n < 10 ? '0' + n : '' + n);
                const ts = h > 0 ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
                const sourceLabel = c.source === 'ai' ? 'AI Â· gpt-4o-mini' : c.source === 'manual' ? 'Host edit' : 'Auto Â· heuristic';
                return (
                  <li key={c.id || ('ch-' + i)}>
                    <a
                      href={'#t=' + c.startSec}
                      data-seek-sec={c.startSec}
                      className="group block w-full text-left rounded-xl border border-white/5 bg-black/30 hover:bg-cyan-400/[0.06] hover:border-cyan-300/30 transition-colors p-3"
                    >
                      <div className="flex items-start gap-3">
                        <span className="shrink-0 mt-0.5 inline-flex items-center justify-center h-6 min-w-[3rem] px-2 rounded-md bg-cyan-400/10 text-cyan-200 text-[11px] font-mono tabular-nums tracking-tight border border-cyan-300/20 group-hover:bg-cyan-400/20">
                          {ts}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium text-white/90 truncate">{c.label}</span>
                          {c.summary && (
                            <span className="block mt-0.5 text-[12px] text-white/55 line-clamp-2">{c.summary}</span>
                          )}
                          <span className="block mt-1 text-[10px] uppercase tracking-[0.18em] text-white/30">{sourceLabel}</span>
                        </span>
                      </div>
                    </a>
                  </li>
                );
              })}
            </ol>
            <script
              dangerouslySetInnerHTML={{
                __html: "(function(){function go(s){var v=document.getElementById('replay-video');if(v){v.currentTime=parseFloat(s)||0;v.play&&v.play().catch(function(){});window.scrollTo({top:v.getBoundingClientRect().top+window.scrollY-40,behavior:'smooth'});}}document.addEventListener('click',function(e){var t=e.target;while(t&&t!==document){if(t.dataset&&t.dataset.seekSec){e.preventDefault();go(t.dataset.seekSec);return;}t=t.parentNode;}});var h=location.hash;if(h&&h.indexOf('#t=')===0){go(h.slice(3));}})();"
              }}
            />
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
                  <div className="mt-2 text-[10px] text-white/30">{t.kind} Â· {new Date(t.createdAt).toLocaleString()}</div>
                </details>
              ))}
            </div>
          </section>
        )}

        {/* Empty state */}
        {!view.hlsUrl && videos.length === 0 && audios.length === 0 && transcripts.length === 0 && (
          <div className="mt-10 rounded-3xl border border-white/10 bg-white/[0.03] p-10 text-center text-white/55">
            <div className="text-4xl mb-3 opacity-40">Â·Â·Â·</div>
            <div>No replay artifacts yet for this event.</div>
            <div className="text-[11px] text-white/35 mt-1">Recording links and transcripts will appear here once processed.</div>
          </div>
        )}

        <div className="mt-10 text-center text-[11px] text-white/30 uppercase tracking-[0.22em]">
          Replay Â· NeoConference
        </div>
      </div>
    </main>
  );
}


