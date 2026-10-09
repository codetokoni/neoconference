"use client";

// One group: owner, members, people invited before they had an account,
// and its history. Ownership can be transferred and members removed; both
// are confirmed, audited, and written into the group's own history.

import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Time, errorText, fmtNumber, useAdmin, type ApiResult } from "../../AdminApi";
import { Badge, Confirm, EmptyLine, Labeled, Loading, Notice, PageHeader, Pager, Panel, btn, field, useClientTable } from "../../ui";

type Member = { userId: string; role: string; name: string; email?: string; joinedAt: number; addedBy: string | null };
type Detail = {
  group: { id: string; name: string; description: string; createdAt: string; ownerId: string | null; memberCount: number; pendingCount: number };
  settings: { retryIntervalMin: number; maxAttempts: number };
  members: Member[];
  pending: { key: string; kind: string; value: string; addedAt: number }[];
  activity: { ts: number; type: string; detail: string }[];
};
type Ask = {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  typeToConfirm?: string;
  withReason?: string;
  run: (reason: string) => Promise<ApiResult>;
  done: string;
};

const roleName = (r: string) => (r === "participant" ? "Member" : r[0].toUpperCase() + r.slice(1));
// The owner first, then hosts, then members.
const roleRank = (r: string) => (r === "owner" ? 0 : r === "participant" ? 2 : 1);

export default function GroupClient({ gid }: { gid: string }) {
  const { can, adminFetch } = useAdmin();
  const [d, setD] = useState<Detail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [q, setQ] = useState("");
  const base = `/api/admin/groups/${encodeURIComponent(gid)}`;

  const load = useCallback(async () => {
    setLoadError(null);
    const r = await adminFetch<Detail>(base);
    if (r.ok) setD(r.data);
    else setLoadError(errorText(r));
  }, [adminFetch, base]);
  useEffect(() => {
    load();
  }, [load]);

  const go = async (a: Ask, reason: string) => {
    setMsg(null);
    const r = await a.run(reason);
    setAsk(null);
    if (!r.ok) return setMsg({ kind: "err", text: r.data.message ?? r.data.error ?? `HTTP ${r.status}` });
    setMsg({ kind: "ok", text: a.done });
    load();
  };

  const needle = q.trim().toLowerCase();
  const members = (d?.members ?? []).filter((m) => !needle || `${m.name} ${m.email ?? ""} ${m.userId}`.toLowerCase().includes(needle));
  const t = useClientTable(members, (m, k) => (k === "joined" ? m.joinedAt : k === "name" ? (m.name || m.userId).toLowerCase() : roleRank(m.role)), {
    key: "role",
    dir: "asc",
  });

  if (!d)
    return loadError ? (
      <Notice kind="err" onRetry={load}>
        {loadError}
      </Notice>
    ) : (
      <Loading />
    );
  const write = can("users:write");
  const owner = d.members.find((m) => m.role === "owner");

  return (
    <div className="space-y-4">
      <Link href="/admin/groups" className="text-sm text-cyan-300 hover:underline">
        ← Groups
      </Link>
      <PageHeader
        title={d.group.name}
        sub={
          <>
            <a href="#members" className="hover:underline">
              {fmtNumber(d.group.memberCount)} member{d.group.memberCount === 1 ? "" : "s"}
            </a>
            {d.group.pendingCount ? (
              <>
                ,{" "}
                <a href="#invited" className="hover:underline">
                  {fmtNumber(d.group.pendingCount)} invited
                </a>
              </>
            ) : null}{" "}
            · created <Time ts={d.group.createdAt} />
          </>
        }
      />
      {msg && (
        <Notice kind={msg.kind} onClose={() => setMsg(null)}>
          {msg.text}
        </Notice>
      )}
      {loadError && (
        <Notice kind="err" onRetry={load}>
          Could not refresh the group: {loadError}
        </Notice>
      )}
      {d.group.description && <p className="text-sm text-zinc-400">{d.group.description}</p>}

      <Panel>
        <div id="members" className="mb-2 flex scroll-mt-4 flex-wrap items-end justify-between gap-2">
          <h2 className="text-sm font-semibold text-zinc-100">Members</h2>
          {d.members.length > 10 && (
            <Labeled label="Find a member" className="w-full sm:w-64">
              <input
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  t.setPage(1);
                }}
                placeholder="Name, email or user id"
                className={field}
              />
            </Labeled>
          )}
        </div>
        {d.members.length === 0 ? (
          <EmptyLine>No members.</EmptyLine>
        ) : members.length === 0 ? (
          <EmptyLine>No member matches “{q.trim()}”.</EmptyLine>
        ) : (
          <>
            {d.members.length > 10 && (
              <p className="mb-1 flex flex-wrap gap-3 text-xs text-zinc-400">
                Sort:
                {(
                  [
                    ["role", "Role"],
                    ["name", "Name"],
                    ["joined", "Joined"],
                  ] as const
                ).map(([k, l]) => (
                  <button
                    key={k}
                    type="button"
                    aria-pressed={t.sort.key === k}
                    onClick={() => t.onSort(k, t.sort.key === k ? (t.sort.dir === "asc" ? "desc" : "asc") : k === "joined" ? "desc" : "asc")}
                    className={`hover:text-zinc-200 ${t.sort.key === k ? "text-zinc-200 underline" : ""}`}
                  >
                    {l}
                    {t.sort.key === k ? (t.sort.dir === "asc" ? " ▲" : " ▼") : ""}
                  </button>
                ))}
              </p>
            )}
            <ul className="divide-y divide-white/5">
              {t.visible.map((m) => {
                const who = m.name || m.userId;
                return (
                  <li key={m.userId} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                    <Link href={`/admin/users/${encodeURIComponent(m.userId)}`} className="min-w-0 flex-1 truncate text-zinc-100 hover:underline">
                      {who}
                      {m.email && <span className="ml-2 text-xs text-zinc-400">{m.email}</span>}
                    </Link>
                    <Badge tone={m.role === "owner" ? "amber" : m.role === "participant" ? "zinc" : "cyan"}>{roleName(m.role)}</Badge>
                    <span className="text-xs text-zinc-400">
                      joined <Time ts={m.joinedAt} />
                    </span>
                    {write && m.role !== "owner" && (
                      <>
                        <button
                          type="button"
                          className={`${btn.warn} px-2 py-1 text-xs`}
                          aria-label={`Make owner: ${who}`}
                          onClick={() => {
                            setMsg(null);
                            setAsk({
                              title: `Make ${who} the owner?`,
                              body: `${who} becomes the group's owner.${owner ? ` ${owner.name} stays in the group as a Host.` : ""} The group's history records that an administrator did this.`,
                              confirmLabel: "Transfer ownership",
                              danger: true,
                              typeToConfirm: "transfer",
                              run: () => adminFetch(`${base}/owner`, { method: "POST", json: { userId: m.userId } }),
                              done: `${who} now owns the group.`,
                            });
                          }}
                        >
                          Make owner
                        </button>
                        <button
                          type="button"
                          className={`${btn.danger} px-2 py-1 text-xs`}
                          aria-label={`Remove ${who} from the group`}
                          onClick={() => {
                            setMsg(null);
                            setAsk({
                              title: `Remove ${who} from the group?`,
                              body: "They stop being a member and are no longer rung for the group's calls. Their meeting history is kept.",
                              confirmLabel: "Remove",
                              danger: true,
                              run: () => adminFetch(`${base}/members/${encodeURIComponent(m.userId)}`, { method: "DELETE" }),
                              done: `${who} was removed.`,
                            });
                          }}
                        >
                          Remove
                        </button>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
            {t.total > 25 && <Pager page={t.page} pageSize={t.pageSize} total={t.total} onPage={t.setPage} onPageSize={t.setPageSize} noun="member" />}
          </>
        )}
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel className="min-w-0">
          <h2 id="invited" className="mb-2 scroll-mt-4 text-sm font-semibold text-zinc-100">
            Invited, no account yet
          </h2>
          {d.pending.length === 0 ? (
            <EmptyLine>Nobody waiting.</EmptyLine>
          ) : (
            <ul className="space-y-1 text-sm">
              {d.pending.map((p) => (
                <li key={p.key} className="break-words">
                  <span className="text-zinc-200">{p.kind === "kc" ? `KingsChat @${p.value}` : p.value}</span>
                  <span className="text-xs text-zinc-400">
                    {" "}
                    · added <Time ts={p.addedAt} />
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-zinc-400">Invite links are not listed: they are kept by link only and expire after 72 hours.</p>
        </Panel>
        <Panel className="min-w-0">
          <h2 className="mb-2 text-sm font-semibold text-zinc-100">History</h2>
          {d.activity.length === 0 ? (
            <EmptyLine>Nothing recorded.</EmptyLine>
          ) : (
            <ul className="space-y-1 text-sm">
              {d.activity.map((a, i) => (
                <li key={i} className="break-words">
                  <span className="text-zinc-200">{a.detail}</span>
                  <span className="text-xs text-zinc-400">
                    {" "}
                    · <Time ts={a.ts} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
      {ask && (
        <Confirm
          title={ask.title}
          body={ask.body}
          confirmLabel={ask.confirmLabel}
          danger={ask.danger}
          typeToConfirm={ask.typeToConfirm}
          withReason={ask.withReason}
          onConfirm={(reason) => go(ask, reason)}
          onCancel={() => setAsk(null)}
        />
      )}
    </div>
  );
}
