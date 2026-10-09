"use client";

// Content > Reports: the moderation queue. One case per reported replay or
// recording, however many people reported it.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { REPORT_REASONS } from "@/lib/content/model";
import { fmtNumber, fmtTime, useAdmin } from "../../AdminApi";
import { Badge, FilterBar, LoadState, Labeled, PageHeader, Pager, SortTh, TableWrap, btn, field, useClientTable, useUrlFilters } from "../../ui";
import { ContentTabs } from "../content-ui";

export type CaseRow = {
  id: string;
  targetType: "event" | "file" | "share";
  eventSlug?: string;
  fileId?: string;
  label: string;
  ownerId: string | null;
  status: "open" | "actioned" | "dismissed";
  createdAt: number;
  updatedAt: number;
  reportCount: number;
  newSinceClosed: number;
  reasons: Record<string, number>;
};

export const reasonLabel = (id: string) => REPORT_REASONS.find((r) => r.id === id)?.label ?? id;

const STATUSES = ["open", "actioned", "dismissed", "all"] as const;
type Status = (typeof STATUSES)[number];

export default function ReportsClient() {
  const { adminFetch } = useAdmin();
  const filters = useUrlFilters({ status: "open", q: "" });
  const status: Status = (STATUSES as readonly string[]).includes(filters.value.status) ? (filters.value.status as Status) : "open";
  const query = filters.value.q;
  const [q, setQ] = useState(query);
  useEffect(() => setQ(query), [query]);
  const [data, setData] = useState<{ items: CaseRow[]; counts: Record<string, number> } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    const r = await adminFetch<{ items: CaseRow[]; counts: Record<string, number> }>(`/api/admin/content/reports?status=${status}&q=${encodeURIComponent(query)}`);
    setLoading(false);
    if (!r.ok) return setErr(r.data.message ?? `HTTP ${r.status}`);
    setData(r.data);
  }, [adminFetch, status, query]);
  useEffect(() => {
    load();
  }, [load]);

  const t = useClientTable(
    data?.items,
    (c, k) => (k === "label" ? c.label : k === "reports" ? c.reportCount : k === "status" ? c.status : c.updatedAt),
    { key: "updated", dir: "desc" },
  );

  return (
    <div>
      <PageHeader title="Content" sub="Reported replays and recordings. Who reported is never shown to the owner." />
      <ContentTabs />
      <FilterBar active={filters.active} onClear={filters.reset}>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Case status">
          {STATUSES.map((s) => (
            <button key={s} type="button" aria-pressed={status === s} onClick={() => filters.set({ status: s })} className={status === s ? btn.primary : btn.ghost}>
              {s[0].toUpperCase() + s.slice(1)} {data && s !== "all" ? `(${fmtNumber(data.counts[s] ?? 0)})` : ""}
            </button>
          ))}
        </div>
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            filters.set({ q: q.trim() });
          }}
        >
          <Labeled label="Search cases" className="w-full sm:w-64">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Label, meeting, owner" className={field} />
          </Labeled>
          <button type="submit" className={btn.ghost}>
            Search
          </button>
        </form>
      </FilterBar>
      <LoadState data={data} error={err} onRetry={load} isEmpty={(d) => d.items.length === 0} empty={`No ${status === "all" ? "" : `${status} `}cases${query ? ` match “${query}”` : ""}.`}>
        {() => (
          <div aria-busy={loading} className={loading ? "opacity-60 transition-opacity" : "transition-opacity"}>
            <TableWrap minWidth={680}>
              <thead className="border-b border-white/10 text-xs text-zinc-400">
                <tr>
                  <SortTh label="Reported" k="label" sort={t.sort} onSort={t.onSort} />
                  <th className="px-3 py-2 font-medium">Reasons</th>
                  <SortTh label="Reports" k="reports" sort={t.sort} onSort={t.onSort} />
                  <SortTh label="Status" k="status" sort={t.sort} onSort={t.onSort} />
                  <SortTh label="Last activity" k="updated" sort={t.sort} onSort={t.onSort} />
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {t.visible.map((c) => (
                  <tr key={c.id} className="hover:bg-white/[0.03]">
                    <td className="px-3 py-2">
                      <Link href={`/admin/content/reports/${c.id}`} className="font-medium text-cyan-200 hover:underline">
                        {c.label}
                      </Link>
                      <span className="block text-xs text-zinc-400">{c.targetType === "event" ? `Meeting replay · ${c.eventSlug}` : "Recording"}</span>
                    </td>
                    <td className="px-3 py-2 text-xs text-zinc-300">
                      {Object.entries(c.reasons)
                        .sort((a, b) => b[1] - a[1])
                        .map(([r, n]) => `${reasonLabel(r)}${n > 1 ? ` ×${n}` : ""}`)
                        .join(", ")}
                    </td>
                    <td className="px-3 py-2 text-zinc-300">
                      {fmtNumber(c.reportCount)} {c.newSinceClosed > 0 && <Badge tone="amber">{fmtNumber(c.newSinceClosed)} new</Badge>}
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={c.status === "open" ? "amber" : c.status === "actioned" ? "green" : "zinc"}>{c.status}</Badge>
                    </td>
                    <td className="px-3 py-2 text-xs text-zinc-400">{fmtTime(c.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
            <Pager page={t.page} pageSize={t.pageSize} total={t.total} onPage={t.setPage} onPageSize={t.setPageSize} noun="case" />
          </div>
        )}
      </LoadState>
    </div>
  );
}
