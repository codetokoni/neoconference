"use client";

// Administrators: the owner, everyone appointed, and what each can do.
// Appoint, change role, suspend, reactivate, reset two-factor, remove —
// each confirmed, audited, and checked again by the server. ?role=<id>
// opens the list filtered to one role (the Roles page links here).

import { useCallback, useEffect, useState } from "react";
import type { AdminPermission } from "@/lib/admin/catalog";
import { errorText, useAdmin, Time } from "../AdminApi";
import { Badge, Confirm, Empty, FilterBar, Labeled, Loading, Notice, PageHeader, Pager, Panel, SortTh, TableWrap, btn, field, useClientTable, useUrlFilters } from "../ui";

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
  | { kind: "role"; m: Member; roleId: string }
  | { kind: "appoint"; email: string; roleId: string };

export default function TeamClient() {
  const { me, can, adminFetch } = useAdmin();
  const manage = can("admins:manage");
  const [team, setTeam] = useState<Team | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [rolesError, setRolesError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [email, setEmail] = useState("");
  const [roleId, setRoleId] = useState("support");
  const [pending, setPending] = useState<Pending | null>(null);
  const [showRemoved, setShowRemoved] = useState(false);
  // The role is in the address bar (the Roles page links to it); the search box is typed into, so it stays local.
  const f = useUrlFilters({ role: "" });
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    setLoadError(null);
    setRolesError(null);
    const [tr, rr] = await Promise.all([adminFetch<Team>("/api/admin/team"), adminFetch<{ roles: Role[] }>("/api/admin/roles")]);
    if (tr.ok) setTeam(tr.data);
    else setLoadError(errorText(tr));
    if (rr.ok) setRoles(rr.data.roles);
    else setRolesError(errorText(rr));
  }, [adminFetch]);
  useEffect(() => {
    load();
  }, [load]);

  const current = (team?.members ?? []).filter((m) => m.status !== "removed");
  const removed = (team?.members ?? []).filter((m) => m.status === "removed");
  const q = search.trim().toLowerCase();
  const shown = current.filter((m) => (!f.value.role || m.roleId === f.value.role) && (!q || `${m.name} ${m.email}`.toLowerCase().includes(q)));
  const t = useClientTable(
    shown,
    (m, k) => (k === "name" ? (m.name || m.email).toLowerCase() : k === "role" ? m.roleName : k === "status" ? m.status : m.appointedAt),
    { key: "appointed", dir: "desc" },
  );

  const appoint = async (p: Extract<Pending, { kind: "appoint" }>) => {
    setMsg(null);
    const r = await adminFetch<{ emailed: boolean }>("/api/admin/team", { method: "POST", json: { email: p.email, roleId: p.roleId } });
    setPending(null);
    if (!r.ok) return setMsg({ kind: "err", text: r.data.message ?? "Could not appoint." });
    setMsg({
      kind: "ok",
      text: `${p.email} is now an administrator. ${r.data.emailed ? "They were emailed." : "Tell them to open /admin."} They set up two-factor on their first visit.`,
    });
    setEmail("");
    load();
  };

  const run = async (p: Exclude<Pending, { kind: "appoint" }>, reason: string) => {
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
    setPending(null);
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

  if (!team)
    return loadError ? (
      <Notice kind="err" onRetry={load}>
        {loadError}
      </Notice>
    ) : (
      <Loading />
    );
  const roleName = (id: string) => roles.find((r) => r.id === id)?.name ?? id;
  const filterRole = f.value.role ? roles.find((r) => r.id === f.value.role)?.name ?? current.find((m) => m.roleId === f.value.role)?.roleName ?? f.value.role : null;

  return (
    <div>
      <PageHeader title="Administrators" sub="Who can run the platform, and with which role. Every change here is confirmed and recorded in the audit log." />
      {msg && (
        <Notice kind={msg.kind} onClose={() => setMsg(null)}>
          {msg.text}
        </Notice>
      )}
      {loadError && (
        <Notice kind="err" onRetry={load}>
          Could not refresh the list: {loadError}
        </Notice>
      )}
      {rolesError && (
        <Notice kind="err" onRetry={load}>
          The roles could not be read ({rolesError}), so roles cannot be chosen or changed here until they load.
        </Notice>
      )}

      <Panel className="mb-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-amber-300">Platform owner</p>
            <p className="mt-1 break-words text-sm text-white">{team.owner.emails.join(" · ")}</p>
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
              setMsg(null);
              setPending({ kind: "appoint", email: email.trim(), roleId });
            }}
            className="flex flex-col gap-2 sm:flex-row sm:items-end"
          >
            <label className="flex-1 text-sm text-zinc-300">
              Appoint an administrator
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Their NeoConference account email" className={`${field} mt-1`} />
            </label>
            <label className="text-sm text-zinc-300 sm:w-56">
              Role
              <select value={roleId} onChange={(e) => setRoleId(e.target.value)} disabled={!roles.length} className={`${field} mt-1`}>
                {roles.map((r) => (
                  <option key={r.id} value={r.id} disabled={!me.isOwner && r.permissions.some((p) => !me.permissions.includes(p))}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" disabled={!email.trim() || !roles.length} className={btn.primary}>
              Appoint…
            </button>
          </form>
        </Panel>
      )}

      {current.length > 0 && (
        <FilterBar
          active={f.active || !!q}
          onClear={() => {
            setSearch("");
            f.reset();
          }}
        >
          <Labeled label="Search" className="w-full sm:w-64">
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name or email" className={field} />
          </Labeled>
          <Labeled label="Role" className="w-full sm:w-56">
            <select value={f.value.role} onChange={(e) => f.set({ role: e.target.value })} className={field}>
              <option value="">Any role</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
              {f.value.role && !roles.some((r) => r.id === f.value.role) && <option value={f.value.role}>{filterRole}</option>}
            </select>
          </Labeled>
        </FilterBar>
      )}

      {current.length === 0 ? (
        <Empty>No administrators besides the owner yet.</Empty>
      ) : shown.length === 0 ? (
        <Empty>
          No administrators match{filterRole ? ` with the role ${filterRole}` : ""}
          {q ? ` and “${search.trim()}”` : ""}.
        </Empty>
      ) : (
        <>
          <TableWrap minWidth={720}>
            <thead className="border-b border-white/10 text-xs text-zinc-400">
              <tr>
                <SortTh label="Administrator" k="name" sort={t.sort} onSort={t.onSort} />
                <SortTh label="Role" k="role" sort={t.sort} onSort={t.onSort} />
                <SortTh label="Status" k="status" sort={t.sort} onSort={t.onSort} />
                <SortTh label="Appointed" k="appointed" sort={t.sort} onSort={t.onSort} />
                <th className="px-3 py-2 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {t.visible.map((m) => {
                const self = m.userId === me.userId;
                const who = m.name || m.email;
                return (
                  <tr key={m.userId} className="align-top">
                    <td className="px-3 py-2.5">
                      <p className="text-zinc-100">{m.name}</p>
                      <p className="text-xs text-zinc-400">{m.email}</p>
                    </td>
                    <td className="px-3 py-2.5">
                      {manage && !self && roles.length > 0 ? (
                        <select
                          aria-label={`Role for ${m.email}`}
                          value={m.roleId}
                          onChange={(e) => {
                            setMsg(null);
                            setPending({ kind: "role", m, roleId: e.target.value });
                          }}
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
                    <td className="space-x-1 px-3 py-2.5">
                      {m.status === "active" ? <Badge tone="green">Active</Badge> : <Badge tone="red">Suspended</Badge>}
                      {m.mfaEnrolled ? <Badge tone="cyan">2FA on</Badge> : <Badge tone="amber">2FA not set up</Badge>}
                      {m.status === "suspended" && m.suspendedReason && <p className="mt-1 text-xs text-zinc-400">{m.suspendedReason}</p>}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-zinc-400">
                      <Time ts={m.appointedAt} />
                      {m.appointedBy === "legacy" && <p className="text-zinc-400">from before roles existed</p>}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      {manage && !self && (
                        <div className="flex flex-wrap justify-end gap-1.5">
                          {m.status === "active" ? (
                            <button type="button" className={btn.warn} aria-label={`Suspend ${who}`} onClick={() => setPending({ kind: "suspend", m })}>
                              Suspend
                            </button>
                          ) : (
                            <button type="button" className={btn.ghost} aria-label={`Reactivate ${who}`} onClick={() => setPending({ kind: "reactivate", m })}>
                              Reactivate
                            </button>
                          )}
                          {m.mfaEnrolled && (
                            <button type="button" className={btn.ghost} aria-label={`Reset two-factor for ${who}`} onClick={() => setPending({ kind: "mfa", m })}>
                              Reset 2FA
                            </button>
                          )}
                          <button type="button" className={btn.danger} aria-label={`Remove ${who}`} onClick={() => setPending({ kind: "remove", m })}>
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
          </TableWrap>
          <Pager page={t.page} pageSize={t.pageSize} total={t.total} onPage={t.setPage} onPageSize={t.setPageSize} noun="administrator" />
        </>
      )}
      {team.pendingFromEnv.length > 0 && (
        <p className="mt-3 break-words text-xs text-zinc-400">
          Also admin through the <code>ADMIN_EMAILS</code> setting, not seen here yet: {team.pendingFromEnv.join(", ")}. They appear as Super admins the first
          time they open the admin area, and can then be changed or removed here.
        </p>
      )}
      {removed.length > 0 && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setShowRemoved(!showRemoved)}
            aria-expanded={showRemoved}
            aria-controls="team-removed"
            className="text-xs text-zinc-400 underline decoration-dotted underline-offset-2"
          >
            {showRemoved ? "Hide" : "Show"} {removed.length} removed
          </button>
          {showRemoved && (
            <ul id="team-removed" className="mt-2 space-y-1 text-xs text-zinc-400">
              {removed.map((m) => (
                <li key={m.userId} className="break-words">
                  {m.email} — removed <Time ts={m.updatedAt} />. Appoint them again above to restore access.
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {pending?.kind === "appoint" && (
        <Confirm
          title={`Appoint ${pending.email}?`}
          body={`They become an administrator with the role ${roleName(pending.roleId)} and set up two-factor on their first visit to the admin area. The account must already exist on NeoConference.`}
          confirmLabel="Appoint"
          onCancel={() => setPending(null)}
          onConfirm={() => appoint(pending)}
        />
      )}
      {pending && pending.kind !== "appoint" && (
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
              role: pending.kind === "role" ? `From ${pending.m.roleName} to ${roleName(pending.roleId)}. It applies at once.` : "",
            }[pending.kind]
          }
          confirmLabel={{ suspend: "Suspend", reactivate: "Reactivate", remove: "Remove", mfa: "Reset", role: "Change role" }[pending.kind]}
          danger={pending.kind === "remove" || pending.kind === "suspend" || pending.kind === "mfa"}
          typeToConfirm={pending.kind === "remove" ? "remove" : pending.kind === "suspend" ? "suspend" : pending.kind === "mfa" ? "reset" : undefined}
          withReason={pending.kind === "suspend" ? "Reason (recorded in the audit log)" : undefined}
          onCancel={() => setPending(null)}
          onConfirm={(reason) => run(pending, reason)}
        />
      )}
    </div>
  );
}
