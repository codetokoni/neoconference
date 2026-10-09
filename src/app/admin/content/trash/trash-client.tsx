"use client";

// Content > Trash: files moved to the trash, restorable until the trash
// window closes (the "Trash" retention setting under data governance;
// 30 days until it is set). After that the retention purge removes them.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { formatBytes } from "@/lib/content/model";
import { fmtTime, useAdmin } from "../../AdminApi";
import { Badge, Empty, Loading, Notice, PageHeader, Panel, btn } from "../../ui";
import { Bytes, ContentTabs, OwnerLink, TypeLabel, fileLabel, type FileRow } from "../content-ui";

type Item = FileRow & { restoreUntil: number; expired: boolean };

export default function TrashClient() {
  const { can, adminFetch } = useAdmin();
  const [data, setData] = useState<{ days: number; items: Item[]; bytes: number } | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const load = useCallback(async () => {
    const r = await adminFetch<{ days: number; items: Item[]; bytes: number }>("/api/admin/content/trash");
    if (!r.ok) return setMsg({ kind: "err", text: r.data.message ?? `HTTP ${r.status}` });
    setData(r.data);
  }, [adminFetch]);
  useEffect(() => {
    load();
  }, [load]);

  const restore = async (f: Item) => {
    setMsg(null);
    const r = await adminFetch(`/api/admin/content/files/${f.id}/action`, { method: "POST", json: { action: "restore" } });
    if (!r.ok) return setMsg({ kind: "err", text: r.data.message ?? `HTTP ${r.status}` });
    setMsg({ kind: "ok", text: `Restored ${fileLabel(f)}.` });
    load();
  };

  return (
    <div>
      <PageHeader
        title="Content"
        sub={
          data
            ? `${data.items.length} file${data.items.length === 1 ? "" : "s"} in the trash (${formatBytes(data.bytes)}). Each can be restored for ${data.days} days after it was trashed.`
            : "The trash."
        }
      />
      <ContentTabs />
      {msg && (
        <Notice kind={msg.kind} onClose={() => setMsg(null)}>
          {msg.text}
        </Notice>
      )}
      <p className="mb-3 text-xs text-zinc-500">
        How long the trash keeps files is the data-governance retention setting &quot;Trash&quot;, not set here. Files and recordings are kept until their owner
        deletes them unless the &quot;Files and recordings&quot; retention says otherwise.
      </p>
      {!data ? (
        <Loading />
      ) : data.items.length === 0 ? (
        <Empty>The trash is empty.</Empty>
      ) : (
        <Panel className="overflow-x-auto p-0">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="border-b border-white/10 text-xs text-zinc-500">
              <tr>
                <th className="px-3 py-2 font-medium">File</th>
                <th className="px-3 py-2 font-medium">Owner</th>
                <th className="px-3 py-2 font-medium">Size</th>
                <th className="px-3 py-2 font-medium">Trashed</th>
                <th className="px-3 py-2 font-medium">Restorable until</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {data.items.map((f) => (
                <tr key={f.id} className="hover:bg-white/[0.03]">
                  <td className="max-w-[280px] px-3 py-2">
                    <Link href={`/admin/content/files/${f.id}`} className="block truncate text-cyan-200 hover:underline" title={f.key}>
                      {fileLabel(f)}
                    </Link>
                    <span className="text-xs text-zinc-500">
                      <TypeLabel t={f.type} />
                      {f.stateReason ? ` · ${f.stateReason}` : ""}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <OwnerLink id={f.ownerId} />
                  </td>
                  <td className="px-3 py-2 text-zinc-300">
                    <Bytes n={f.size} />
                  </td>
                  <td className="px-3 py-2 text-xs text-zinc-400">{fmtTime(f.stateAt)}</td>
                  <td className="px-3 py-2 text-xs">{f.expired ? <Badge tone="red">window closed</Badge> : <span className="text-zinc-300">{fmtTime(f.restoreUntil)}</span>}</td>
                  <td className="px-3 py-2 text-right">
                    {can("content:moderate") && !f.expired && (
                      <button type="button" className={btn.ghost} onClick={() => restore(f)}>
                        Restore
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
    </div>
  );
}
