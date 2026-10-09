"use client";

// Administrators: the owner, everyone appointed, and what each can do.
// Appoint, change role, suspend, reactivate, reset two-factor, remove —
// each confirmed, audited, and checked again by the server.

import { useCallback, useEffect, useState } from "react";
import type { AdminPermission } from "@/lib/admin/catalog";
import { fmtTime, useAdmin } from "../AdminApi";
import { Badge, Confirm, Empty, Loading, Notice, PageHeader, Panel, btn, field } from "../ui";

type Member = {
  userId: string;
  email: string;
  name: string;
  roleId: string;
  roleName: string;
  status: "active" | "suspended" | "removed";
  appointedBy: string;
  appointedAt: number;
  updatedAt: number;
  suspendedReason?: string;
  mfaEnrolled: boolean;
};
type Role = { id: string; name: string; builtIn: boolean; permissions: AdminPermission[] };
type Team = { owner: { emails: string[]; source: "env" | "default"; youAreOwner: boolean }; members: Member[]; pendingFromEnv: string[] };

type Pending =
  | { kind: "suspend" | "remove" | "mfa" | "reactivate"; m: Member }
  | { kind: "role"; m: Member; roleId: string };

export default function TeamClient() {
  const { me, can, adminFetch } = useAdmin();
  const manage = can("admins:manage");
  const [team, setTeam] = useState<Team | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [email, setEmail] = useState("");
  const [roleId, setRoleId] = useState("support");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [showRemoved, setShowRemoved] = useState(false);

  const load = useCallback(async () => {
    const [t, r] = await Promise.all([adminFetch<Team>("/api/admin/team"), adminFetch<{ roles: Role[] }>("/api/admin/roles")]);
    if (t.ok) setTeam(t.data);
    else setMsg({ kind: "err", text: t.data.message ?? "Could not load administrators." });
    if (r.ok) setRoles(r.data.roles);
  }, [adminFetch]);
  useEffect(() => {
    load();
  }, [load]);

  const appoint = async () => {
    setBusy(true);
    setMsg(null);
    const r = await adminFetch<{ emailed: boolean }>("/api/admin/team", { method: "POST", json: { email, roleId } });
    setBusy(false);
    if (!r.ok) return setMsg({ kind: "err", text: r.data.message ?? "Could not appoint." });
    setMsg({
      kind: "ok",
      text: `${email} is now an administrator. ${r.data.emailed ? "They were emailed." : "Tell them to open /admin."} They set up two-factor on their first visit.`,
    });
    setEmail("");
    load();
  };

  const run = async (p: Pending, reason: string) => {
    setPending(null);
    setMsg(null);
    const url = `/api/admin/team/${encodeURIComponent(p.m.userId)}`;
    const r =
      p.kind === "remove"
        ? await adminFetch(url, { method: "DELETE" })
        : p.kind === "mfa"
          ? await adminFetch(`${url}/mfa`, { method: "DELETE" })
          : p.kind === "role"
            ? await adminFetch(url, { method: "PATCH", json: { roleId: p.roleId } })
            : await adminFetch(url, { method: "PATCH", json: { status: p.kind === "suspend" ? "suspended" : "active", reason } });
    if (!r.ok) return setMsg({ kind: "err", text: r.data.message ?? "That did not work." });
    const done = {
      remove: `${p.m.email} is no longer an administrator.`,
      mfa: `${p.m.email}'s two-factor was reset. They set it up again on their next visit.`,
      role: `${p.m.email}'s role changed.`,
      suspend: `${p.m.email} is suspended.`,
      reactivate: `${p.m.email} is active again.`,
    }[p.kind];
    setMsg({ kind: "ok", text: done });
    load();
  };

  if (!team) return msg ? <Notice kind="err">{msg.text}</Notice> : <Loading />;
  const current = team.members.filter((m) => m.status !== "removed");
  const removed = team.members.filter((m) => m.status === "removed");

  return (
    <div>
      <PageHeader title="Administrators" sub="Who can run the platform, and with which role. Every change here is confirmed and recorded in the audit log." />
      {msg && (
        <Notice kind={msg.kind} onClose={() => setMsg(null)}>
          {msg.text}
        </Notice>
      )}

      <Panel className="mb-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-amber-300">Platform owner</p>
            <p className="mt-1 text-sm text-white">{team.owner.emails.join(" · ")}</p>
            <p className="mt-1 max-w-2xl text-xs text-zinc-400">
              Every permission, permanent Enterprise access, and cannot be suspended, demoted or removed from here. Ownership is changed only through the
              Vercel project setting <code className="rounded bg-black/40 px-1">PLATFORM_OWNER_EMAILS</code> and a redeploy
              {team.owner.source === "default" ? " (not set yet, so the built-in owner addresses apply)" : ""}.
            </p>
          </div>
          {team.owner.youAreOwner && <Badge tone="amber">You</Badge>}
        </div>
      </Panel>

      {manage && (
        <Panel className="mb-4">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              appoint();
            }}
            className="flex flex-col gap-2 sm:flex-row sm:items-end"
          >
            <label className="flex-1 text-sm text-zinc-300">
              Appoint an administrator
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Their NeoConference account email" className={`${field} mt-1`} />
            </label>
            <label className="text-sm text-zinc-300 sm:w-56">
              Role
              <select aria-label="Role for the new administrator" value={roleId} onChange={(e) => setRoleId(e.target.value)} className={`${field} mt-1`}>
                {roles.map((r) => (
                  <option key={r.id} value={r.id} disabled={!me.isOwner && r.permissions.some((p) => !me.permissions.includes(p))}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" disabled={busy || !email} className={btn.primary}>
              {busy ? "Appointing…" : "Appoint"}
            </button>
          </form>
        </Panel>
      )}

      <Panel>
        {current.length === 0 ? (
          <Empty>No administrators besides the owner yet.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="pb-2 pr-3 font-medium">Administrator</th>
                  <th className="pb-2 pr-3 font-medium">Role</th>
                  <th className="pb-2 pr-3 font-medium">Status</th>
                  <th className="pb-2 pr-3 font-medium">Appointed</th>
                  <th className="pb-2 font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {current.map((m) => {
                  const self = m.userId === me.userId;
                  return (
                    <tr key={m.userId} className="align-top">
                      <td className="py-2.5 pr-3">
                        <p className="text-zinc-100">{m.name}</p>
                        <p className="text-xs text-zinc-500">{m.email}</p>
                      </td>
                      <td className="py-2.5 pr-3">
                        {manage && !self ? (
                          <select
                            aria-label={`Role for ${m.email}`}
                            value={m.roleId}
                            onChange={(e) => setPending({ kind: "role", m, roleId: e.target.value })}
                            className="rounded-lg border border-white/12 bg-black/40 px-2 py-1 text-sm text-zinc-100"
                          >
                            {roles.map((r) => (
                              <option key={r.id} value={r.id}>
                                {r.name}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className="text-zinc-200">{m.roleName}</span>
                        )}
                      </td>
                      <td className="space-x-1 py-2.5 pr-3">
                        {m.status === "active" ? <Badge tone="green">Active</Badge> : <Badge tone="red">Suspended</Badge>}
                        {m.mfaEnrolled ? <Badge tone="cyan">2FA on</Badge> : <Badge tone="amber">2FA not set up</Badge>}
                        {m.status === "suspended" && m.suspendedReason && <p className="mt-1 text-xs text-zinc-500">{m.suspendedReason}</p>}
                      </td>
                      <td className="py-2.5 pr-3 text-xs text-zinc-400">
                        {fmtTime(m.appointedAt)}
                        {m.appointedBy === "legacy" && <p className="text-zinc-500">from before roles existed</p>}
                      </td>
                      <td className="py-2.5 text-right">
                        {manage && !self && (
                          <div className="flex flex-wrap justify-end gap-1.5">
                            {m.status === "active" ? (
                              <button type="button" className={btn.warn} onClick={() => setPending({ kind: "suspend", m })}>
                                Suspend
                              </button>
                            ) : (
                              <button type="button" className={btn.ghost} onClick={() => setPending({ kind: "reactivate", m })}>
                                Reactivate
                              </button>
                            )}
                            {m.mfaEnrolled && (
                              <button type="button" className={btn.ghost} onClick={() => setPending({ kind: "mfa", m })}>
                                Reset 2FA
                              </button>
                            )}
                            <button type="button" className={btn.danger} onClick={() => setPending({ kind: "remove", m })}>
                              Remove
                            </button>
                          </div>
                        )}
                        {self && <Badge>You</Badge>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {team.pendingFromEnv.length > 0 && (
          <p className="mt-3 text-xs text-zinc-500">
            Also admin through the <code>ADMIN_EMAILS</code> setting, not seen here yet: {team.pendingFromEnv.join(", ")}. They appear as Super admins the
            first time they open the admin area, and can then be changed or removed here.
          </p>
        )}
        {removed.length > 0 && (
          <div className="mt-3">
            <button type="button" onClick={() => setShowRemoved(!showRemoved)} className="text-xs text-zinc-400 underline decoration-dotted underline-offset-2">
              {showRemoved ? "Hide" : "Show"} {removed.length} removed
            </button>
            {showRemoved && (
              <ul className="mt-2 space-y-1 text-xs text-zinc-500">
                {removed.map((m) => (
                  <li key={m.userId}>
                    {m.email} — removed {fmtTime(m.updatedAt)}. Appoint them again above to restore access.
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Panel>

      {pending && (
        <Confirm
          title={
            {
              suspend: `Suspend ${pending.m.email}?`,
              reactivate: `Reactivate ${pending.m.email}?`,
              remove: `Remove ${pending.m.email}?`,
              mfa: `Reset ${pending.m.email}'s two-factor?`,
              role: `Change ${pending.m.email}'s role?`,
            }[pending.kind]
          }
          body={
            {
              suspend: "They lose admin access at once, everywhere, until reactivated.",
              reactivate: "They get their role back at once.",
              remove: "They stop being an administrator at once. Their account itself is not touched.",
              mfa: "Do this only after confirming who they are some other way (a call, in person). They will set up a new authenticator on their next visit.",
              role:
                pending.kind === "role"
                  ? `From ${pending.m.roleName} to ${roles.find((r) => r.id === pending.roleId)?.name ?? pending.roleId}. It applies at once.`
                  : "",
            }[pending.kind]
          }
          confirmLabel={{ suspend: "Suspend", reactivate: "Reactivate", remove: "Remove", mfa: "Reset", role: "Change role" }[pending.kind]}
          danger={pending.kind === "remove" || pending.kind === "suspend" || pending.kind === "mfa"}
          typeToConfirm={pending.kind === "remove" ? "remove" : undefined}
          withReason={pending.kind === "suspend" ? "Reason (recorded in the audit log)" : undefined}
          onCancel={() => setPending(null)}
          onConfirm={(reason) => run(pending, reason)}
        />
      )}
    </div>
  );
}
