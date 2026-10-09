// src/lib/admin/search.ts
//
// The admin top bar's search: one query across users, groups, meetings,
// payments, tickets, files and the admin audit, each read from the store
// that keeps it. A category is searched only for an administrator whose role
// can open its list; the rest are not searched at all. Each category answers
// on its own — one that fails or is slow is an error in its own section.

import { clerkClient } from "@clerk/nextjs/server";
import type { AdminPermission } from "@/lib/admin/catalog";
import { listAllGroups } from "@/lib/admin/groups";
import { listAdminAudit } from "@/lib/admin/audit";
import { eventStore } from "@/lib/eventStore";
import { queryLedger } from "@/lib/finance/ledger";
import { fmtMoney } from "@/lib/finance/money";
import { getSla, listTickets, queryTickets } from "@/lib/support/tickets";
import { allFiles } from "@/lib/content/files";
import { contentTypeLabel, formatBytes } from "@/lib/content/model";

export const MIN_QUERY = 2;
export const PER_CATEGORY = 5;
export const CATEGORY_TIMEOUT_MS = 8_000;

export interface SearchItem {
  id: string;
  title: string;
  sub: string;
  href: string;
}

export type CategoryResult =
  | { id: CategoryId; label: string; status: "ok"; items: SearchItem[]; more: string | null }
  | { id: CategoryId; label: string; status: "error"; message: string };

interface Category {
  id: string;
  label: string;
  permission: AdminPermission;
  /** Up to `limit` matches, and a link to the full filtered list when there may be more. */
  run: (q: string, limit: number) => Promise<{ items: SearchItem[]; more: string | null }>;
}

const enc = encodeURIComponent;
const has = (q: string, ...fields: Array<string | null | undefined>) => fields.some((f) => (f ?? "").toLowerCase().includes(q));

const CATEGORIES = [
  {
    id: "users",
    label: "Users",
    permission: "users:read",
    async run(q, limit) {
      const client = await clerkClient();
      const found = new Map<string, SearchItem>();
      const add = (u: { id: string; firstName?: string | null; lastName?: string | null; username?: string | null; emailAddresses?: { emailAddress: string }[] }) => {
        const email = u.emailAddresses?.[0]?.emailAddress ?? "";
        const name = [u.firstName, u.lastName].filter(Boolean).join(" ") || u.username || "";
        found.set(u.id, { id: u.id, title: name || email || u.id, sub: [email, u.id].filter(Boolean).join(" · "), href: `/admin/users/${enc(u.id)}` });
      };
      // A pasted user id is looked up directly: Clerk's query does not match ids.
      if (/^user_[A-Za-z0-9]+$/.test(q)) {
        try {
          add(await client.users.getUser(q));
        } catch {
          // No such account: fall through to the text search.
        }
      }
      const res = await client.users.getUserList({ query: q, limit: limit + 1, orderBy: "-created_at" });
      for (const u of res.data) add(u);
      const items = [...found.values()];
      return { items: items.slice(0, limit), more: items.length > limit ? `/admin/users?q=${enc(q)}` : null };
    },
  },
  {
    id: "groups",
    label: "Groups",
    permission: "users:read",
    async run(q, limit) {
      const s = q.toLowerCase();
      const { groups } = await listAllGroups();
      const hits = groups.filter((g) => g.id.toLowerCase() === s || has(s, g.name, g.ownerEmail, g.ownerName));
      return {
        items: hits.slice(0, limit).map((g) => ({
          id: g.id,
          title: g.name || g.id,
          sub: [`${g.memberCount} member${g.memberCount === 1 ? "" : "s"}`, g.ownerEmail].filter(Boolean).join(" · "),
          href: `/admin/groups/${enc(g.id)}`,
        })),
        more: hits.length > limit ? `/admin/groups?q=${enc(q)}` : null,
      };
    },
  },
  {
    id: "meetings",
    label: "Meetings",
    permission: "events:read",
    async run(q, limit) {
      const s = q.toLowerCase();
      const events = await eventStore.listAll();
      const hits = events
        .filter((e) => e.id.toLowerCase() === s || has(s, e.name, e.slug, e.ownerEmail, e.ownerName))
        .sort((a, b) => String(b.updatedAt ?? b.createdAt).localeCompare(String(a.updatedAt ?? a.createdAt)));
      return {
        items: hits.slice(0, limit).map((e) => ({
          id: e.id,
          title: e.name || e.slug,
          sub: [`/${e.slug}`, e.state, e.ownerEmail].filter(Boolean).join(" · "),
          href: `/admin/events?q=${enc(e.slug)}`,
        })),
        more: hits.length > limit ? `/admin/events?q=${enc(q)}` : null,
      };
    },
  },
  {
    id: "payments",
    label: "Payments",
    permission: "billing:read",
    async run(q, limit) {
      const page = await queryLedger({ q, limit });
      return {
        items: page.items.map((e) => ({
          id: e.id,
          title: e.invoiceNumber ? `${e.invoiceNumber} · ${e.ref}` : e.ref,
          sub: [fmtMoney(e.amount, e.currency), e.status.replace("_", " "), e.email ?? e.userId, new Date(e.at).toISOString().slice(0, 10)].filter(Boolean).join(" · "),
          href: `/admin/billing/payments?open=${enc(e.id)}`,
        })),
        more: page.total > limit ? `/admin/billing/payments?q=${enc(q)}` : null,
      };
    },
  },
  {
    id: "tickets",
    label: "Tickets",
    permission: "support:read",
    async run(q, limit) {
      const [all, sla] = await Promise.all([listTickets(), getSla()]);
      const r = queryTickets(all, { q, limit, sort: "updated" }, sla, Date.now());
      return {
        items: r.items.map((t) => ({
          id: t.id,
          title: `#${t.number} ${t.subject}`,
          sub: [t.status.replace("_", " "), t.email].filter(Boolean).join(" · "),
          href: `/admin/support/${enc(t.id)}`,
        })),
        more: r.total > limit ? `/admin/support?q=${enc(q)}` : null,
      };
    },
  },
  {
    id: "files",
    label: "Files",
    permission: "content:read",
    async run(q, limit) {
      const s = q.toLowerCase();
      const files = await allFiles();
      const hits = files
        .filter((f) => f.id.toLowerCase() === s || f.ownerId === q || has(s, f.name, f.key, f.eventSlug))
        .sort((a, b) => b.createdAt - a.createdAt);
      return {
        items: hits.slice(0, limit).map((f) => ({
          id: f.id,
          title: f.name || f.key.split("/").pop() || f.key,
          sub: [contentTypeLabel(f.type), formatBytes(f.size), f.state !== "active" ? f.state : "", f.ownerId].filter(Boolean).join(" · "),
          href: `/admin/content?file=${enc(f.id)}`,
        })),
        more: hits.length > limit ? `/admin/content?q=${enc(q)}` : null,
      };
    },
  },
  {
    id: "audit",
    label: "Audit log",
    permission: "audit:read",
    async run(q, limit) {
      const r = await listAdminAudit({ q, limit });
      return {
        items: r.items.map((e) => ({
          id: String(e.seq),
          title: `${e.action}${e.targetLabel || e.targetId ? ` · ${e.targetLabel || e.targetId}` : ""}`,
          sub: [`#${e.seq}`, e.actorEmail || e.actorId, new Date(e.ts).toISOString().slice(0, 16).replace("T", " ") + " UTC", e.outcome !== "ok" ? e.outcome : ""]
            .filter(Boolean)
            .join(" · "),
          href: `/admin/audit-log?q=${enc(q)}&open=${e.seq}`,
        })),
        more: r.total > limit ? `/admin/audit-log?q=${enc(q)}` : null,
      };
    },
  },
] as const satisfies readonly Category[];

export type CategoryId = (typeof CATEGORIES)[number]["id"];

export function searchableCategories(permissions: readonly AdminPermission[]) {
  return CATEGORIES.filter((c) => permissions.includes(c.permission)).map((c) => ({ id: c.id, label: c.label }));
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Took too long to answer.")), ms);
  });
  return Promise.race([work, late]).finally(() => timer && clearTimeout(timer));
}

export async function adminSearch(
  permissions: readonly AdminPermission[],
  rawQ: string,
  opts: { limit?: number; only?: string[] } = {},
): Promise<CategoryResult[]> {
  const q = rawQ.trim().slice(0, 120);
  if (q.length < MIN_QUERY) return [];
  const limit = Math.max(1, Math.min(opts.limit ?? PER_CATEGORY, 20));
  const cats = CATEGORIES.filter((c) => permissions.includes(c.permission) && (!opts.only?.length || opts.only.includes(c.id)));
  return Promise.all(
    cats.map(async (c): Promise<CategoryResult> => {
      try {
        const r = await withTimeout((c as Category).run(q, limit), CATEGORY_TIMEOUT_MS);
        return { id: c.id, label: c.label, status: "ok", items: r.items, more: r.more };
      } catch (err) {
        console.error("[admin-search] category failed", c.id, err);
        return { id: c.id, label: c.label, status: "error", message: (err instanceof Error ? err.message : String(err)).slice(0, 200) };
      }
    }),
  );
}
