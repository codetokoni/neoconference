"use client";

// One group: owner, members, people invited before they had an account,
// and its history. Ownership can be transferred and members removed; both
// are confirmed, audited, and written into the group's own history.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { fmtTime, useAdmin, type ApiResult } from "../../AdminApi";
import { Badge, Confirm, Loading, Notice, PageHeader, Panel, btn } from "../../ui";

type Member = { userId: string; role: string; name: string; email?: string; joinedAt: number; addedBy: string | null };
type Detail = {
  group: { id: string; name: string; description: string; createdAt: string; ownerId: string | null; memberCount: number; pendingCount: number };
  settings: { retryIntervalMin: number; maxAttempts: number };
  members: Member[];
  pending: { key: string; kind: string; value: string; addedAt: number }[];
  activity: { ts: number; type: string; detail: string }[];
};
type Ask = { title: string; body: string; confirmLabel: string; danger?: boolean; run: () => Promise<ApiResult>; done: string };

const roleName = (r: string) => (r === "participant" ? "Member" : r[0].toUpperCase() + r.slice(1));

export default function GroupClient({ gid }: { gid: string }) {
  const { can, adminFetch } = useAdmin();
  const [d, setD] = useState<Detail | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const base = `/api/admin/groups/${encodeURIComponent(gid)}`;

  const load = useCallback(async () => {
    const r = await adminFetch<Detail>(base);
    if (r.ok) setD(r.data);
    else setMsg({ kind: "err", text: r.data.message ?? `HTTP ${r.status}` });
  }, [adminFetch, base]);
  useEffect(() => {
    load();
  }, [load]);

  const go = async (a: Ask) => {
    setAsk(null);
    setMsg(null);
    const r = await a.run();
    if (!r.ok) return setMsg({ kind: "err", text: r.data.message ?? r.data.error ?? `HTTP ${r.status}` });
    setMsg({ kind: "ok", text: a.done });
    load();
  };

  if (!d) return msg ? <Notice kind="err">{msg.text}</Notice> : <Loading />;
  const write = can("users:write");
  const owner = d.members.find((m) => m.role === "owner");

  return (
    <div className="space-y-4">
      <Link href="/admin/groups" className="text-sm text-cyan-300 hover:underline">
        ← Groups
      </Link>
      <PageHeader
        title={d.group.name}
        sub={`${d.group.memberCount} member${d.group.memberCount === 1 ? "" : "s"}${d.group.pendingCount ? `, ${d.group.pendingCount} invited` : ""} · created ${fmtTime(Date.parse(d.group.createdAt))}`}
      />
      {msg && (
        <Notice kind={msg.kind} onClose={() => setMsg(null)}>
          {msg.text}
        </Notice>
      )}
      {d.group.description && <p className="text-sm text-zinc-400">{d.group.description}</p>}

      <Panel>
        <h2 className="mb-2 text-sm font-semibold text-zinc-100">Members</h2>
        <ul className="divide-y divide-white/5">
          {d.members.map((m) => (
            <li key={m.userId} className="flex flex-wrap items-center gap-2 py-2 text-sm">
              <Link href={`/admin/users/${encodeURIComponent(m.userId)}`} className="min-w-0 flex-1 truncate text-zinc-100 hover:underline">
                {m.name || m.userId}
                {m.email && <span className="ml-2 text-xs text-zinc-500">{m.email}</span>}
              </Link>
              <Badge tone={m.role === "owner" ? "amber" : m.role === "participant" ? "zinc" : "cyan"}>{roleName(m.role)}</Badge>
              <span className="text-xs text-zinc-500">joined {fmtTime(m.joinedAt)}</span>
              {write && m.role !== "owner" && (
                <>
                  <button
                    type="button"
                    className={`${btn.ghost} px-2 py-1 text-xs`}
                    onClick={() =>
                      setAsk({
                        title: `Make ${m.name} the owner?`,
                        body: `${m.name} becomes the group's owner.${owner ? ` ${owner.name} stays in the group as a Host.` : ""} The group's history records that an administrator did this.`,
                        confirmLabel: "Transfer ownership",
                        run: () => adminFetch(`${base}/owner`, { method: "POST", json: { userId: m.userId } }),
                        done: `${m.name} now owns the group.`,
                      })
                    }
                  >
                    Make owner
                  </button>
                  <button
                    type="button"
                    className={`${btn.danger} px-2 py-1 text-xs`}
                    onClick={() =>
                      setAsk({
                        title: `Remove ${m.name} from the group?`,
                        body: "They stop being a member and are no longer rung for the group's calls. Their meeting history is kept.",
                        confirmLabel: "Remove",
                        danger: true,
                        run: () => adminFetch(`${base}/members/${encodeURIComponent(m.userId)}`, { method: "DELETE" }),
                        done: `${m.name} was removed.`,
                      })
                    }
                  >
                    Remove
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel>
          <h2 className="mb-2 text-sm font-semibold text-zinc-100">Invited, no account yet</h2>
          {d.pending.length === 0 ? (
            <p className="text-sm text-zinc-500">Nobody waiting.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {d.pending.map((p) => (
                <li key={p.key}>
                  <span className="text-zinc-200">{p.kind === "kc" ? `KingsChat @${p.value}` : p.value}</span>
                  <span className="text-xs text-zinc-500"> · added {fmtTime(p.addedAt)}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-zinc-500">Invite links are not listed: they are kept by link only and expire after 72 hours.</p>
        </Panel>
        <Panel>
          <h2 className="mb-2 text-sm font-semibold text-zinc-100">History</h2>
          {d.activity.length === 0 ? (
            <p className="text-sm text-zinc-500">Nothing recorded.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {d.activity.map((a, i) => (
                <li key={i}>
                  <span className="text-zinc-200">{a.detail}</span>
                  <span className="text-xs text-zinc-500"> · {fmtTime(a.ts)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
      {ask && <Confirm title={ask.title} body={ask.body} confirmLabel={ask.confirmLabel} danger={ask.danger} onConfirm={() => go(ask)} onCancel={() => setAsk(null)} />}
    </div>
  );
}
