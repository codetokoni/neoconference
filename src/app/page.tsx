"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { SignedIn, SignedOut, SignInButton, SignUpButton } from "@clerk/nextjs";

function randomRoomName() {
  const adj = ["nova", "lumen", "orbit", "nimbus", "pulse", "vortex", "atlas", "aurora", "echo", "zenith"];
  const a = adj[Math.floor(Math.random() * adj.length)];
  const n = Math.random().toString(36).slice(2, 6);
  return a + "-" + n;
}

export default function Home() {
  const router = useRouter();
  const [join, setJoin] = useState("");

  const startNew = () => router.push("/room/" + randomRoomName());
  const joinNamed = () => {
    const v = join.trim();
    if (!v) return;
    router.push("/room/" + encodeURIComponent(v));
  };

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
              Live · Real-time HD video for everyone
            </div>

            <h1 className="mt-6 text-5xl sm:text-6xl lg:text-7xl font-bold tracking-tight leading-[1.05]">
              <span className="text-white/90">Meetings reimagined.</span>
              <br />
              <span className="neo-gradient-text neo-text-glow">Cinematic. Instant. Yours.</span>
            </h1>

            <p className="mt-6 max-w-xl text-lg text-cyan-100/70 leading-relaxed">
              NeoConference is a next-generation video platform built for crystal-clear conversations,
              effortless joining, and a beautifully immersive room experience — on any device.
            </p>

            <div className="mt-8 flex flex-col sm:flex-row gap-3 sm:items-center">
              <SignedIn>
                <button onClick={startNew} className="neo-btn text-base px-6 py-3.5">
                  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h7A2.5 2.5 0 0 1 15 7.5v9A2.5 2.5 0 0 1 12.5 19h-7A2.5 2.5 0 0 1 3 16.5v-9Zm14 1.2 3.3-2a1 1 0 0 1 1.5.86v8.88a1 1 0 0 1-1.5.86L17 15.3V8.7Z"/></svg>
                  Start a meeting
                </button>
                <Link href="/dashboard/new" className="neo-btn-ghost text-base px-6 py-3.5 inline-flex items-center gap-2">
                  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 12h8M12 8v8"/></svg>
                  Create event
                </Link>
                <Link href="/dashboard" className="neo-btn-ghost text-base px-6 py-3.5 inline-flex items-center gap-2">
                  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6h16M4 12h16M4 18h10"/></svg>
                  View past replays
                </Link>
                <div className="flex w-full sm:w-auto items-stretch gap-2">
                  <input
                    value={join}
                    onChange={(e) => setJoin(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") joinNamed(); }}
                    placeholder="Enter room code"
                    className="neo-input min-w-0 sm:w-64"
                    aria-label="Room code"
                  />
                  <button onClick={joinNamed} disabled={!join.trim()} className="neo-btn-ghost px-5 disabled:opacity-50">
                    Join
                  </button>
                </div>
              </SignedIn>
              <SignedOut>
                <SignUpButton mode="modal">
                  <button className="neo-btn text-base px-6 py-3.5">Get started — it&apos;s free</button>
                </SignUpButton>
                <SignInButton mode="modal">
                  <button className="neo-btn-ghost text-base px-6 py-3.5">Sign in</button>
                </SignInButton>
              </SignedOut>
            </div>

            <div className="mt-8 flex items-center gap-6 text-xs text-cyan-100/50">
              <div className="flex items-center gap-2"><span className="text-cyan-300">â</span> No downloads</div>
              <div className="flex items-center gap-2"><span className="text-cyan-300">â</span> End-to-end encrypted</div>
              <div className="hidden sm:flex items-center gap-2"><span className="text-cyan-300">â</span> HD recording</div>
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
          <ShowcaseCard
            badge="Replay"
            title="Cinematic event replays"
            desc="Auto-published HLS, transcripts and chapter markers at /e/<slug>/replay."
            href="/dashboard"
          />
          <ShowcaseCard
            badge="Live"
            title="Multistream to anywhere"
            desc="One Go-Live button: LiveKit + StreamLab Cloud + RTMP simulcast."
            href="/dashboard/new"
          />
          <ShowcaseCard
            badge="Smart"
            title="QR + dynamic shortlinks"
            desc="Print-once QR codes with HSMOH-backed waiting / live / replay routing."
            href="/dashboard/new"
          />
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
          <Feature title="Studio-grade audio" desc="Adaptive bitrate, echo cancellation and noise suppression keep voices crystal clear." icon={<IconWave />} />
          <Feature title="HD recording" desc="One-tap record. Files land in secure cloud storage with download anywhere." icon={<IconRec />} />
          <Feature title="Live participants" desc="Real-time roster with active speaker highlighting and presence dots." icon={<IconUsers />} />
          <Feature title="Mobile-first" desc="A native-app feel on phone and tablet. Buttery 60fps animations, smart layouts." icon={<IconPhone />} />
          <Feature title="Cinematic UI" desc="Neon cyan glassmorphism, floating cards, and motion that feels alive." icon={<IconSpark />} />
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
            <SignedIn>
              <button onClick={startNew} className="neo-btn px-7 py-3.5">Start a meeting</button>
              <Link href="/dashboard/new" className="neo-btn-ghost px-7 py-3.5">Create event</Link>
              <Link href="#" onClick={(e) => { e.preventDefault(); document.getElementById("join-quick")?.focus(); }} className="neo-btn-ghost px-7 py-3.5">Join with code</Link>
            </SignedIn>
            <SignedOut>
              <SignUpButton mode="modal"><button className="neo-btn px-7 py-3.5">Create free account</button></SignUpButton>
              <SignInButton mode="modal"><button className="neo-btn-ghost px-7 py-3.5">Sign in</button></SignInButton>
            </SignedOut>
          </div>
        </div>
      </section>

      <footer className="relative mx-auto max-w-7xl px-6 pb-10 text-center text-xs text-cyan-100/35">
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

function IconBolt(){return(<svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/></svg>);}
function IconWave(){return(<svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 12h2m4 0h2m4 0h2m4 0h2"/><path d="M5 8v8m4-12v16m4-13v10m4-7v4"/></svg>);}
function IconRec(){return(<svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor"><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2"/></svg>);}
function IconUsers(){return(<svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor"><path d="M16 11a4 4 0 1 0-4-4 4 4 0 0 0 4 4Zm-8 0a4 4 0 1 0-4-4 4 4 0 0 0 4 4Zm0 2c-3 0-8 1.5-8 4.5V20h10v-2.5c0-1.1.4-2 1-2.7C9.5 13.3 8.7 13 8 13Zm8 0c-.7 0-1.5.3-2.4.7.6.7 1 1.6 1 2.7V20h9v-2.5C23.6 14.5 18.6 13 16 13Z"/></svg>);}
function IconPhone(){return(<svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="6" y="2" width="12" height="20" rx="3"/><path d="M11 18h2"/></svg>);}
function IconSpark(){return(<svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor"><path d="M12 2 14 9l7 2-7 2-2 7-2-7-7-2 7-2 2-7Z"/></svg>);}

