import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import HomeHeroCTAs from "./HomeHeroCTAs";
import HomeFinalCTAs from "./HomeFinalCTAs";
import { CAPTION_LOCALES } from "@/lib/locales";

export default async function Home() {
  const { userId } = await auth();
  const signedIn = !!userId;

  return (
    <div className="relative overflow-hidden">
      {/* Animated background orbs */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute -top-40 -left-32 h-[34rem] w-[34rem] rounded-full bg-cyan-500/20 blur-3xl animate-orb" />
        <div className="absolute top-20 -right-32 h-[28rem] w-[28rem] rounded-full bg-indigo-500/20 blur-3xl animate-orb" style={{ animationDelay: "-6s" }} />
        <div className="absolute bottom-0 left-1/2 -translate-x-1/2 h-[32rem] w-[32rem] rounded-full bg-sky-400/10 blur-3xl animate-orb" style={{ animationDelay: "-3s" }} />
        <div className="absolute inset-0 neo-grid-bg opacity-60" />
      </div>

      {/* HERO */}
      <section className="relative mx-auto max-w-7xl px-6 pt-16 sm:pt-24 lg:pt-28 pb-16 sm:pb-24">
        <div className="grid lg:grid-cols-12 gap-12 items-center">
          <div className="lg:col-span-7 animate-fade-up">
            <div className="inline-flex items-center gap-2 rounded-full neo-glass px-3 py-1 text-xs text-cyan-200/90">
              <span className="relative inline-flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75 animate-ping" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-cyan-300" />
              </span>
              Live translation · {TRANSLATION_LANGUAGES.length} languages
            </div>

            <h1 className="mt-6 text-5xl sm:text-6xl lg:text-7xl font-bold tracking-tight leading-[1.05]">
              <span className="text-white/90">One meeting.</span>
              <br />
              <span className="neo-gradient-text neo-text-glow">Every language.</span>
            </h1>

            <p className="mt-6 max-w-xl text-lg text-cyan-100/70 leading-relaxed">
              NeoConference translates your meetings live. Everyone picks their own language and
              hears each speaker in it, spoken aloud as they talk, with the original voice quietly
              underneath. On the web and in the Android app.
            </p>

            <div className="mt-8 flex flex-col sm:flex-row gap-3 sm:items-center">
              <HomeHeroCTAs signedIn={signedIn} />
            </div>

            <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-cyan-100/50">
              <a href="#live-translation" className="flex items-center gap-2 text-cyan-200/80 hover:text-cyan-100"><span className="text-cyan-300">✓</span> Live translation</a>
              <div className="flex items-center gap-2"><span className="text-cyan-300">✓</span> No downloads</div>
              <div className="flex items-center gap-2"><span className="text-cyan-300">✓</span> Encrypted in transit</div>
              <div className="hidden sm:flex items-center gap-2"><span className="text-cyan-300">✓</span> HD recording</div>
            </div>
          </div>

          {/* Floating preview card */}
          <div className="lg:col-span-5 animate-fade-up" style={{ animationDelay: "120ms" }}>
            <div className="relative">
              <div className="absolute -inset-6 bg-gradient-to-br from-cyan-400/30 via-sky-400/20 to-indigo-500/20 blur-2xl rounded-[2rem]" />
              <div className="relative neo-card neo-border-glow p-3 animate-float">
                <div className="rounded-2xl overflow-hidden bg-[#06101e] aspect-[4/3] relative">
                  <div className="absolute inset-0 grid grid-cols-2 grid-rows-2 gap-1.5 p-1.5">
                    <Tile name="Aria" hue="from-cyan-400/35 to-sky-500/20" speaking />
                    <Tile name="Marcus" hue="from-indigo-400/30 to-fuchsia-500/15" />
                    <Tile name="Sofia" hue="from-emerald-400/30 to-cyan-500/15" />
                    <Tile name="You" hue="from-rose-400/25 to-orange-500/15" muted />
                  </div>
                  {/* Floating dock */}
                  <div className="absolute bottom-3 left-1/2 -translate-x-1/2 neo-glass rounded-full px-3 py-1.5 flex items-center gap-2 text-cyan-100">
                    <DockBtn label="mic" />
                    <DockBtn label="cam" />
                    <DockBtn label="share" />
                    <DockBtn label="end" danger />
                  </div>
                  {/* Live counter */}
                  <div className="absolute top-3 left-3 neo-glass rounded-full px-2.5 py-1 text-[11px] text-cyan-100 flex items-center gap-1.5">
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-cyan-300 text-cyan-300 neo-pulse-dot" />
                    4 in room
                  </div>
                  <div className="absolute top-3 right-3 neo-glass rounded-full px-2.5 py-1 text-[11px] text-rose-200 flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-full bg-rose-400 animate-pulse" />
                    REC
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Trusted strip */}
      <section className="relative mx-auto max-w-7xl px-6 pb-12">
        <p className="text-center text-xs uppercase tracking-[0.2em] text-cyan-100/40">Built on world-class real-time infrastructure</p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-x-10 gap-y-3 text-cyan-100/55 text-sm">
          <span>LiveKit</span><span>WebRTC</span><span>Cloudflare R2</span><span>Next.js</span><span>Clerk</span><span>Vercel Edge</span>
        </div>
      </section>

      {/* Showcase strip */}
      <section className="relative mx-auto max-w-7xl px-6 pt-6 pb-12">
        <div className="grid gap-5 sm:grid-cols-3">
          {/* Each card says only what the product does today, in words a
              visitor uses. Recording is plan-gated (planLimits.recording),
              so the card says so. */}
          <ShowcaseCard
            badge="Record"
            title="Recordings, transcripts and summaries"
            desc="Record the meeting, then get a written transcript and an AI summary of what was said. Recording is on Pro and above."
            href="/dashboard"
          />
          <ShowcaseCard
            badge="Host"
            title="You stay in control"
            desc="Let people in from the waiting room, add hosts and cohosts by their KingsChat handle, and mute or remove anyone."
            href="/dashboard/new"
          />
          <ShowcaseCard
            badge="Share"
            title="One link, a QR code and the app"
            desc="Every meeting gets a short link and a QR code to print or share. On Android, the link opens straight in the NeoConference app."
            href="/dashboard/new"
          />
        </div>
      </section>

      {/* Live translation */}
      <section id="live-translation" className="relative mx-auto max-w-7xl px-6 py-16 scroll-mt-20">
        <div className="relative neo-card neo-border-glow p-8 sm:p-12 overflow-hidden">
          <div aria-hidden className="absolute -top-24 -right-24 h-72 w-72 rounded-full bg-cyan-400/20 blur-3xl -z-10" />
          <div className="grid lg:grid-cols-12 gap-10 items-center">
            <div className="lg:col-span-7">
              <div className="inline-flex items-center gap-2 rounded-full neo-glass px-3 py-1 text-xs text-cyan-200/90">
                <IconTranslate /> Live translation
              </div>
              <h2 className="mt-5 text-3xl sm:text-4xl font-semibold text-white tracking-tight">
                Hear every speaker <span className="neo-gradient-text">in your own language.</span>
              </h2>
              <p className="mt-4 text-cyan-100/70 leading-relaxed max-w-xl">
                Pick your language and NeoConference speaks each speaker&apos;s words to you in it while
                they talk. The original voice keeps playing quietly underneath, so you still hear the
                speaker and the room. Everyone chooses their own language — one meeting, many languages.
              </p>
              <ol className="mt-7 space-y-3 text-sm text-cyan-100/75">
                <Step n={1}>The host turns on <strong className="text-white">Captions</strong> in the meeting.</Step>
                <Step n={2}>Pick your language under <strong className="text-white">Translate</strong> — in the app, <strong className="text-white">Live translation</strong> in the More menu.</Step>
                <Step n={3}>Listen. The translation is spoken aloud; in the NeoConference app it is shown on screen too.</Step>
              </ol>
              <p className="mt-6 text-xs text-cyan-100/45">
                Works in the browser and in the NeoConference app for Android.
              </p>
            </div>

            <div className="lg:col-span-5">
              <div className="rounded-2xl bg-[#06101e] border border-white/5 p-4 space-y-3">
                <div className="neo-glass rounded-xl p-3">
                  <div className="text-[11px] text-cyan-200/70">Aria · speaking English</div>
                  <div className="mt-1 text-sm text-white/90">&ldquo;Welcome, everyone. Let&apos;s begin.&rdquo;</div>
                </div>
                <div className="rounded-xl p-3 border border-cyan-300/30 bg-cyan-400/10">
                  <div className="text-[11px] text-cyan-200 flex items-center gap-1.5">
                    <IconSpeaker /> You hear · Español
                  </div>
                  <div className="mt-1 text-sm text-white">&ldquo;Bienvenidos a todos. Comencemos.&rdquo;</div>
                </div>
                <div className="rounded-xl p-3 border border-white/10 bg-white/[0.03]">
                  <div className="text-[11px] text-cyan-200/70 flex items-center gap-1.5">
                    <IconSpeaker /> Someone else hears · Français
                  </div>
                  <div className="mt-1 text-sm text-white/85">&ldquo;Bienvenue à tous. Commençons.&rdquo;</div>
                </div>
              </div>
              <div className="mt-5">
                <div className="text-[11px] uppercase tracking-[0.18em] text-cyan-100/45">
                  {TRANSLATION_LANGUAGES.length} languages
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {TRANSLATION_LANGUAGES.map((l) => (
                    <span key={l} className="rounded-full neo-glass px-2.5 py-0.5 text-xs text-cyan-100/80">{l}</span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="relative mx-auto max-w-7xl px-6 py-20">
        <div className="max-w-2xl">
          <h2 className="text-3xl sm:text-4xl font-semibold text-white tracking-tight">Designed for the next decade of meetings.</h2>
          <p className="mt-3 text-cyan-100/65">A futuristic interface, premium controls, and a focus on the only thing that matters — your conversation.</p>
        </div>
        <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          <Feature title="Instant rooms" desc="Spin up a secure room in one click. Share a link, your guests just join — no installs." icon={<IconBolt />} />
          <Feature title="Clear audio" desc="Echo cancellation and noise suppression keep voices clear, and video adjusts to each person's connection." icon={<IconWave />} />
          <Feature title="HD recording" desc="One tap to record. Files are kept in secure cloud storage to download any time. On Pro and above." icon={<IconRec />} />
          <Feature title="Live participants" desc="Real-time roster with active speaker highlighting and presence dots." icon={<IconUsers />} />
          <Feature title="On your phone" desc="Works in any phone browser, and the NeoConference app for Android opens meeting links straight in the app." icon={<IconPhone />} />
          <Feature title="Sign in with KingsChat" desc="Use your KingsChat account to sign in, and add hosts and cohosts by their KingsChat handle." icon={<IconSpark />} />
        </div>
      </section>

      {/* Final CTA */}
      <section className="relative mx-auto max-w-5xl px-6 pb-24">
        <div className="relative neo-card neo-border-glow p-10 sm:p-14 text-center overflow-hidden">
          <div aria-hidden className="absolute inset-0 -z-10 opacity-60">
            <div className="absolute inset-0 neo-grid-bg" />
            <div className="absolute -top-20 left-1/2 -translate-x-1/2 h-72 w-[40rem] rounded-full bg-cyan-400/20 blur-3xl" />
          </div>
          <h3 className="text-3xl sm:text-4xl font-semibold text-white tracking-tight">Your next meeting is one click away.</h3>
          <p className="mt-3 text-cyan-100/70">Create a room, share the link, and bring everyone into a beautifully designed space.</p>
          <div className="mt-8 flex flex-col sm:flex-row gap-3 justify-center">
            <HomeFinalCTAs signedIn={signedIn} />
          </div>
        </div>
      </section>

        <footer className="relative mx-auto max-w-7xl px-6 pb-10 text-center text-xs text-cyan-100/35">
          <div className="mb-4 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-cyan-100/50">
            <Link href="/docs" className="hover:text-cyan-200 transition-colors">Docs</Link>
            <Link href="/openapi.json" className="hover:text-cyan-200 transition-colors">API Reference</Link>
            <Link href="/pricing" className="hover:text-cyan-200 transition-colors">Pricing</Link>
            <Link href="/dashboard/developers" className="hover:text-cyan-200 transition-colors">Developers</Link>
          </div>
          © {new Date().getFullYear()} NeoConference — Crafted for premium real-time experiences.
        </footer>
    </div>
  );
}

function ShowcaseCard({ badge, title, desc, href }: { badge: string; title: string; desc: string; href: string }) {
  return (
    <Link href={href} className="group relative neo-card neo-border-glow p-5 transition-transform duration-300 hover:-translate-y-1 block">
      <div className="inline-flex items-center gap-2 rounded-full neo-glass px-2.5 py-0.5 text-[10px] uppercase tracking-[0.18em] text-cyan-200/90">{badge}</div>
      <h3 className="mt-4 text-lg font-semibold text-white">{title}</h3>
      <p className="mt-1.5 text-sm text-cyan-100/65 leading-relaxed">{desc}</p>
      <div className="mt-4 inline-flex items-center gap-1.5 text-xs text-cyan-200/80 group-hover:text-cyan-100">Explore →</div>
    </Link>
  );
}

function Tile({ name, hue, speaking, muted }: { name: string; hue: string; speaking?: boolean; muted?: boolean }) {
  return (
    <div className={"relative rounded-xl overflow-hidden bg-gradient-to-br " + hue + " border border-white/5"}>
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(255,255,255,0.06),transparent_60%)]" />
      <div className="absolute bottom-1.5 left-1.5 flex items-center gap-1.5">
        <div className="px-2 py-0.5 rounded-md text-[10px] bg-black/40 text-white/90 backdrop-blur-md">{name}</div>
        {muted && <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-rose-500/30 text-rose-100">muted</span>}
      </div>
      {speaking && <div className="absolute inset-0 ring-2 ring-cyan-300/70 rounded-xl shadow-[0_0_30px_rgba(34,211,238,0.45)] animate-pulse" />}
    </div>
  );
}

function DockBtn({ label, danger }: { label: string; danger?: boolean }) {
  return (
    <span className={"inline-flex items-center justify-center h-7 w-7 rounded-full text-[10px] " + (danger ? "bg-rose-500/80 text-white" : "bg-white/10 text-cyan-100")}>{label[0].toUpperCase()}</span>
  );
}

function Feature({ title, desc, icon }: { title: string; desc: string; icon: React.ReactNode }) {
  return (
    <div className="group relative neo-card neo-border-glow p-6 transition-transform duration-300 hover:-translate-y-1">
      <div className="h-11 w-11 rounded-xl bg-cyan-400/10 text-cyan-300 flex items-center justify-center border border-cyan-300/20 shadow-[0_0_24px_rgba(34,211,238,0.15)]">{icon}</div>
      <h3 className="mt-5 text-lg font-semibold text-white">{title}</h3>
      <p className="mt-2 text-sm text-cyan-100/65 leading-relaxed">{desc}</p>
    </div>
  );
}

/**
 * What live translation can speak, by each language's own name. The same
 * list the room's Translate picker offers: the caption locales DeepL can
 * translate into (src/components/LiveTranslation.tsx drops Hindi and Arabic).
 */
const TRANSLATION_LANGUAGES = CAPTION_LOCALES
  .filter((l) => l.code !== "auto" && l.code !== "hi" && l.code !== "ar")
  .map((l) => l.native);

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-cyan-400/15 border border-cyan-300/30 text-xs text-cyan-200">{n}</span>
      <span>{children}</span>
    </li>
  );
}

function IconTranslate(){return(<svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/></svg>);}
function IconSpeaker(){return(<svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a10 10 0 0 1 0 14"/></svg>);}
function IconBolt(){return(<svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/></svg>);}
function IconWave(){return(<svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 12h2m4 0h2m4 0h2m4 0h2"/><path d="M5 8v8m4-12v16m4-13v10m4-7v4"/></svg>);}
function IconRec(){return(<svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor"><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2"/></svg>);}
function IconUsers(){return(<svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor"><path d="M16 11a4 4 0 1 0-4-4 4 4 0 0 0 4 4Zm-8 0a4 4 0 1 0-4-4 4 4 0 0 0 4 4Zm0 2c-3 0-8 1.5-8 4.5V20h10v-2.5c0-1.1.4-2 1-2.7C9.5 13.3 8.7 13 8 13Zm8 0c-.7 0-1.5.3-2.4.7.6.7 1 1.6 1 2.7V20h9v-2.5C23.6 14.5 18.6 13 16 13Z"/></svg>);}
function IconPhone(){return(<svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="6" y="2" width="12" height="20" rx="3"/><path d="M11 18h2"/></svg>);}
function IconSpark(){return(<svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor"><path d="M12 2 14 9l7 2-7 2-2 7-2-7-7-2 7-2 2-7Z"/></svg>);}
