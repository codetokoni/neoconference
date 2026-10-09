"use client";

// Content > Trash: recordings and uploaded files in the trash — deleted by
// their owners, or moved there by an administrator — restorable until the
// trash window closes (the data-governance "Trash" retention; 30 days until
// it is set). After that the retention purge removes them.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { formatBytes } from "@/lib/content/model";
import { fmtNumber, fmtTime, useAdmin } from "../../AdminApi";
import { Badge, Confirm, LoadState, Notice, PageHeader, Pager, SortTh, TableWrap, btn, useClientTable } from "../../ui";
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
type Resp = { days: number; items: Item[]; bytes: number };

export default function TrashClient() {
  const { can, adminFetch } = useAdmin();
  const [data, setData] = useState<Resp | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [ask, setAsk] = useState<Item | null>(null);

  const load = useCallback(async () => {
    setLoadErr(null);
    const r = await adminFetch<Resp>("/api/admin/content/trash");
    if (!r.ok) return setLoadErr(r.data.message ?? `HTTP ${r.status}`);
    setData(r.data);
  }, [adminFetch]);
  useEffect(() => {
    load();
  }, [load]);

  const t = useClientTable(
    data?.items,
    (it, k) => (k === "file" ? it.label : k === "size" ? it.size : k === "deleted" ? it.deletedAt : it.restoreUntil),
    { key: "deleted", dir: "desc" },
  );

  const restore = async (it: Item) => {
    setMsg(null);
    const r = await adminFetch("/api/admin/content/trash", { method: "POST", json: { id: it.trashId } });
    if (!r.ok) {
      if (r.data.error !== "cancelled") setMsg({ kind: "err", text: r.data.message ?? `HTTP ${r.status}` });
      return;
    }
    setMsg({ kind: "ok", text: `Restored ${it.label}. It is back where it was.` });
    load();
  };

  return (
    <div>
      <PageHeader
        title="Content"
        sub={
          data
            ? `${fmtNumber(data.items.length)} file${data.items.length === 1 ? "" : "s"} in the trash (${formatBytes(data.bytes)}). Each can be restored for ${fmtNumber(data.days)} days after it was deleted.`
            : "The trash."
        }
      />
      <ContentTabs />
      {msg && (
        <Notice kind={msg.kind} onClose={() => setMsg(null)}>
          {msg.text}
        </Notice>
      )}
      <p className="mb-3 text-xs text-zinc-400">
        How long the trash keeps files is the &quot;Trash&quot; retention under{" "}
        <Link href="/admin/data?tab=retention" className="underline">
          Data
        </Link>
        , not set here. Meetings and groups in the trash are restored from there.
      </p>
      <LoadState data={data} error={loadErr} onRetry={load} isEmpty={(d) => d.items.length === 0} empty="The trash has no recordings or files.">
        {() => (
          <>
            <TableWrap minWidth={760}>
              <thead className="border-b border-white/10 text-xs text-zinc-400">
                <tr>
                  <SortTh label="File" k="file" sort={t.sort} onSort={t.onSort} />
                  <th className="px-3 py-2 font-medium">Owner</th>
                  <SortTh label="Size" k="size" sort={t.sort} onSort={t.onSort} />
                  <SortTh label="Deleted" k="deleted" sort={t.sort} onSort={t.onSort} />
                  <SortTh label="Restorable until" k="until" sort={t.sort} onSort={t.onSort} />
                  <th className="px-3 py-2">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {t.visible.map((it) => (
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
                      <span className="text-xs text-zinc-400">
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
                      <span className="block text-zinc-400">{it.byOwner ? "by its owner" : "by an administrator"}</span>
                    </td>
                    <td className="px-3 py-2 text-xs">{it.expired ? <Badge tone="red">window closed</Badge> : <span className="text-zinc-300">{fmtTime(it.restoreUntil)}</span>}</td>
                    <td className="px-3 py-2 text-right">
                      {can("content:moderate") && !it.expired && (
                        <button type="button" className={btn.ghost} onClick={() => setAsk(it)} aria-label={`Restore ${it.label}`}>
                          Restore
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
            <Pager page={t.page} pageSize={t.pageSize} total={t.total} onPage={t.setPage} onPageSize={t.setPageSize} noun="file" />
          </>
        )}
      </LoadState>
      {ask && (
        <Confirm
          title="Restore from the trash?"
          body={`${ask.label} goes back where it was, in the state it had before it was deleted. Refused if something has taken its place.`}
          confirmLabel="Restore"
          onConfirm={async () => {
            await restore(ask);
            setAsk(null);
          }}
          onCancel={() => setAsk(null)}
        />
      )}
    </div>
  );
}
