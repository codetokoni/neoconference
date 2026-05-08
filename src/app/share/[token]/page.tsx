// src/app/share/[token]/page.tsx
// Public landing page for a recording share link.
// Resolves the token via /api/recordings/share and offers a download.

import { headers } from "next/headers";
import Link from "next/link";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function resolve(token: string): Promise<{ ok: boolean; downloadUrl?: string; label?: string | null; expiresAt?: number; error?: string }> {
  try {
    const h = await headers();
    const proto = h.get("x-forwarded-proto") || "https";
    const host = h.get("x-forwarded-host") || h.get("host");
    if (!host) return { ok: false, error: "host_missing" };
    const url = `${proto}://${host}/api/recordings/share?token=${encodeURIComponent(token)}`;
    const res = await fetch(url, { cache: "no-store" });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data?.error || "unavailable" };
    return { ok: true, downloadUrl: data.downloadUrl, label: data.label, expiresAt: data.expiresAt };
  } catch (e: any) {
    return { ok: false, error: e?.message || "fetch_failed" };
  }
}

export default async function SharePage(
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  const result = await resolve(token);

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center px-4">
      <div className="max-w-lg w-full rounded-2xl border border-cyan-400/20 bg-slate-900/60 backdrop-blur-xl p-8 shadow-2xl shadow-cyan-500/10">
        <div className="flex items-center gap-2 mb-6">
          <span className="inline-block w-2 h-2 rounded-full bg-cyan-400 animate-pulse"></span>
          <span className="text-xs uppercase tracking-[0.3em] text-cyan-300">NeoConference</span>
        </div>
        {result.ok ? (
          <>
            <h1 className="text-2xl font-semibold mb-2">Shared recording</h1>
            {result.label && (
              <p className="text-slate-300 mb-4">{result.label}</p>
            )}
            <p className="text-xs text-slate-500 mb-6">
              {result.expiresAt
                ? `Link expires ${new Date(result.expiresAt).toLocaleString()}`
                : "Limited-time download"}
            </p>
            <a
              href={result.downloadUrl}
              download
              className="inline-flex items-center justify-center w-full px-5 py-3 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold transition"
            >
              Download recording
            </a>
            <p className="text-[11px] text-slate-500 mt-4">
              The download URL is signed and expires in a few minutes for your security.
            </p>
          </>
        ) : (
          <>
            <h1 className="text-2xl font-semibold mb-2">Link unavailable</h1>
            <p className="text-slate-400 mb-6 text-sm">
              {result.error === "not_found_or_expired"
                ? "This share link has expired or been revoked."
                : "We could not load this share link right now."}
            </p>
            <Link
              href="/"
              className="inline-flex items-center justify-center px-4 py-2 rounded-lg border border-slate-700 hover:border-cyan-400/50 text-sm transition"
            >
              Back to NeoConference
            </Link>
          </>
        )}
      </div>
    </main>
  );
}
