"use client";

// Users: every account, searchable, filterable and sortable, a page at a
// time. Each row opens the account (/admin/users/[id]), where the actions
// are. The filters live in the address bar, so a filtered list can be
// bookmarked or shared with another administrator.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { PLANS } from "@/lib/planLimits";
import { fmtTime, useAdmin } from "../AdminApi";
import { Badge, Empty, Loading, Notice, PageHeader, Panel, btn, field } from "../ui";

export type UserRow = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  imageUrl: string;
  plan: string;
  storedPlan: string | null;
  planExpiresAt: number | null;
  appRole: "admin" | "staff" | "user";
  access: string | null;
  banned: boolean;
  locked: boolean;
  createdAt: number | null;
  lastSignInAt: number | null;
  lastActiveAt: number | null;
  tags: string[];
  pendingDeletion: { deleteAfter: number } | null;
};

type Filters = {
  q: string;
  plan: string;
  access: string;
  verified: string;
  status: string;
  tag: string;
  from: string;
  to: string;
  /** The zone `from` and `to` are calendar days in; empty = UTC. Set by links from the Overview. */
  tz: string;
  sort: string;
  page: number;
  pageSize: number;
};

const EMPTY: Filters = { q: "", plan: "", access: "", verified: "", status: "", tag: "", from: "", to: "", tz: "", sort: "-created_at", page: 1, pageSize: 25 };

const SORTS: [string, string][] = [
  ["-created_at", "Newest sign-ups"],
  ["created_at", "Oldest sign-ups"],
  ["-last_sign_in_at", "Signed in most recently"],
  ["-last_active_at", "Active most recently"],
  ["email_address", "Email A–Z"],
  ["first_name", "First name A–Z"],
];

function fromLocation(): Filters {
  const p = new URLSearchParams(window.location.search);
  const f = { ...EMPTY };
  for (const k of Object.keys(EMPTY) as (keyof Filters)[]) {
    const v = p.get(k);
    if (v == null) continue;
    if (k === "page" || k === "pageSize") f[k] = Number(v) || EMPTY[k];
    else f[k] = v;
  }
  return f;
}

function toQuery(f: Filters): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v !== "" && v !== EMPTY[k as keyof Filters]) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

export function statusBadges(u: Pick<UserRow, "access" | "banned" | "locked" | "pendingDeletion" | "appRole">) {
  return (
    <>
      {u.access && <Badge tone={u.access === "owner" ? "amber" : u.access === "admin" ? "cyan" : "red"}>{u.access}</Badge>}
      {!u.access && u.appRole === "staff" && <Badge tone="cyan">staff</Badge>}
      {u.pendingDeletion ? <Badge tone="red">pending deletion</Badge> : u.banned ? <Badge tone="red">suspended</Badge> : null}
      {u.locked && <Badge tone="amber">locked</Badge>}
    </>
  );
}

export default function UsersClient() {
  const { adminFetch } = useAdmin();
  const [filters, setFilters] = useState<Filters | null>(null);
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [items, setItems] = useState<UserRow[] | null>(null);
  const [meta, setMeta] = useState<{ total: number; scanned: number | null; capped: boolean }>({ total: 0, scanned: null, capped: false });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const f = fromLocation();
    setFilters(f);
    setDraft(f);
  }, []);

  const load = useCallback(
    async (f: Filters) => {
      setItems(null);
      setError(null);
      window.history.replaceState(null, "", `/admin/users${toQuery(f)}`);
      const r = await adminFetch<{ items: UserRow[]; total: number; scanned: number | null; capped: boolean }>(`/api/admin/users${toQuery(f)}`);
      if (!r.ok) {
        setError(r.data.message ?? r.data.error ?? `HTTP ${r.status}`);
        setItems([]);
        return;
      }
      setItems(r.data.items ?? []);
      setMeta({ total: r.data.total ?? 0, scanned: r.data.scanned ?? null, capped: !!r.data.capped });
    },
    [adminFetch],
  );

  useEffect(() => {
    if (filters) load(filters);
  }, [filters, load]);

  const apply = (patch: Partial<Filters>) => setFilters({ ...draft, ...patch, page: patch.page ?? 1 });
  const set = (k: keyof Filters) => (e: { target: { value: string } }) => setDraft((d) => ({ ...d, [k]: e.target.value }));
  const pages = filters ? Math.max(1, Math.ceil(meta.total / filters.pageSize)) : 1;
  const active = filters && toQuery({ ...filters, page: 1, sort: EMPTY.sort, pageSize: EMPTY.pageSize, q: "" }) !== "";

  return (
    <div>
      <PageHeader
        title="Users"
        sub={
          filters && items
            ? `${meta.total} account${meta.total === 1 ? "" : "s"}${active || filters.q ? " match" : ""}.${
                meta.scanned != null ? ` Filtered from ${meta.scanned} read in order${meta.capped ? " — there are more; narrow the search to reach them" : ""}.` : ""
              }`
            : "Every account on NeoConference."
        }
      />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          apply({});
        }}
        className="mb-4 space-y-2"
      >
        <div className="flex gap-2">
          <input value={draft.q} onChange={set("q")} placeholder="Search name, email, username or user id" aria-label="Search users" className={field} />
          <button type="submit" className={btn.primary}>
            Search
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
          <select aria-label="Plan" value={draft.plan} onChange={set("plan")} className={field}>
            <option value="">Any plan</option>
            {PLANS.map((p) => (
              <option key={p} value={p}>
                {p[0].toUpperCase() + p.slice(1)}
              </option>
            ))}
          </select>
          <select aria-label="Role or access" value={draft.access} onChange={set("access")} className={field}>
            <option value="">Any role</option>
            <option value="owner">Owner</option>
            <option value="admin">Administrators</option>
            <option value="staff">Staff</option>
            <option value="user">Users</option>
          </select>
          <select aria-label="Email verified" value={draft.verified} onChange={set("verified")} className={field}>
            <option value="">Verified or not</option>
            <option value="yes">Email verified</option>
            <option value="no">Email not verified</option>
          </select>
          <select aria-label="Status" value={draft.status} onChange={set("status")} className={field}>
            <option value="">Any status</option>
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
            <option value="pending_deletion">Pending deletion</option>
          </select>
          <input aria-label="Tag" value={draft.tag} onChange={set("tag")} placeholder="Tag" className={field} />
          <label className="flex items-center gap-1 text-xs text-zinc-400">
            From
            <input type="date" aria-label="Signed up from" value={draft.from} onChange={set("from")} className={field} />
          </label>
          <label className="flex items-center gap-1 text-xs text-zinc-400">
            To
            <input type="date" aria-label="Signed up to" value={draft.to} onChange={set("to")} className={field} />
          </label>
          <select aria-label="Sort" value={draft.sort} onChange={(e) => apply({ sort: e.target.value })} className={field}>
            {SORTS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="submit" className={btn.ghost}>
            Apply filters
          </button>
          {active && (
            <button
              type="button"
              className={btn.ghost}
              onClick={() => {
                const cleared = { ...EMPTY, q: draft.q, sort: draft.sort, pageSize: draft.pageSize };
                setDraft(cleared);
                setFilters(cleared);
              }}
            >
              Clear filters
            </button>
          )}
          {(draft.from || draft.to) && <span className="self-center text-xs text-zinc-500">Sign-up dates are days in {draft.tz || "UTC"}.</span>}
        </div>
      </form>
      {error && <Notice kind="err">{error}</Notice>}
      {!items ? (
        <Loading />
      ) : items.length === 0 ? (
        <Empty>No users match.</Empty>
      ) : (
        <Panel className="overflow-x-auto p-0">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="border-b border-white/10 text-xs text-zinc-500">
              <tr>
                <th className="px-3 py-2 font-medium">Account</th>
                <th className="px-3 py-2 font-medium">Plan</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Signed up</th>
                <th className="px-3 py-2 font-medium">Last sign-in</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {items.map((u) => (
                <tr key={u.id} className="hover:bg-white/[0.03]">
                  <td className="px-3 py-2">
                    <Link href={`/admin/users/${encodeURIComponent(u.id)}`} className="flex items-center gap-3">
                      {u.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={u.imageUrl} alt="" width={28} height={28} className="rounded-full" />
                      ) : (
                        <span className="h-7 w-7 shrink-0 rounded-full bg-white/10" />
                      )}
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-zinc-100">{u.name || u.email || u.id}</span>
                        <span className="block truncate text-xs text-zinc-500">
                          {u.email}
                          {u.email && !u.emailVerified && <span className="ml-1 text-amber-300">(unverified)</span>}
                        </span>
                      </span>
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    <span className="capitalize text-zinc-200">{u.plan}</span>
                    {u.planExpiresAt && <span className="block text-xs text-zinc-500">until {new Date(u.planExpiresAt).toLocaleDateString()}</span>}
                  </td>
                  <td className="px-3 py-2">
                    <span className="flex flex-wrap gap-1">
                      {statusBadges(u)}
                      {u.tags.map((t) => (
                        <Badge key={t}>#{t}</Badge>
                      ))}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs text-zinc-400">{u.createdAt ? new Date(u.createdAt).toLocaleDateString() : "—"}</td>
                  <td className="px-3 py-2 text-xs text-zinc-400">{u.lastSignInAt ? fmtTime(u.lastSignInAt) : "Never"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
      {filters && items && meta.total > 0 && (
        <nav aria-label="Pages" className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm text-zinc-400">
          <span>
            Page {filters.page} of {pages}
          </span>
          <span className="flex items-center gap-2">
            <select
              aria-label="Page size"
              value={filters.pageSize}
              onChange={(e) => {
                const pageSize = Number(e.target.value);
                setDraft((d) => ({ ...d, pageSize }));
                setFilters({ ...filters, pageSize, page: 1 });
              }}
              className={`${field} w-auto`}
            >
              {[25, 50, 100].map((n) => (
                <option key={n} value={n}>
                  {n} a page
                </option>
              ))}
            </select>
            <button type="button" className={btn.ghost} disabled={filters.page <= 1} onClick={() => setFilters({ ...filters, page: filters.page - 1 })}>
              Previous
            </button>
            <button type="button" className={btn.ghost} disabled={filters.page >= pages} onClick={() => setFilters({ ...filters, page: filters.page + 1 })}>
              Next
            </button>
          </span>
        </nav>
      )}
    </div>
  );
}
