"use client";

// Content > Files: every stored object the app made, searchable by owner,
// type, status, visibility, size and date. Metadata only; opening a file
// is on its own page. Also where the index is filled in from storage
// (the backfill), a slice at a time.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { CONTENT_TYPES, PROCESSING_STATUSES, VISIBILITIES, formatBytes } from "@/lib/content/model";
import { fmtTime, useAdmin } from "../AdminApi";
import { Empty, Loading, Notice, PageHeader, Panel, btn, field } from "../ui";
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

const EMPTY_FILTERS = { q: "", owner: "", type: "", status: "", visibility: "", state: "", minMb: "", maxMb: "", from: "", to: "", sort: "createdAt", dir: "desc" };

export default function FilesClient({ initial = {} }: { initial?: { owner?: string; type?: string } }) {
  const { can, adminFetch } = useAdmin();
  const [form, setForm] = useState({ ...EMPTY_FILTERS, ...initial });
  const [filters, setFilters] = useState({ ...EMPTY_FILTERS, ...initial });
  const [page, setPage] = useState(0);
  const [data, setData] = useState<ListResponse | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [scanning, setScanning] = useState(false);
  const pageSize = 50;

  const load = useCallback(async () => {
    setData(null);
    const p = new URLSearchParams();
    if (filters.q) p.set("q", filters.q);
    if (filters.owner) p.set("owner", filters.owner);
    for (const k of ["type", "status", "visibility", "state", "from", "to", "sort", "dir"] as const) if (filters[k]) p.set(k, filters[k]);
    if (filters.minMb) p.set("minSize", String(Math.round(Number(filters.minMb) * 1024 * 1024)));
    if (filters.maxMb) p.set("maxSize", String(Math.round(Number(filters.maxMb) * 1024 * 1024)));
    p.set("limit", String(pageSize));
    p.set("offset", String(page * pageSize));
    const r = await adminFetch<ListResponse>(`/api/admin/content?${p}`);
    if (!r.ok) {
      setMsg({ kind: "err", text: r.data.message ?? `HTTP ${r.status}` });
      return;
    }
    setData(r.data);
  }, [adminFetch, filters, page]);
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
    if (!r.ok) return setMsg({ kind: "err", text: r.data.message ?? "The scan failed." });
    const run = r.data.run;
    setMsg({
      kind: "ok",
      text: `Scanned ${run.scanned.toLocaleString()} objects (${formatBytes(run.bytes)}): ${run.added} added to the index, ${run.updated} updated. ${
        run.stoppedBy === "complete" ? "The scan reached the end of storage." : "Stopped at this run's limit — scan again to carry on."
      }`,
    });
    load();
  };

  const set = (k: keyof typeof EMPTY_FILTERS) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const bf = data?.backfill;
  const pages = data ? Math.max(1, Math.ceil(data.total / pageSize)) : 1;

  return (
    <div>
      <PageHeader
        title="Content"
        sub={
          data
            ? `${data.totals.files.toLocaleString()} files, ${formatBytes(data.totals.bytes)} in all. Searching shows metadata only; a private file's contents open only within a support session on its owner.`
            : "Recordings, transcripts and uploaded files."
        }
        actions={
          can("content:moderate") ? (
            <>
              <button type="button" className={btn.ghost} disabled={scanning} onClick={() => scan(false)} title="List storage and add anything the index does not know yet. Read-only: nothing in storage is changed.">
                {scanning ? "Scanning…" : bf?.token ? "Continue storage scan" : "Scan storage"}
              </button>
              {bf?.token && (
                <button type="button" className={btn.ghost} disabled={scanning} onClick={() => scan(true)}>
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
      {bf && (
        <p className="mb-3 text-xs text-zinc-500">
          {bf.lastCompletePass
            ? `Last complete storage scan ${fmtTime(bf.lastCompletePass.finishedAt)}: ${bf.lastCompletePass.objects.toLocaleString()} objects, ${formatBytes(bf.lastCompletePass.bytes)}.`
            : "Storage has not been scanned to the end yet, so files missing from storage cannot be detected."}{" "}
          {bf.token ? `A scan is part-way through (${bf.pass.objects.toLocaleString()} objects so far).` : ""}
        </p>
      )}
      {data && data.totals.byType.length > 0 && (
        <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {data.totals.byType.map((t) => (
            <button
              key={t.type}
              type="button"
              onClick={() => {
                const next = { ...form, type: t.type };
                setForm(next);
                setFilters(next);
                setPage(0);
              }}
              className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-left hover:border-cyan-400/40"
            >
              <span className="block text-xs text-zinc-400">
                <TypeLabel t={t.type} />
              </span>
              <span className="text-sm font-medium text-white">
                <Bytes n={t.bytes} />
              </span>
              <span className="text-xs text-zinc-500"> · {t.files.toLocaleString()} files</span>
            </button>
          ))}
        </div>
      )}
      <form
        className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4"
        onSubmit={(e) => {
          e.preventDefault();
          setPage(0);
          setFilters(form);
        }}
      >
        <input value={form.q} onChange={set("q")} placeholder="Search name, path, meeting, owner id" aria-label="Search files" className={`${field} sm:col-span-2`} />
        <input value={form.owner} onChange={set("owner")} placeholder="Owner account id (user_…)" aria-label="Owner" className={field} />
        <select value={form.type} onChange={set("type")} aria-label="Type" className={field}>
          <option value="">Any type</option>
          {CONTENT_TYPES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
        <select value={form.status} onChange={set("status")} aria-label="Status" className={field}>
          <option value="">Any status</option>
          {PROCESSING_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select value={form.visibility} onChange={set("visibility")} aria-label="Visibility" className={field}>
          <option value="">Any visibility</option>
          {VISIBILITIES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select value={form.state} onChange={set("state")} aria-label="Moderation state" className={field}>
          <option value="">Not in trash</option>
          <option value="active">Published</option>
          <option value="hidden">Hidden</option>
          <option value="trashed">In trash</option>
          <option value="all">Everything</option>
        </select>
        <div className="flex gap-2">
          <input value={form.minMb} onChange={set("minMb")} inputMode="decimal" placeholder="Min MB" aria-label="Minimum size in MB" className={field} />
          <input value={form.maxMb} onChange={set("maxMb")} inputMode="decimal" placeholder="Max MB" aria-label="Maximum size in MB" className={field} />
        </div>
        <label className="flex items-center gap-2 text-xs text-zinc-400">
          From
          <input type="date" value={form.from} onChange={set("from")} aria-label="Created from" className={field} />
        </label>
        <label className="flex items-center gap-2 text-xs text-zinc-400">
          To
          <input type="date" value={form.to} onChange={set("to")} aria-label="Created to" className={field} />
        </label>
        <select
          value={`${form.sort}:${form.dir}`}
          onChange={(e) => {
            const [sort, dir] = e.target.value.split(":");
            setForm((f) => ({ ...f, sort, dir }));
          }}
          aria-label="Sort"
          className={field}
        >
          <option value="createdAt:desc">Newest first</option>
          <option value="createdAt:asc">Oldest first</option>
          <option value="size:desc">Largest first</option>
          <option value="size:asc">Smallest first</option>
          <option value="name:asc">Name A–Z</option>
        </select>
        <div className="flex gap-2">
          <button type="submit" className={btn.primary}>
            Search
          </button>
          <button
            type="button"
            className={btn.ghost}
            onClick={() => {
              setForm(EMPTY_FILTERS);
              setFilters(EMPTY_FILTERS);
              setPage(0);
            }}
          >
            Clear
          </button>
        </div>
      </form>
      {!data ? (
        <Loading />
      ) : data.items.length === 0 ? (
        <Empty>No files match. {data.totals.files === 0 && can("content:moderate") ? "The index is empty — scan storage to fill it." : ""}</Empty>
      ) : (
        <>
          <p className="mb-2 text-xs text-zinc-500">
            {data.total.toLocaleString()} match{data.total === 1 ? "es" : ""}, {formatBytes(data.matchedBytes)}.
          </p>
          <Panel className="overflow-x-auto p-0">
            <table className="w-full min-w-[860px] text-left text-sm">
              <thead className="border-b border-white/10 text-xs text-zinc-500">
                <tr>
                  <th className="px-3 py-2 font-medium">File</th>
                  <th className="px-3 py-2 font-medium">Owner</th>
                  <th className="px-3 py-2 font-medium">Size</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Visibility</th>
                  <th className="px-3 py-2 font-medium">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {data.items.map((f) => (
                  <tr key={f.id} className="hover:bg-white/[0.03]">
                    <td className="max-w-[320px] px-3 py-2">
                      <Link href={`/admin/content/files/${f.id}`} className="block truncate font-medium text-cyan-200 hover:underline" title={f.key}>
                        {fileLabel(f)}
                      </Link>
                      <span className="flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
                        <TypeLabel t={f.type} />
                        <Related f={f} />
                        <StateBadge s={f.state} />
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <OwnerLink id={f.ownerId} />
                    </td>
                    <td className="px-3 py-2 text-zinc-300">
                      <Bytes n={f.size} />
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge s={f.status} detail={f.statusDetail} />
                    </td>
                    <td className="px-3 py-2">
                      <VisibilityBadge v={f.effectiveVisibility} />
                    </td>
                    <td className="px-3 py-2 text-xs text-zinc-400">{fmtTime(f.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
          {data.total > pageSize && (
            <nav aria-label="Pages" className="mt-3 flex items-center justify-end gap-2 text-sm text-zinc-400">
              <span>
                Page {page + 1} of {pages}
              </span>
              <button type="button" className={btn.ghost} disabled={page <= 0} onClick={() => setPage(page - 1)}>
                Previous
              </button>
              <button type="button" className={btn.ghost} disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>
                Next
              </button>
            </nav>
          )}
        </>
      )}
    </div>
  );
}
