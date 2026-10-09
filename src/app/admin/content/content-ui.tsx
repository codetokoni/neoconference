"use client";

// src/app/admin/content/content-ui.tsx — what the Content pages share: the
// section tabs and the small badges a file row is drawn with.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { contentTypeLabel, formatBytes, type ContentType, type FileState, type ProcessingStatus, type Visibility } from "@/lib/content/model";
import { Badge } from "../ui";

const TABS = [
  { href: "/admin/content", label: "Files" },
  { href: "/admin/content/storage", label: "Storage" },
  { href: "/admin/content/problems", label: "Problems" },
  { href: "/admin/content/reports", label: "Reports" },
  { href: "/admin/content/trash", label: "Trash" },
  { href: "/admin/content/limits", label: "Limits" },
];

export function ContentTabs() {
  const path = usePathname() || "";
  const active = (href: string) => (href === "/admin/content" ? path === href || path.startsWith("/admin/content/files") : path === href || path.startsWith(href + "/"));
  return (
    <nav aria-label="Content sections" className="mb-4 flex gap-1 overflow-x-auto border-b border-white/10 pb-px">
      {TABS.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          aria-current={active(t.href) ? "page" : undefined}
          className={[
            "whitespace-nowrap rounded-t-lg px-3 py-2 text-sm",
            active(t.href) ? "border-b-2 border-cyan-400 text-cyan-100" : "text-zinc-400 hover:text-zinc-100",
          ].join(" ")}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

export type FileRow = {
  id: string;
  storage: "r2" | "kv";
  key: string;
  type: ContentType;
  ownerId: string | null;
  eventSlug?: string;
  eventName?: string;
  groupId?: string;
  ticketId?: string;
  recordingKey?: string;
  name?: string;
  size: number;
  contentType: string;
  checksum?: string;
  createdAt: number;
  updatedAt: number;
  status: ProcessingStatus;
  statusAt: number;
  statusDetail?: string;
  visibility: Visibility;
  effectiveVisibility: Visibility;
  state: FileState;
  stateAt?: number;
  stateReason?: string;
  source: string;
  r2SeenAt?: number;
  ignored?: string[];
  startedAt?: number;
  endedAt?: number;
};

export function Bytes({ n }: { n: number }) {
  return <span className="tabular-nums">{formatBytes(n)}</span>;
}

export function TypeLabel({ t }: { t: ContentType }) {
  return <span>{contentTypeLabel(t)}</span>;
}

export function StatusBadge({ s, detail }: { s: ProcessingStatus; detail?: string }) {
  const tone = s === "ready" ? "green" : s === "failed" ? "red" : "amber";
  return (
    <span title={detail}>
      <Badge tone={tone}>{s}</Badge>
    </span>
  );
}

export function VisibilityBadge({ v }: { v: Visibility }) {
  return <Badge tone={v === "public" ? "cyan" : v === "shared" ? "amber" : "zinc"}>{v}</Badge>;
}

export function StateBadge({ s }: { s: FileState }) {
  if (s === "active") return null;
  return <Badge tone={s === "trashed" ? "red" : "amber"}>{s === "hidden" ? "hidden" : "in trash"}</Badge>;
}

export function OwnerLink({ id, label }: { id: string | null; label?: string | null }) {
  if (!id) return <span className="text-amber-300">No owner</span>;
  return (
    <Link href={`/admin/users/${encodeURIComponent(id)}`} className="text-zinc-200 hover:underline">
      {label || id}
    </Link>
  );
}

/** Where a file belongs: its meeting, group or ticket. */
export function Related({ f }: { f: Pick<FileRow, "eventSlug" | "eventName" | "groupId" | "ticketId"> }) {
  if (f.eventSlug)
    return (
      <span className="text-xs text-zinc-400" title={f.eventSlug}>
        Meeting {f.eventName || f.eventSlug}
      </span>
    );
  if (f.groupId)
    return (
      <Link href={`/admin/groups/${encodeURIComponent(f.groupId)}`} className="text-xs text-zinc-400 hover:underline">
        Group {f.groupId}
      </Link>
    );
  if (f.ticketId) return <span className="text-xs text-zinc-400">Ticket {f.ticketId}</span>;
  return null;
}

export function fileLabel(f: Pick<FileRow, "name" | "key">): string {
  return f.name || f.key.split("/").pop() || f.key;
}
