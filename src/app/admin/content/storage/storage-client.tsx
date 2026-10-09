"use client";

// Content > Storage: bytes per type and per account (sortable), each
// account linked to its Users page and to its files, with its plan's
// storage quota where it has one.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { formatBytes, type ContentType } from "@/lib/content/model";
import { fmtNumber, useAdmin } from "../../AdminApi";
import { Badge, Empty, LoadState, PageHeader, Pager, Panel, SortTh, TableWrap, useUrlFilters, type SortDir } from "../../ui";
import { Bytes, ContentTabs, TypeLabel } from "../content-ui";

type Account = {
  ownerId: string | null;
  files: number;
  bytes: number;
  byType: Partial<Record<ContentType, number>>;
  email: string | null;
  name: string | null;
  known: boolean;
  quotaBytes: number | null;
};

type Usage = {
  total: { files: number; bytes: number };
  byType: { type: ContentType; files: number; bytes: number }[];
  accounts: Account[];
  accountCount: number;
  quotas: { enforced: boolean; note: string };
};

const LIMIT = 200;

export default function StorageClient() {
  const { adminFetch } = useAdmin();
  const filters = useUrlFilters({ sort: "bytes", dir: "desc" });
  const sort = filters.value.sort === "files" ? "files" : "bytes";
  const dir: SortDir = filters.value.dir === "asc" ? "asc" : "desc";
  const [data, setData] = useState<Usage | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    const r = await adminFetch<Usage>(`/api/admin/content/usage?sort=${sort}&dir=${dir}&limit=${LIMIT}`);
    setLoading(false);
    if (!r.ok) return setErr(r.data.message ?? `HTTP ${r.status}`);
    setData(r.data);
    setPage(1);
  }, [adminFetch, sort, dir]);
  useEffect(() => {
    load();
  }, [load]);

  const visible = data ? data.accounts.slice((page - 1) * pageSize, page * pageSize) : [];

  return (
    <div>
      <PageHeader
        title="Content"
        sub={data ? `${formatBytes(data.total.bytes)} in ${fmtNumber(data.total.files)} files across ${fmtNumber(data.accountCount)} accounts.` : "Storage use."}
      />
      <ContentTabs />
      <LoadState data={data} error={err} onRetry={load}>
        {(d) => (
          <>
            <Panel className="mb-4">
              <h2 className="mb-2 text-sm font-semibold text-white">By type</h2>
              {d.byType.length === 0 ? (
                <Empty>Nothing indexed yet.</Empty>
              ) : (
                <ul className="space-y-2">
                  {d.byType.map((t) => (
                    <li key={t.type} className="text-sm">
                      <div className="flex flex-wrap justify-between gap-2">
                        <Link href={`/admin/content?type=${t.type}&state=all`} className="text-zinc-200 hover:underline">
                          <TypeLabel t={t.type} />
                        </Link>
                        <span className="text-zinc-400">
                          <Bytes n={t.bytes} /> · {fmtNumber(t.files)} files
                        </span>
                      </div>
                      <div aria-hidden className="mt-1 h-1.5 rounded bg-white/5">
                        <div className="h-1.5 rounded bg-cyan-400/70" style={{ width: `${d.total.bytes ? Math.max(1, (t.bytes / d.total.bytes) * 100) : 0}%` }} />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
            <p className="mb-2 text-xs text-zinc-400">{d.quotas.note}</p>
            {d.accountCount > d.accounts.length && (
              <p className="mb-2 text-xs text-zinc-400">
                Showing the {fmtNumber(d.accounts.length)} accounts with the {dir === "desc" ? "most" : "least"} {sort === "bytes" ? "storage" : "files"}, of {fmtNumber(d.accountCount)}.
              </p>
            )}
            <div aria-busy={loading} className={loading ? "opacity-60 transition-opacity" : "transition-opacity"}>
              <TableWrap minWidth={720}>
                <thead className="border-b border-white/10 text-xs text-zinc-400">
                  <tr>
                    <th className="px-3 py-2 font-medium">Account</th>
                    <SortTh label="Storage" k="bytes" sort={{ key: sort, dir }} onSort={(k, dr) => filters.set({ sort: k, dir: dr })} />
                    <SortTh label="Files" k="files" sort={{ key: sort, dir }} onSort={(k, dr) => filters.set({ sort: k, dir: dr })} />
                    <th className="px-3 py-2 font-medium">Plan quota</th>
                    <th className="px-3 py-2 font-medium">Largest type</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {visible.map((a) => {
                    const top = (Object.entries(a.byType) as [ContentType, number][]).sort((x, y) => y[1] - x[1])[0];
                    const over = a.quotaBytes != null && a.bytes > a.quotaBytes;
                    return (
                      <tr key={a.ownerId ?? "none"} className="hover:bg-white/[0.03]">
                        <td className="px-3 py-2">
                          {a.ownerId ? (
                            <>
                              <Link href={`/admin/users/${encodeURIComponent(a.ownerId)}`} className="font-medium text-cyan-200 hover:underline">
                                {a.name || a.email || a.ownerId}
                              </Link>
                              {!a.known && <Badge tone="red">account gone</Badge>}
                              <span className="block text-xs text-zinc-400">
                                {a.email && a.name ? `${a.email} · ` : ""}
                                <Link href={`/admin/content?owner=${encodeURIComponent(a.ownerId)}&state=all`} className="hover:underline">
                                  files
                                </Link>
                              </span>
                            </>
                          ) : (
                            <span className="text-amber-300">No owner (orphans)</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-zinc-200">
                          <Bytes n={a.bytes} />
                        </td>
                        <td className="px-3 py-2 text-zinc-300">{fmtNumber(a.files)}</td>
                        <td className="px-3 py-2 text-xs">
                          {a.quotaBytes == null ? (
                            <span className="text-zinc-400">unlimited</span>
                          ) : (
                            <span className={over ? "text-red-300" : "text-zinc-300"}>
                              {fmtNumber(Math.round((a.bytes / a.quotaBytes) * 100))}% of {formatBytes(a.quotaBytes)}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-xs text-zinc-400">{top ? <TypeLabel t={top[0]} /> : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </TableWrap>
              <Pager
                page={page}
                pageSize={pageSize}
                total={d.accounts.length}
                onPage={setPage}
                onPageSize={(n) => {
                  setPageSize(n);
                  setPage(1);
                }}
                noun="account"
              />
            </div>
          </>
        )}
      </LoadState>
    </div>
  );
}
