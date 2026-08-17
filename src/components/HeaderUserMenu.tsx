"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useUser } from "@clerk/nextjs";

function initials(name: string) {
  const t = (name || "").trim();
  if (!t) return "?";
  const p = t.split(/\s+/).filter(Boolean);
  if (p.length === 1) return p[0].slice(0, 2).toUpperCase();
  return (p[0][0] + p[p.length - 1][0]).toUpperCase();
}

function colorFor(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) { h = name.charCodeAt(i) + ((h << 5) - h); h |= 0; }
  return `hsl(${Math.abs(h) % 360} 70% 45%)`;
}

export function HeaderUserMenu() {
  const { isLoaded, user } = useUser();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  if (!isLoaded || !user) return null;

  const display = user.fullName || user.username || user.primaryEmailAddress?.emailAddress || "User";
  const email = user.primaryEmailAddress?.emailAddress || "";
  const init = initials(display);
  const bg = colorFor(display);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label="User menu"
        onClick={() => setOpen(v => !v)}
        className="w-9 h-9 rounded-full flex items-center justify-center text-white font-semibold text-sm shadow ring-2 ring-cyan-400/40 hover:ring-cyan-300 transition"
        style={{ background: bg }}
      >
        {init}
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-64 rounded-xl bg-zinc-950/95 backdrop-blur border border-cyan-400/20 shadow-2xl text-white overflow-hidden z-50">
          <div className="px-4 py-3 border-b border-white/10">
            <div className="font-semibold truncate">{display}</div>
            {email ? <div className="text-xs text-zinc-400 truncate">{email}</div> : null}
          </div>
          <Link href="/" onClick={() => setOpen(false)} className="block px-4 py-2 text-sm hover:bg-white/5">Home</Link><Link href="/dashboard" onClick={() => setOpen(false)} className="block px-4 py-2 text-sm hover:bg-white/5">Dashboard</Link><Link href="/dashboard/recordings" onClick={() => setOpen(false)} className="block px-4 py-2 text-sm hover:bg-white/5">Recordings</Link><Link href="/dashboard/settings" onClick={() => setOpen(false)} className="block px-4 py-2 text-sm hover:bg-white/5">Account &amp; security</Link>
          <a href="/sign-out" className="block px-4 py-2 text-sm text-red-400 hover:bg-red-400/10 border-t border-white/10">Sign out</a>
        </div>
      )}
    </div>
  );
}

export default HeaderUserMenu;
