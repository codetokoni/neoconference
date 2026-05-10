'use client';

// src/app/i/[token]/page.tsx
//
// Public invite landing. Fetches preview from /api/invites/[token],
// shows event name + role. Sign-in gate, then a single button to redeem.
// On success, redirects to /e/<slug>.

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useUser } from '@clerk/nextjs';
import Link from 'next/link';

type Preview = {
  invite: { role: string; label?: string; expiresAt?: string; remaining: number; expired: boolean; exhausted: boolean };
  event: { slug: string; name: string; ownerName?: string };
};

export default function InvitePage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const { isLoaded, isSignedIn } = useUser();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!params?.token) return;
    setLoading(true);
    fetch(`/api/invites/${params.token}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json())?.error || "not_found");
        return r.json();
      })
      .then((j) => setPreview(j))
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  }, [params?.token]);

  async function accept() {
    if (!preview) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/invites/${params.token}`, { method: "POST" });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "redeem_failed");
      router.replace(`/e/${j.eventSlug}`);
    } catch (e: any) {
      setErr(e?.message || "Could not accept invite");
      setBusy(false);
    }
  }

  return (
    <main style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, background: "radial-gradient(circle at 30% 20%, rgba(34,211,238,0.18), transparent 60%), #050818" }}>
      <div style={{ width: "min(440px, 100%)", padding: 32, borderRadius: 20, background: "rgba(15,23,42,0.85)", border: "1px solid rgba(34,211,238,0.25)", color: "#e2e8f0", backdropFilter: "blur(12px)" }}>
        <p style={{ margin: 0, fontSize: 11, letterSpacing: 2, color: "#67e8f9", textTransform: "uppercase" }}>Event invite</p>
        {loading ? (
          <p style={{ marginTop: 16, opacity: 0.6 }}>Loading…</p>
        ) : err ? (
          <>
            <h1 style={{ marginTop: 12, fontSize: 22 }}>Invite unavailable</h1>
            <p style={{ color: "#fda4af", marginTop: 8 }}>{err}</p>
            <Link href="/" style={{ color: "#22d3ee", marginTop: 16, display: "inline-block" }}>Back home</Link>
          </>
        ) : preview ? (
          <>
            <h1 style={{ marginTop: 12, fontSize: 22, lineHeight: 1.2 }}>{preview.event.name}</h1>
            {preview.event.ownerName ? (<p style={{ marginTop: 4, opacity: 0.7, fontSize: 13 }}>Hosted by {preview.event.ownerName}</p>) : null}
            <div style={{ marginTop: 18, padding: 14, borderRadius: 12, background: "rgba(34,211,238,0.08)", border: "1px solid rgba(34,211,238,0.2)" }}>
              <p style={{ margin: 0, fontSize: 12, color: "#67e8f9", letterSpacing: 1, textTransform: "uppercase" }}>Role granted</p>
              <p style={{ margin: "4px 0 0", fontSize: 18, fontWeight: 600, textTransform: "capitalize" }}>{preview.invite.role}</p>
              {preview.invite.expiresAt ? (<p style={{ margin: "8px 0 0", fontSize: 11, opacity: 0.7 }}>Expires {new Date(preview.invite.expiresAt).toLocaleString()}</p>) : null}
              <p style={{ margin: "4px 0 0", fontSize: 11, opacity: 0.7 }}>{preview.invite.remaining} use{preview.invite.remaining === 1 ? "" : "s"} left</p>
            </div>
            {preview.invite.expired || preview.invite.exhausted ? (
              <p style={{ marginTop: 16, color: "#fda4af" }}>{preview.invite.expired ? "This invite has expired." : "This invite has been fully used."}</p>
            ) : !isLoaded ? (
              <p style={{ marginTop: 16, opacity: 0.6 }}>…</p>
            ) : !isSignedIn ? (
              <div style={{ marginTop: 18 }}>
                <Link
                  href={`/sign-in?redirect_url=${encodeURIComponent(typeof window !== "undefined" ? window.location.pathname : "/")}`}
                  style={{ display: "block", textAlign: "center", width: "100%", padding: "12px 16px", borderRadius: 12, background: "#22d3ee", color: "#022c22", fontWeight: 700, fontSize: 14, textDecoration: "none" }}
                >
                  Sign in to accept
                </Link>
              </div>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={accept}
                style={{ marginTop: 18, width: "100%", padding: "12px 16px", borderRadius: 12, border: "none", background: "#22d3ee", color: "#022c22", fontWeight: 700, fontSize: 14, cursor: busy ? "wait" : "pointer", opacity: busy ? 0.7 : 1 }}
              >
                {busy ? "Accepting…" : "Accept invite"}
              </button>
            )}
          </>
        ) : null}
      </div>
    </main>
  );
}

