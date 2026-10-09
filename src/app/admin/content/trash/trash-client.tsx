"use client";

// Content > Trash: recordings and uploaded files in the trash — deleted by
// their owners, or moved there by an administrator — restorable until the
// trash window closes (the data-governance "Trash" retention; 30 days until
// it is set). After that the retention purge removes them.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { formatBytes } from "@/lib/content/model";
import { fmtTime, useAdmin } from "../../AdminApi";
import { Badge, Empty, Loading, Notice, PageHeader, Panel, btn } from "../../ui";
import { Bytes, ContentTabs, OwnerLink } from "../content-ui";

type Item = {
  trashId: string;
  kind: "recording" | "upload";
  label: string;
  key: string;
  ownerId: string | null;
  deletedAt: number;
  deletedBy: string;
  byOwner: boolean;
  size: number | null;
  fileId: string | null;
  reason: string | null;
  restoreUntil: number;
  expired: boolean;
};

export default function TrashClient() {
  const { can, adminFetch } = useAdmin();
  const [data, setData] = useState<{ days: number; items: Item[]; bytes: number } | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await adminFetch<{ days: number; items: Item[]; bytes: number }>("/api/admin/content/trash");
    if (!r.ok) return setMsg({ kind: "err", text: r.data.message ?? `HTTP ${r.status}` });
    setData(r.data);
  }, [adminFetch]);
  useEffect(() => {
    load();
  }, [load]);

  const restore = async (it: Item) => {
    setMsg(null);
    setBusy(it.trashId);
    const r = await adminFetch("/api/admin/content/trash", { method: "POST", json: { id: it.trashId } });
    setBusy(null);
    if (!r.ok) return setMsg({ kind: "err", text: r.data.message ?? `HTTP ${r.status}` });
    setMsg({ kind: "ok", text: `Restored ${it.label}. It is back where it was.` });
    load();
  };

  return (
    <div>
      <PageHeader
        title="Content"
        sub={
          data
            ? `${data.items.length} file${data.items.length === 1 ? "" : "s"} in the trash (${formatBytes(data.bytes)}). Each can be restored for ${data.days} days after it was deleted.`
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
        How long the trash keeps files is the &quot;Trash&quot; retention under <Link href="/admin/data" className="underline">Data</Link>, not set here. Meetings and groups in
        the trash are restored from there.
      </p>
      {!data ? (
        <Loading />
      ) : data.items.length === 0 ? (
        <Empty>The trash has no recordings or files.</Empty>
      ) : (
        <Panel className="overflow-x-auto p-0">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="border-b border-white/10 text-xs text-zinc-500">
              <tr>
                <th className="px-3 py-2 font-medium">File</th>
                <th className="px-3 py-2 font-medium">Owner</th>
                <th className="px-3 py-2 font-medium">Size</th>
                <th className="px-3 py-2 font-medium">Deleted</th>
                <th className="px-3 py-2 font-medium">Restorable until</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {data.items.map((it) => (
                <tr key={it.trashId} className="hover:bg-white/[0.03]">
                  <td className="max-w-[280px] px-3 py-2">
                    {it.fileId ? (
                      <Link href={`/admin/content/files/${it.fileId}`} className="block truncate text-cyan-200 hover:underline" title={it.key}>
                        {it.label}
                      </Link>
                    ) : (
                      <span className="block truncate text-zinc-200" title={it.key}>
                        {it.label}
                      </span>
                    )}
                    <span className="text-xs text-zinc-500">
                      {it.kind === "recording" ? "Recording" : "Uploaded file"}
                      {it.reason ? ` · ${it.reason}` : ""}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <OwnerLink id={it.ownerId} />
                  </td>
                  <td className="px-3 py-2 text-zinc-300">{it.size != null ? <Bytes n={it.size} /> : "—"}</td>
                  <td className="px-3 py-2 text-xs text-zinc-400">
                    {fmtTime(it.deletedAt)}
                    <span className="block text-zinc-500">{it.byOwner ? "by its owner" : "by an administrator"}</span>
                  </td>
                  <td className="px-3 py-2 text-xs">{it.expired ? <Badge tone="red">window closed</Badge> : <span className="text-zinc-300">{fmtTime(it.restoreUntil)}</span>}</td>
                  <td className="px-3 py-2 text-right">
                    {can("content:moderate") && !it.expired && (
                      <button type="button" className={btn.ghost} disabled={busy === it.trashId} onClick={() => restore(it)}>
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
