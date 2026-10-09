"use client";

// Content > Files: every stored object the app made, searchable by owner,
// type, status, visibility, size and date. Metadata only; opening a file
// is on its own page. Also where the index is filled in from storage
// (the backfill), a slice at a time. The filters live in the address bar,
// so a link (Overview, Storage, global search) opens the same view.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { CONTENT_TYPES, PROCESSING_STATUSES, VISIBILITIES, formatBytes } from "@/lib/content/model";
import { fmtNumber, fmtTime, fromZonedInput, useAdmin, zoneLabel } from "../AdminApi";
import { Confirm, Empty, FilterBar, Labeled, Loading, Notice, PageHeader, Pager, SortTh, StatTile, TableWrap, btn, field, useUrlFilters } from "../ui";
import { Bytes, ContentTabs, OwnerLink, Related, StateBadge, StatusBadge, TypeLabel, VisibilityBadge, fileLabel, type FileRow } from "./content-ui";

type Backfill = {
  token: string | null;
  passStartedAt: number | null;
  pass: { objects: number; bytes: number; added: number; updated: number };
  runs: number;
  lastRunAt: number | null;
  lastCompletePass: { objects: number; bytes: number; added: number; updated: number; startedAt: number; finishedAt: number } | null;
};

type ListResponse = {
  items: FileRow[];
  total: number;
  matchedBytes: number;
  totals: { files: number; bytes: number; byType: { type: FileRow["type"]; files: number; bytes: number }[] };
  backfill: Backfill;
};

const DEFAULTS = { q: "", owner: "", type: "", status: "", visibility: "", state: "", minMb: "", maxMb: "", from: "", to: "", sort: "createdAt", dir: "desc", page: "1", size: "50" };
type Filters = typeof DEFAULTS;
// The boxes typed into before Search; the rest apply as soon as they change.
type Typed = "q" | "owner" | "minMb" | "maxMb";

/** A calendar day on the admin clock as the instant it starts (or ends). */
function dayEdge(day: string, end: boolean): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const start = fromZonedInput(`${day}T00:00`);
  if (start == null) return null;
  if (!end) return start;
  const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const nextStart = fromZonedInput(`${next}T00:00`);
  return nextStart == null ? null : nextStart - 1;
}

export default function FilesClient() {
  const { can, adminFetch } = useAdmin();
  const filters = useUrlFilters(DEFAULTS);
  const f = filters.value;
  const [draft, setDraft] = useState<Pick<Filters, Typed>>({ q: f.q, owner: f.owner, minMb: f.minMb, maxMb: f.maxMb });
  // When the address changes (a link, Back, Clear), the boxes follow.
  useEffect(() => setDraft({ q: f.q, owner: f.owner, minMb: f.minMb, maxMb: f.maxMb }), [f.q, f.owner, f.minMb, f.maxMb]);
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [scanning, setScanning] = useState(false);
  const [askRestart, setAskRestart] = useState(false);
  const page = Math.max(1, Number(f.page) || 1);
  const pageSize = [25, 50, 100, 200].includes(Number(f.size)) ? Number(f.size) : 50;

  const query = (() => {
    const p = new URLSearchParams();
    if (f.q) p.set("q", f.q);
    if (f.owner) p.set("owner", f.owner);
    for (const k of ["type", "status", "visibility", "state", "sort", "dir"] as const) if (f[k]) p.set(k, f[k]);
    // Days are on the admin clock; the server takes the instants.
    const from = dayEdge(f.from, false);
    const to = dayEdge(f.to, true);
    if (from != null) p.set("from", String(from));
    if (to != null) p.set("to", String(to));
    if (f.minMb) p.set("minSize", String(Math.round(Number(f.minMb) * 1024 * 1024)));
    if (f.maxMb) p.set("maxSize", String(Math.round(Number(f.maxMb) * 1024 * 1024)));
    p.set("limit", String(pageSize));
    p.set("offset", String((page - 1) * pageSize));
    return p.toString();
  })();

  const load = useCallback(async () => {
    setLoading(true);
    setLoadErr(null);
    const r = await adminFetch<ListResponse>(`/api/admin/content?${query}`);
    setLoading(false);
    if (!r.ok) return setLoadErr(r.data.message ?? `HTTP ${r.status}`);
    setData(r.data);
  }, [adminFetch, query]);
  useEffect(() => {
    load();
  }, [load]);

  const scan = async (restart = false) => {
    setScanning(true);
    setMsg(null);
    const r = await adminFetch<{ run: { scanned: number; added: number; updated: number; bytes: number; stoppedBy: string } }>("/api/admin/content/backfill", {
      method: "POST",
      json: { restart },
    });
    setScanning(false);
    if (!r.ok) {
      if (r.data.error !== "cancelled") setMsg({ kind: "err", text: r.data.message ?? "The scan failed." });
      return;
    }
    const run = r.data.run;
    setMsg({
      kind: "ok",
      text: `Scanned ${fmtNumber(run.scanned)} objects (${formatBytes(run.bytes)}): ${fmtNumber(run.added)} added to the index, ${fmtNumber(run.updated)} updated. ${
        run.stoppedBy === "complete" ? "The scan reached the end of storage." : "Stopped at this run's limit — scan again to carry on."
      }`,
    });
    load();
  };

  const apply = (patch: Partial<Filters>) => filters.set({ ...patch, page: "1" });
  const bf = data?.backfill;
  const sort = { key: f.sort, dir: f.dir === "asc" ? ("asc" as const) : ("desc" as const) };

  return (
    <div>
      <PageHeader
        title="Content"
        sub={
          data
            ? `${fmtNumber(data.totals.files)} files, ${formatBytes(data.totals.bytes)} in all. Searching shows metadata only; a private file's contents open only within a support session on its owner.`
            : "Recordings, transcripts and uploaded files."
        }
        actions={
          can("content:moderate") ? (
            <>
              <button type="button" className={btn.ghost} disabled={scanning} onClick={() => scan(false)} title="List storage and add anything the index does not know yet. Read-only: nothing in storage is changed.">
                {scanning ? "Scanning…" : bf?.token ? "Continue storage scan" : "Scan storage"}
              </button>
              {bf?.token && (
                <button type="button" className={btn.ghost} disabled={scanning} onClick={() => setAskRestart(true)}>
                  Start over
                </button>
              )}
            </>
          ) : null
        }
      />
      <ContentTabs />
      {msg && (
        <Notice kind={msg.kind} onClose={() => setMsg(null)}>
          {msg.text}
        </Notice>
      )}
      {can("content:moderate") && <p className="mb-2 text-xs text-zinc-400">A storage scan only reads storage and adds what the index is missing; nothing in storage is changed.</p>}
      {bf && (
        <p className="mb-3 text-xs text-zinc-400">
          {bf.lastCompletePass
            ? `Last complete storage scan ${fmtTime(bf.lastCompletePass.finishedAt)}: ${fmtNumber(bf.lastCompletePass.objects)} objects, ${formatBytes(bf.lastCompletePass.bytes)}.`
            : "Storage has not been scanned to the end yet, so files missing from storage cannot be detected."}{" "}
          {bf.token ? `A scan is part-way through (${fmtNumber(bf.pass.objects)} objects so far).` : ""}
        </p>
      )}
      {data && data.totals.byType.length > 0 && (
        <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {data.totals.byType.map((t) => (
            <StatTile
              key={t.type}
              label={<TypeLabel t={t.type} />}
              value={<Bytes n={t.bytes} />}
              hint={`${fmtNumber(t.files)} files, trash included`}
              active={f.type === t.type}
              // The figure counts every state, so the list it opens does too (as the Overview's link does).
              onClick={() => apply(f.type === t.type ? { type: "" } : { type: t.type, state: "all" })}
            />
          ))}
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          apply({ q: draft.q.trim(), owner: draft.owner.trim(), minMb: draft.minMb.trim(), maxMb: draft.maxMb.trim() });
        }}
      >
        <FilterBar active={filters.active} onClear={filters.reset}>
          <Labeled label="Search" className="w-full sm:w-64">
            <input value={draft.q} onChange={(e) => setDraft({ ...draft, q: e.target.value })} placeholder="Name, path, meeting, owner id" className={field} />
          </Labeled>
          <Labeled label="Owner account id" className="w-full sm:w-52">
            <input value={draft.owner} onChange={(e) => setDraft({ ...draft, owner: e.target.value })} placeholder="user_…" className={field} />
          </Labeled>
          <Labeled label="Type">
            <select value={f.type} onChange={(e) => apply({ type: e.target.value })} className={field}>
              <option value="">Any type</option>
              {CONTENT_TYPES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </Labeled>
          <Labeled label="Status">
            <select value={f.status} onChange={(e) => apply({ status: e.target.value })} className={field}>
              <option value="">Any status</option>
              {PROCESSING_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Labeled>
          <Labeled label="Visibility">
            <select value={f.visibility} onChange={(e) => apply({ visibility: e.target.value })} className={field}>
              <option value="">Any visibility</option>
              {VISIBILITIES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Labeled>
          <Labeled label="Moderation">
            <select value={f.state} onChange={(e) => apply({ state: e.target.value })} className={field}>
              <option value="">Not in trash</option>
              <option value="active">Published</option>
              <option value="hidden">Hidden</option>
              <option value="trashed">In trash</option>
              <option value="all">Everything</option>
            </select>
          </Labeled>
          <Labeled label="Min MB" className="w-24">
            <input value={draft.minMb} onChange={(e) => setDraft({ ...draft, minMb: e.target.value })} inputMode="decimal" className={field} />
          </Labeled>
          <Labeled label="Max MB" className="w-24">
            <input value={draft.maxMb} onChange={(e) => setDraft({ ...draft, maxMb: e.target.value })} inputMode="decimal" className={field} />
          </Labeled>
          <Labeled label={`Created from (${zoneLabel()})`}>
            <input type="date" value={f.from} max={f.to || undefined} onChange={(e) => apply({ from: e.target.value })} className={field} />
          </Labeled>
          <Labeled label="Created to">
            <input type="date" value={f.to} min={f.from || undefined} onChange={(e) => apply({ to: e.target.value })} className={field} />
          </Labeled>
          <button type="submit" className={btn.primary}>
            Search
          </button>
        </FilterBar>
      </form>
      {loadErr && (
        <Notice kind="err" onRetry={load}>
          {loadErr}
        </Notice>
      )}
      {!data ? (
        !loadErr && <Loading />
      ) : data.items.length === 0 ? (
        <Empty>No files match. {data.totals.files === 0 && can("content:moderate") ? "The index is empty — scan storage to fill it." : ""}</Empty>
      ) : (
        <div aria-busy={loading} className={loading ? "opacity-60 transition-opacity" : "transition-opacity"}>
          <p className="mb-2 text-xs text-zinc-400">
            {fmtNumber(data.total)} match{data.total === 1 ? "" : "es"}, {formatBytes(data.matchedBytes)}.
          </p>
          <TableWrap minWidth={860}>
            <thead className="border-b border-white/10 text-xs text-zinc-400">
              <tr>
                <SortTh label="File" k="name" sort={sort} onSort={(k, dir) => apply({ sort: k, dir })} />
                <th className="px-3 py-2 font-medium">Owner</th>
                <SortTh label="Size" k="size" sort={sort} onSort={(k, dir) => apply({ sort: k, dir })} />
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Visibility</th>
                <SortTh label="Created" k="createdAt" sort={sort} onSort={(k, dir) => apply({ sort: k, dir })} />
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {data.items.map((x) => (
                <tr key={x.id} className="hover:bg-white/[0.03]">
                  <td className="max-w-[320px] px-3 py-2">
                    <Link href={`/admin/content/files/${x.id}`} className="block truncate font-medium text-cyan-200 hover:underline" title={x.key}>
                      {fileLabel(x)}
                    </Link>
                    <span className="flex flex-wrap items-center gap-1.5 text-xs text-zinc-400">
                      <TypeLabel t={x.type} />
                      <Related f={x} />
                      <StateBadge s={x.state} />
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <OwnerLink id={x.ownerId} />
                  </td>
                  <td className="px-3 py-2 text-zinc-300">
                    <Bytes n={x.size} />
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge s={x.status} detail={x.statusDetail} />
                  </td>
                  <td className="px-3 py-2">
                    <VisibilityBadge v={x.effectiveVisibility} />
                  </td>
                  <td className="px-3 py-2 text-xs text-zinc-400">{fmtTime(x.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
          <Pager
            page={page}
            pageSize={pageSize}
            total={data.total}
            onPage={(n) => filters.set({ page: String(n) })}
            onPageSize={(n) => filters.set({ size: String(n), page: "1" })}
            sizes={[25, 50, 100, 200]}
            noun="file"
          />
        </div>
      )}
      {askRestart && (
        <Confirm
          title="Start the storage scan over?"
          body="The scan part-way through is dropped and the next run starts from the beginning of storage. Nothing in storage or the index is removed."
          confirmLabel="Start over"
          onConfirm={async () => {
            await scan(true);
            setAskRestart(false);
          }}
          onCancel={() => setAskRestart(false)}
        />
      )}
    </div>
  );
}
