"use client";

// Users: every account, searchable, filterable and sortable, a page at a
// time. Each row opens the account (/admin/users/[id]), where the actions
// are. The filters live in the address bar, so a filtered list can be
// bookmarked or shared with another administrator. Ticked rows can be
// tagged or untagged together (one tag call per account, as on its page).

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { PLANS } from "@/lib/planLimits";
import { Time, adminZone, errorText, fmtNumber, useAdmin, zoneLabel } from "../AdminApi";
import { Badge, Confirm, Empty, Labeled, Loading, Notice, PageHeader, Pager, SelectBox, TableWrap, btn, field, useSelection } from "../ui";

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
  /** The zone `from` and `to` are calendar days in; empty = the admin clock's zone. Set by links from the Overview. */
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

/** Same rule as the server's cleanTags: lower-case letters, digits, - and _. */
const cleanTag = (t: string) =>
  t
    .trim()
    .replace(/^#/, "")
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 32);

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

type Bulk = { op: "add" | "remove"; tag: string; rows: UserRow[] };

export default function UsersClient() {
  const { can, adminFetch } = useAdmin();
  const sp = useSearchParams();
  const [filters, setFilters] = useState<Filters | null>(null);
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [items, setItems] = useState<UserRow[] | null>(null);
  const [meta, setMeta] = useState<{ total: number; scanned: number | null; capped: boolean }>({ total: 0, scanned: null, capped: false });
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [bulkTag, setBulkTag] = useState("");
  const [bulk, setBulk] = useState<Bulk | null>(null);
  const filtersRef = useRef<Filters | null>(null);
  filtersRef.current = filters;
  const sel = useSelection((items ?? []).map((u) => u.id));
  const write = can("users:write");

  // Read the filters from the address bar on arrival, and again when a link
  // (a tag badge, the admin search) changes it while the page is open.
  const spKey = sp?.toString() ?? "";
  useEffect(() => {
    const f = fromLocation();
    if (filtersRef.current && toQuery(f) === toQuery(filtersRef.current)) return;
    setFilters(f);
    setDraft(f);
    // Old links ("/admin?deleted=1") still arrive here after an account was deleted.
    if (new URLSearchParams(window.location.search).get("deleted")) setMsg({ kind: "ok", text: "The account was deleted." });
  }, [spKey]);

  const load = useCallback(
    async (f: Filters) => {
      setItems(null);
      setError(null);
      window.history.replaceState(null, "", `/admin/users${toQuery(f)}`);
      // Sign-up days are on the admin clock unless a link named another zone.
      const api = toQuery({ ...f, tz: f.from || f.to ? f.tz || adminZone() : "" });
      const r = await adminFetch<{ items: UserRow[]; total: number; scanned: number | null; capped: boolean }>(`/api/admin/users${api}`);
      if (!r.ok) return setError(errorText(r));
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
  const active = filters && toQuery({ ...filters, page: 1, sort: EMPTY.sort, pageSize: EMPTY.pageSize, q: "" }) !== "";
  const zone = draft.tz || zoneLabel();
  const tagHref = (t: string) => `/admin/users${toQuery({ ...EMPTY, tag: t })}`;

  // Tag or untag the ticked accounts: the account's whole tag set is saved, as on its own page.
  const runBulk = async (b: Bulk) => {
    setMsg(null);
    let done = 0;
    const failed: string[] = [];
    for (const u of b.rows) {
      const next = b.op === "add" ? [...u.tags.filter((t) => t !== b.tag), b.tag] : u.tags.filter((t) => t !== b.tag);
      const r = await adminFetch(`/api/admin/users/${encodeURIComponent(u.id)}/tags`, { method: "PUT", json: { tags: next } });
      if (r.ok) done++;
      else {
        failed.push(`${u.email || u.id}: ${errorText(r)}`);
        // Cancelled at the code prompt: stop rather than ask again for every account.
        if (r.data.error === "cancelled") break;
      }
    }
    setBulk(null);
    const verb = b.op === "add" ? `#${b.tag} added to` : `#${b.tag} removed from`;
    setMsg(
      failed.length
        ? { kind: "err", text: `${verb} ${done} account${done === 1 ? "" : "s"}. Not changed: ${failed.join("; ")}` }
        : { kind: "ok", text: `${verb} ${done} account${done === 1 ? "" : "s"}.` },
    );
    sel.clear();
    if (filtersRef.current) load(filtersRef.current);
  };

  const askBulk = (op: Bulk["op"]) => {
    const tag = cleanTag(bulkTag);
    if (!tag || !items) return;
    const rows = items.filter((u) => sel.selected.has(u.id) && (op === "add" ? !u.tags.includes(tag) : u.tags.includes(tag)));
    if (!rows.length) return setMsg({ kind: "ok", text: op === "add" ? `Every ticked account already has #${tag}.` : `No ticked account has #${tag}.` });
    setBulk({ op, tag, rows });
  };

  return (
    <div>
      <PageHeader
        title="Users"
        sub={
          filters && items
            ? `${fmtNumber(meta.total)} account${meta.total === 1 ? "" : "s"}${active || filters.q ? " match" : ""}.${
                meta.scanned != null ? ` Filtered from ${fmtNumber(meta.scanned)} read in order${meta.capped ? " — there are more; narrow the search to reach them" : ""}.` : ""
              }`
            : "Every account on NeoConference."
        }
      />
      {msg && (
        <Notice kind={msg.kind} onClose={() => setMsg(null)}>
          {msg.text}
        </Notice>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          apply({});
        }}
        className="mb-4 space-y-2"
      >
        <div className="flex flex-wrap items-end gap-2">
          <Labeled label="Search" className="min-w-0 flex-1 basis-64">
            <input value={draft.q} onChange={set("q")} placeholder="Name, email, username or user id" className={field} />
          </Labeled>
          <button type="submit" className={btn.primary}>
            Search
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Labeled label="Plan">
            <select value={draft.plan} onChange={set("plan")} className={field}>
              <option value="">Any plan</option>
              {PLANS.map((p) => (
                <option key={p} value={p}>
                  {p[0].toUpperCase() + p.slice(1)}
                </option>
              ))}
            </select>
          </Labeled>
          <Labeled label="Role or access">
            <select value={draft.access} onChange={set("access")} className={field}>
              <option value="">Any role</option>
              <option value="owner">Owner</option>
              <option value="admin">Administrators</option>
              <option value="staff">Staff</option>
              <option value="user">Users</option>
            </select>
          </Labeled>
          <Labeled label="Email">
            <select value={draft.verified} onChange={set("verified")} className={field}>
              <option value="">Verified or not</option>
              <option value="yes">Email verified</option>
              <option value="no">Email not verified</option>
            </select>
          </Labeled>
          <Labeled label="Status">
            <select value={draft.status} onChange={set("status")} className={field}>
              <option value="">Any status</option>
              <option value="active">Active</option>
              <option value="suspended">Suspended</option>
              <option value="pending_deletion">Pending deletion</option>
            </select>
          </Labeled>
          <Labeled label="Tag">
            <input value={draft.tag} onChange={set("tag")} placeholder="Any tag" className={field} />
          </Labeled>
          <Labeled label={`Signed up from (${zone})`}>
            <input type="date" value={draft.from} onChange={set("from")} className={field} />
          </Labeled>
          <Labeled label={`Signed up to (${zone})`}>
            <input type="date" value={draft.to} onChange={set("to")} className={field} />
          </Labeled>
          <Labeled label="Sort">
            <select value={draft.sort} onChange={(e) => apply({ sort: e.target.value })} className={field}>
              {SORTS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </Labeled>
        </div>
        <div className="flex flex-wrap items-center gap-2">
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
        </div>
      </form>

      {write && sel.count > 0 && (
        <div role="region" aria-label="Bulk actions" className="mb-3 flex flex-wrap items-end gap-2 rounded-lg border border-cyan-400/30 bg-cyan-400/5 px-3 py-2 text-sm">
          <span className="self-center text-zinc-200">{sel.count} selected</span>
          <Labeled label="Tag">
            <input value={bulkTag} onChange={(e) => setBulkTag(e.target.value)} placeholder="e.g. vip" className={`${field} w-40`} />
          </Labeled>
          <button type="button" className={btn.ghost} disabled={!cleanTag(bulkTag)} onClick={() => askBulk("add")}>
            Add tag
          </button>
          <button type="button" className={btn.ghost} disabled={!cleanTag(bulkTag)} onClick={() => askBulk("remove")}>
            Remove tag
          </button>
          <button type="button" className={btn.ghost} onClick={sel.clear}>
            Clear selection
          </button>
          {!cleanTag(bulkTag) && <span className="self-center text-xs text-zinc-400">Type a tag to add or remove.</span>}
        </div>
      )}

      {error ? (
        <Notice kind="err" onRetry={() => filters && load(filters)}>
          {error}
        </Notice>
      ) : !items ? (
        <Loading />
      ) : items.length === 0 ? (
        <Empty>{active || filters?.q ? "No users match these filters." : "No accounts yet."}</Empty>
      ) : (
        <TableWrap minWidth={write ? 800 : 760}>
          <thead className="border-b border-white/10 text-xs text-zinc-400">
            <tr>
              {write && (
                <th className="w-8 px-3 py-2">
                  <SelectBox checked={sel.all} indeterminate={sel.some} onChange={sel.toggleAll} label="Select every account on this page" />
                </th>
              )}
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
                {write && (
                  <td className="px-3 py-2">
                    <SelectBox checked={sel.selected.has(u.id)} onChange={() => sel.toggle(u.id)} label={`Select ${u.name || u.email || u.id}`} />
                  </td>
                )}
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
                      <span className="block truncate text-xs text-zinc-400">
                        {u.email}
                        {u.email && !u.emailVerified && <span className="ml-1 text-amber-300">(unverified)</span>}
                      </span>
                    </span>
                  </Link>
                </td>
                <td className="px-3 py-2">
                  <span className="capitalize text-zinc-200">{u.plan}</span>
                  {u.planExpiresAt && (
                    <span className="block text-xs text-zinc-400">
                      until <Time ts={u.planExpiresAt} mode="date" />
                    </span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <span className="flex flex-wrap gap-1">
                    {statusBadges(u)}
                    {u.tags.map((t) => (
                      <Link key={t} href={tagHref(t)} aria-label={`Accounts tagged ${t}`} className="rounded hover:ring-1 hover:ring-cyan-400/50">
                        <Badge>#{t}</Badge>
                      </Link>
                    ))}
                  </span>
                </td>
                <td className="px-3 py-2 text-xs text-zinc-400">
                  <Time ts={u.createdAt} mode="date" />
                </td>
                <td className="px-3 py-2 text-xs text-zinc-400">{u.lastSignInAt ? <Time ts={u.lastSignInAt} /> : "Never"}</td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
      {filters && items && !error && meta.total > 0 && (
        <Pager
          page={filters.page}
          pageSize={filters.pageSize}
          total={meta.total}
          noun="account"
          onPage={(page) => setFilters({ ...filters, page })}
          onPageSize={(pageSize) => {
            setDraft((d) => ({ ...d, pageSize }));
            setFilters({ ...filters, pageSize, page: 1 });
          }}
        />
      )}

      {bulk && (
        <Confirm
          title={bulk.op === "add" ? `Tag ${bulk.rows.length} account${bulk.rows.length === 1 ? "" : "s"} #${bulk.tag}?` : `Remove #${bulk.tag} from ${bulk.rows.length} account${bulk.rows.length === 1 ? "" : "s"}?`}
          body={
            <>
              <p>Each account is saved on its own and recorded in the audit log. Accounts an administrator cannot change (the owner) are listed afterwards.</p>
              <p className="mt-2 break-words text-xs text-zinc-400">
                {bulk.rows
                  .slice(0, 8)
                  .map((u) => u.email || u.id)
                  .join(", ")}
                {bulk.rows.length > 8 ? ` and ${bulk.rows.length - 8} more` : ""}
              </p>
            </>
          }
          confirmLabel={bulk.op === "add" ? "Add tag" : "Remove tag"}
          onCancel={() => setBulk(null)}
          onConfirm={() => runBulk(bulk)}
        />
      )}
    </div>
  );
}
