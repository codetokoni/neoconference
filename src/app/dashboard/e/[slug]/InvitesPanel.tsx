'use client';

// src/app/dashboard/e/[slug]/InvitesPanel.tsx
//
// Owner-side panel: mint shareable role-grant invite links, list outstanding
// invites, copy URL, revoke. Backed by /api/events/[id]/invites endpoints.

import { useState, useEffect, useCallback } from "react";

type Invite = {
  token: string;
  role: "cohost" | "speaker" | "attendee" | "ticket-holder";
  createdAt: number;
  expiresAt?: number;
  maxUses: number;
  uses: number;
  label?: string;
};

type Props = { eventId: string };

const ROLES: Array<Invite["role"]> = ["cohost", "speaker", "attendee", "ticket-holder"];

export default function InvitesPanel({ eventId }: Props) {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [role, setRole] = useState<Invite["role"]>("attendee");
  const [maxUses, setMaxUses] = useState(1);
  const [hours, setHours] = useState(168);
  const [label, setLabel] = useState("");
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch(`/api/events/${eventId}/invites`, { cache: "no-store" });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "Failed to load invites");
      setInvites(Array.isArray(j.invites) ? j.invites : []);
    } catch (e: any) {
      setErr(e?.message || "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => { load(); }, [load]);

  const filteredInvites = invites.filter((inv) => !query || (inv.label || "").toLowerCase().includes(query.toLowerCase()) || inv.role.includes(query.toLowerCase()) || inv.token.toLowerCase().includes(query.toLowerCase()));

  const mint = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/events/${eventId}/invites`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role, maxUses, expiresInHours: hours, label: label || undefined }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "Failed to mint invite");
      setLabel("");
      await load();
    } catch (e: any) {
      setErr(e?.message || "Failed to mint");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (token: string) => {
    if (!confirm("Revoke this invite link? It will stop working immediately.")) return;
    try {
      const r = await fetch(`/api/events/${eventId}/invites?token=${encodeURIComponent(token)}`, { method: "DELETE" });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "Failed to revoke");
      await load();
    } catch (e: any) {
      setErr(e?.message || "Failed to revoke");
    }
  };

  const copy = async (token: string) => {
    const url = `${typeof window !== "undefined" ? window.location.origin : ""}/i/${token}`;
    try { await navigator.clipboard.writeText(url); setCopied(token); setTimeout(() => setCopied(null), 1500); } catch {}
  };

  return (
    <section className={"rounded-2xl border border-cyan-500/15 bg-slate-900/40 backdrop-blur p-5 space-y-4"}>
      <header className={"flex items-center justify-between"}>
        <h2 className={"text-sm uppercase tracking-widest text-slate-400"}>Invite links</h2>
        <span className={"text-[11px] text-slate-500"}>{invites.length} active</span>
      </header>

      <div className={"grid grid-cols-1 md:grid-cols-5 gap-2 items-end"}>
        <label className={"text-xs text-slate-400 flex flex-col gap-1"}>
          Role
          <select value={role} onChange={(e) => setRole(e.target.value as Invite["role"])} className={"bg-slate-950/60 border border-slate-700 rounded px-2 py-1.5 text-slate-200 text-sm"}>
            {ROLES.map((r) => (<option key={r} value={r}>{r}</option>))}
          </select>
        </label>
        <label className={"text-xs text-slate-400 flex flex-col gap-1"}>
          Max uses
          <input type={"number"} min={1} max={1000} value={maxUses} onChange={(e) => setMaxUses(Math.max(1, Math.min(1000, Number(e.target.value) || 1)))} className={"bg-slate-950/60 border border-slate-700 rounded px-2 py-1.5 text-slate-200 text-sm"} />
        </label>
        <label className={"text-xs text-slate-400 flex flex-col gap-1"}>
          Hours valid
          <input type={"number"} min={1} max={8760} value={hours} onChange={(e) => setHours(Math.max(1, Math.min(8760, Number(e.target.value) || 1)))} className={"bg-slate-950/60 border border-slate-700 rounded px-2 py-1.5 text-slate-200 text-sm"} />
        </label>
        <label className={"text-xs text-slate-400 flex flex-col gap-1 md:col-span-2"}>
          Label (optional)
          <input type={"text"} value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} placeholder={"e.g. VIP guests"} className={"bg-slate-950/60 border border-slate-700 rounded px-2 py-1.5 text-slate-200 text-sm"} />
        </label>
      </div>

      <button type={"button"} disabled={busy} onClick={mint} className={"w-full md:w-auto px-4 py-2 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-400/40 text-cyan-200 text-sm font-medium disabled:opacity-50"}>
        {busy ? "Generating..." : "Generate invite link"}
      </button>

      {err && <div className={"text-xs text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded px-3 py-2"}>{err}</div>}

      <div className={"flex items-center gap-2"}>
        <input type={"text"} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={"Filter by role, label, or token..."} className={"flex-1 bg-slate-950/60 border border-slate-700 rounded px-3 py-1.5 text-slate-200 text-xs"} />
        {query && <button type={"button"} onClick={() => setQuery("")} className={"text-[11px] px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-400"}>Clear</button>}
      </div>

      <ul className={"space-y-2"}>
        {loading && <li className={"text-xs text-slate-500"}>Loading...</li>}
        {!loading && filteredInvites.length === 0 && <li className={"text-xs text-slate-500"}>{query ? "No invites match." : "No active invites yet."}</li>}
        {filteredInvites.map((inv) => {
          const url = `${typeof window !== "undefined" ? window.location.origin : ""}/i/${inv.token}`;
          const remaining = Math.max(0, inv.maxUses - inv.uses);
          const expired = inv.expiresAt && inv.expiresAt < Date.now();
          return (
            <li key={inv.token} className={"flex flex-col md:flex-row md:items-center gap-2 px-3 py-2 rounded-lg bg-slate-950/50 border border-slate-800"}>
              <div className={"flex-1 min-w-0"}>
                <div className={"flex items-center gap-2 flex-wrap"}>
                  <span className={"px-2 py-0.5 rounded-full bg-cyan-500/15 text-cyan-200 text-[10px] uppercase tracking-wider border border-cyan-400/30"}>{inv.role}</span>
                  {inv.label && <span className={"text-xs text-slate-300"}>{inv.label}</span>}
                  {expired && <span className={"text-[10px] text-rose-300 uppercase"}>expired</span>}
                  {remaining === 0 && !expired && <span className={"text-[10px] text-amber-300 uppercase"}>exhausted</span>}
                </div>
                <div className={"text-[11px] text-slate-500 mt-0.5 truncate"}>{url}</div>
                <div className={"text-[10px] text-slate-600 mt-0.5"}>{inv.uses}/{inv.maxUses} used{inv.expiresAt ? " . expires " + new Date(inv.expiresAt).toLocaleString() : ""}</div>
              </div>
              <div className={"flex items-center gap-2 shrink-0"}>
                <button type={"button"} onClick={() => copy(inv.token)} className={"px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs"}>{copied === inv.token ? "Copied!" : "Copy URL"}</button>
                <button type={"button"} onClick={() => revoke(inv.token)} className={"px-3 py-1.5 rounded bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/40 text-rose-200 text-xs"}>Revoke</button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

