"use client";

// Your own admin security: two-factor, recovery codes, the admin session,
// and (for the owner) how ownership is held and transferred.

import { useCallback, useEffect, useState } from "react";
import { errorText, fmtTime, useAdmin } from "../AdminApi";
import { lockAdmin } from "../AdminShell";
import { Badge, Confirm, Loading, Notice, PageHeader, Panel, btn } from "../ui";

type Me = {
  mfa: { enrolled: boolean; enabledAt?: number; recoveryLeft?: number };
  owner: { emails: string[]; source: "env" | "default" } | null;
};

export default function SecurityClient() {
  const { me, adminFetch } = useAdmin();
  const [data, setData] = useState<Me | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [asking, setAsking] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);
  const [locking, setLocking] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    const r = await adminFetch<Me>("/api/admin/me");
    if (r.ok) setData(r.data);
    else setLoadError(errorText(r));
  }, [adminFetch]);
  useEffect(() => {
    load();
  }, [load]);

  const regenerate = async () => {
    setMsg(null);
    const r = await adminFetch<{ recoveryCodes: string[] }>("/api/admin/mfa/recovery", { method: "POST" });
    setAsking(false);
    if (!r.ok) return setMsg({ kind: "err", text: r.data.message ?? "Could not replace the codes." });
    setCodes(r.data.recoveryCodes);
    setCopied(null);
    setMsg({ kind: "ok", text: "Recovery codes replaced. Save the new ones below: they are shown once." });
    load();
  };

  const copy = async (list: string[]) => {
    try {
      await navigator.clipboard.writeText(list.join("\n"));
      setCopied("yes");
    } catch {
      // No clipboard (insecure context, permission refused): say so rather than look done.
      setCopied("no");
    }
  };

  // The shell's own lock (a deliberately plain call: it ends the admin session itself).
  const lock = async () => {
    setLocking(true);
    await lockAdmin();
  };

  if (!data)
    return loadError ? (
      <Notice kind="err" onRetry={load}>
        {loadError}
      </Notice>
    ) : (
      <Loading />
    );
  const low = (data.mfa.recoveryLeft ?? 0) <= 3;

  return (
    <div>
      <PageHeader title="Security" sub="Your two-factor authentication and admin session." />
      {msg && (
        <Notice kind={msg.kind} onClose={() => setMsg(null)}>
          {msg.text}
        </Notice>
      )}
      {loadError && (
        <Notice kind="err" onRetry={load}>
          Could not refresh: {loadError}
        </Notice>
      )}
      <div className="grid gap-3 lg:grid-cols-2">
        <Panel>
          <h2 className="text-sm font-semibold text-white">Two-factor authentication</h2>
          <p className="mt-1 text-sm text-zinc-300">
            <Badge tone="green">On</Badge> since {fmtTime(data.mfa.enabledAt)}
          </p>
          <p className="mt-2 text-sm text-zinc-300">
            Recovery codes left: <b className={low ? "text-amber-300" : "text-white"}>{data.mfa.recoveryLeft ?? 0}</b>
            {codes && <span className="text-zinc-400"> of {codes.length}</span>}
          </p>
          {low && <p className="mt-1 text-xs text-amber-300">Running low. Replace them so you are not locked out if you lose your phone.</p>}
          <button type="button" className={`${btn.ghost} mt-3`} onClick={() => setAsking(true)}>
            Replace recovery codes
          </button>
          {codes && (
            <div className="mt-3">
              <p className="text-xs text-zinc-400">New codes — shown once. The old ones no longer work.</p>
              <ul aria-label="New recovery codes" className="mt-2 grid grid-cols-2 gap-1.5 rounded-lg bg-black/40 p-3 font-mono text-sm text-cyan-200">
                {codes.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button type="button" className={btn.ghost} onClick={() => copy(codes)}>
                  {copied === "yes" ? "Copied" : "Copy"}
                </button>
                <a
                  className={btn.ghost}
                  download="neoconference-admin-recovery-codes.txt"
                  href={`data:text/plain;charset=utf-8,${encodeURIComponent(`NeoConference admin recovery codes for ${me.email}\n\n${codes.join("\n")}\n`)}`}
                >
                  Download
                </a>
                <span role="status" aria-live="polite" className={`text-xs ${copied === "no" ? "text-red-300" : "text-emerald-300"}`}>
                  {copied === "yes" ? "Copied to the clipboard." : copied === "no" ? "Could not copy: select the codes or use Download." : ""}
                </span>
              </div>
            </div>
          )}
          <p className="mt-3 text-xs text-zinc-400">
            Lost your phone and your codes? Another administrator with “Appoint, edit, suspend and remove administrators” can reset your two-factor after
            confirming who you are.
          </p>
        </Panel>

        <Panel>
          <h2 className="text-sm font-semibold text-white">Admin session</h2>
          <p className="mt-1 text-sm text-zinc-300">
            Signed in as {me.email} · <span className="text-zinc-400">{me.roleName}</span>
          </p>
          <p className="mt-1 text-sm text-zinc-300">Ends {fmtTime(me.sessionExpiresAt)}, or when you sign out of NeoConference.</p>
          <p className="mt-1 text-xs text-zinc-400">
            Sensitive actions (marked on the Roles page) ask for a fresh code if your last one was more than 10 minutes ago. Five wrong codes lock
            verification for 15 minutes, and every attempt is in the audit log.
          </p>
          <button type="button" className={`${btn.ghost} mt-3`} onClick={lock} disabled={locking}>
            {locking ? "Locking…" : "Lock the admin area now"}
          </button>
        </Panel>

        {data.owner && (
          <Panel className="lg:col-span-2">
            <h2 className="text-sm font-semibold text-white">
              Ownership <Badge tone="amber">Owner</Badge>
            </h2>
            <p className="mt-1 text-sm text-zinc-300">Owner accounts: {data.owner.emails.join(" · ")}</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-zinc-400">
              <li>A verified email from this list on the signed-in account makes the owner. An unverified address does not count.</li>
              <li>The owner has every permission and the Enterprise plan with nothing to pay, whatever plan is stored on the account.</li>
              <li>No administrator — and no button here — can suspend, demote, remove or delete the owner.</li>
              <li>
                Transferring ownership is a separate, verified process: change <code className="rounded bg-black/40 px-1">PLATFORM_OWNER_EMAILS</code> in the
                Vercel project (Settings → Environment Variables) and redeploy. That needs access to the Vercel account.
                {data.owner.source === "default" && " It is not set yet, so the built-in owner addresses apply."}
              </li>
            </ul>
          </Panel>
        )}
      </div>

      {asking && (
        <Confirm
          title="Replace your recovery codes?"
          body="Your current codes stop working at once. You will see ten new ones, once."
          confirmLabel="Replace codes"
          onCancel={() => setAsking(false)}
          // The promise keeps the dialog on "Working…" until the new codes arrive.
          onConfirm={() => regenerate()}
        />
      )}
    </div>
  );
}
