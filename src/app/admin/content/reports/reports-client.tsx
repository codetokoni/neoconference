"use client";

// Content > Reports: the moderation queue. One case per reported replay or
// recording, however many people reported it.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { REPORT_REASONS } from "@/lib/content/model";
import { fmtTime, useAdmin } from "../../AdminApi";
import { Badge, Empty, Loading, Notice, PageHeader, Panel, btn, field } from "../../ui";
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

export default function ReportsClient() {
  const { adminFetch } = useAdmin();
  const [status, setStatus] = useState<"open" | "actioned" | "dismissed" | "all">("open");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [data, setData] = useState<{ items: CaseRow[]; counts: Record<string, number> } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setData(null);
    const r = await adminFetch<{ items: CaseRow[]; counts: Record<string, number> }>(`/api/admin/content/reports?status=${status}&q=${encodeURIComponent(query)}`);
    if (!r.ok) return setErr(r.data.message ?? `HTTP ${r.status}`);
    setData(r.data);
  }, [adminFetch, status, query]);
  useEffect(() => {
    load();
  }, [load]);

  return (
    <div>
      <PageHeader title="Content" sub="Reported replays and recordings. Who reported is never shown to the owner." />
      <ContentTabs />
      {err && <Notice kind="err">{err}</Notice>}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {(["open", "actioned", "dismissed", "all"] as const).map((s) => (
          <button key={s} type="button" onClick={() => setStatus(s)} className={status === s ? btn.primary : btn.ghost}>
            {s[0].toUpperCase() + s.slice(1)} {data && s !== "all" ? `(${data.counts[s] ?? 0})` : ""}
          </button>
        ))}
        <form
          className="ml-auto flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(q.trim());
          }}
        >
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search cases" className={field} />
        </form>
      </div>
      {!data ? (
        <Loading />
      ) : data.items.length === 0 ? (
        <Empty>No {status === "all" ? "" : status} cases.</Empty>
      ) : (
        <Panel className="overflow-x-auto p-0">
          <table className="w-full min-w-[680px] text-left text-sm">
            <thead className="border-b border-white/10 text-xs text-zinc-500">
              <tr>
                <th className="px-3 py-2 font-medium">Reported</th>
                <th className="px-3 py-2 font-medium">Reasons</th>
                <th className="px-3 py-2 font-medium">Reports</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Last activity</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {data.items.map((c) => (
                <tr key={c.id} className="hover:bg-white/[0.03]">
                  <td className="px-3 py-2">
                    <Link href={`/admin/content/reports/${c.id}`} className="font-medium text-cyan-200 hover:underline">
                      {c.label}
                    </Link>
                    <span className="block text-xs text-zinc-500">{c.targetType === "event" ? `Meeting replay · ${c.eventSlug}` : "Recording"}</span>
                  </td>
                  <td className="px-3 py-2 text-xs text-zinc-300">
                    {Object.entries(c.reasons)
                      .sort((a, b) => b[1] - a[1])
                      .map(([r, n]) => `${reasonLabel(r)}${n > 1 ? ` ×${n}` : ""}`)
                      .join(", ")}
                  </td>
                  <td className="px-3 py-2 text-zinc-300">
                    {c.reportCount}
                    {c.newSinceClosed > 0 && <Badge tone="amber">{c.newSinceClosed} new</Badge>}
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={c.status === "open" ? "amber" : c.status === "actioned" ? "green" : "zinc"}>{c.status}</Badge>
                  </td>
                  <td className="px-3 py-2 text-xs text-zinc-400">{fmtTime(c.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
    </div>
  );
}
