"use client";

// Content > Storage: bytes per type and per account (sortable), each
// account linked to its Users page and to its files, with its plan's
// storage quota where it has one.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { formatBytes, type ContentType } from "@/lib/content/model";
import { useAdmin } from "../../AdminApi";
import { Badge, Empty, Loading, Notice, PageHeader, Panel } from "../../ui";
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

export default function StorageClient() {
  const { adminFetch } = useAdmin();
  const [sort, setSort] = useState<"bytes" | "files">("bytes");
  const [dir, setDir] = useState<"desc" | "asc">("desc");
  const [data, setData] = useState<Usage | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setData(null);
    const r = await adminFetch<Usage>(`/api/admin/content/usage?sort=${sort}&dir=${dir}&limit=200`);
    if (!r.ok) return setErr(r.data.message ?? `HTTP ${r.status}`);
    setData(r.data);
  }, [adminFetch, sort, dir]);
  useEffect(() => {
    load();
  }, [load]);

  const header = (k: "bytes" | "files", label: string) => (
    <th className="px-3 py-2 font-medium">
      <button
        type="button"
        onClick={() => {
          if (sort === k) setDir(dir === "desc" ? "asc" : "desc");
          else {
            setSort(k);
            setDir("desc");
          }
        }}
        className="inline-flex items-center gap-1 hover:text-zinc-200"
        aria-label={`Sort by ${label}`}
      >
        {label} {sort === k ? (dir === "desc" ? "↓" : "↑") : ""}
      </button>
    </th>
  );

  return (
    <div>
      <PageHeader title="Content" sub={data ? `${formatBytes(data.total.bytes)} in ${data.total.files.toLocaleString()} files across ${data.accountCount.toLocaleString()} accounts.` : "Storage use."} />
      <ContentTabs />
      {err && <Notice kind="err">{err}</Notice>}
      {!data ? (
        <Loading />
      ) : (
        <>
          <Panel className="mb-4">
            <h2 className="mb-2 text-sm font-semibold text-white">By type</h2>
            {data.byType.length === 0 ? (
              <Empty>Nothing indexed yet.</Empty>
            ) : (
              <ul className="space-y-2">
                {data.byType.map((t) => (
                  <li key={t.type} className="text-sm">
                    <div className="flex justify-between gap-2">
                      <Link href={`/admin/content?type=${t.type}`} className="text-zinc-200 hover:underline">
                        <TypeLabel t={t.type} />
                      </Link>
                      <span className="text-zinc-400">
                        <Bytes n={t.bytes} /> · {t.files.toLocaleString()} files
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 rounded bg-white/5">
                      <div className="h-1.5 rounded bg-cyan-400/70" style={{ width: `${data.total.bytes ? Math.max(1, (t.bytes / data.total.bytes) * 100) : 0}%` }} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <p className="mb-2 text-xs text-zinc-500">{data.quotas.note}</p>
          <Panel className="overflow-x-auto p-0">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="border-b border-white/10 text-xs text-zinc-500">
                <tr>
                  <th className="px-3 py-2 font-medium">Account</th>
                  {header("bytes", "Storage")}
                  {header("files", "Files")}
                  <th className="px-3 py-2 font-medium">Plan quota</th>
                  <th className="px-3 py-2 font-medium">Largest type</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {data.accounts.map((a) => {
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
                            <span className="block text-xs text-zinc-500">
                              {a.email && a.name ? `${a.email} · ` : ""}
                              <Link href={`/admin/content?owner=${encodeURIComponent(a.ownerId)}`} className="hover:underline">
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
                      <td className="px-3 py-2 text-zinc-300">{a.files.toLocaleString()}</td>
                      <td className="px-3 py-2 text-xs">
                        {a.quotaBytes == null ? (
                          <span className="text-zinc-500">unlimited</span>
                        ) : (
                          <span className={over ? "text-red-300" : "text-zinc-300"}>
                            {Math.round((a.bytes / a.quotaBytes) * 100)}% of {formatBytes(a.quotaBytes)}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs text-zinc-400">{top ? <TypeLabel t={top[0]} /> : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Panel>
        </>
      )}
    </div>
  );
}
