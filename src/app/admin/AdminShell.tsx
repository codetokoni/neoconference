"use client";

// src/app/admin/AdminShell.tsx
//
// The admin area's frame: section navigation (only the sections the
// administrator's role can open), who is signed in with which role, and a
// Lock button that ends the admin session without signing out of the app.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { AdminPermission } from "@/lib/admin/catalog";
import type { PublicAdminContext } from "@/lib/admin/context";
import { AdminProvider } from "./AdminApi";

type Section = { label: string; href: string; permission: AdminPermission | null; group: string };

export const SECTIONS: Section[] = [
  { label: "Users", href: "/admin", permission: "users:read", group: "Platform" },
  { label: "Groups", href: "/admin/groups", permission: "users:read", group: "Platform" },
  { label: "Meetings", href: "/admin/events", permission: "events:read", group: "Platform" },
  { label: "Metrics", href: "/admin/metrics", permission: "analytics:read", group: "Platform" },
  { label: "Plans & pricing", href: "/admin/plans", permission: "plans:read", group: "Billing" },
  { label: "Subscriptions", href: "/admin/subscriptions", permission: "plans:read", group: "Billing" },
  { label: "Communication", href: "/admin/communication", permission: "notifications:send", group: "Communication" },
  { label: "Email templates", href: "/admin/email-templates", permission: "notifications:send", group: "Communication" },
  { label: "Tickets", href: "/admin/support", permission: "support:read", group: "Support" },
  { label: "Help centre", href: "/admin/help", permission: "support:read", group: "Support" },
  { label: "Administrators", href: "/admin/team", permission: "admins:read", group: "Access" },
  { label: "Roles", href: "/admin/roles", permission: "admins:read", group: "Access" },
  { label: "Audit log", href: "/admin/audit-log", permission: "audit:read", group: "Access" },
  { label: "Security", href: "/admin/security", permission: null, group: "Access" },
];

export default function AdminShell({ me, children }: { me: PublicAdminContext; children: ReactNode }) {
  const pathname = usePathname() || "";
  const visible = SECTIONS.filter((s) => !s.permission || me.permissions.includes(s.permission));
  const groups = [...new Set(visible.map((s) => s.group))];
  const isActive = (href: string) =>
    href === "/admin" ? pathname === "/admin" || pathname.startsWith("/admin/users/") : pathname === href || pathname.startsWith(href + "/");

  const lock = async () => {
    await fetch("/api/admin/mfa/lock", { method: "POST" }).catch(() => undefined);
    window.location.href = "/admin";
  };

  return (
    <AdminProvider me={me}>
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-4 sm:px-6 lg:flex-row lg:gap-6">
        <aside className="lg:w-56 lg:shrink-0">
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
            <div className="flex items-center justify-between gap-2 lg:block">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-white" title={me.email}>
                  {me.name}
                </p>
                <p className="mt-0.5 inline-flex items-center gap-1.5 text-xs">
                  <span className={me.isOwner ? "rounded bg-amber-400/15 px-1.5 py-0.5 font-semibold text-amber-300" : "rounded bg-cyan-400/10 px-1.5 py-0.5 text-cyan-300"}>
                    {me.roleName}
                  </span>
                </p>
              </div>
              <button type="button" onClick={lock} title="End the admin session now. You stay signed in to NeoConference." className="rounded-lg border border-white/10 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-white/5 lg:mt-3 lg:w-full">
                Lock admin
              </button>
            </div>
          </div>
          <nav aria-label="Admin sections" className="mt-3 flex gap-1 overflow-x-auto pb-1 lg:block lg:overflow-visible">
            {groups.map((g) => (
              <div key={g} className="flex gap-1 lg:mb-3 lg:block">
                <p className="hidden px-3 pb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-500 lg:block">{g}</p>
                {visible
                  .filter((s) => s.group === g)
                  .map((s) => (
                    <Link
                      key={s.href}
                      href={s.href}
                      aria-current={isActive(s.href) ? "page" : undefined}
                      className={[
                        "block whitespace-nowrap rounded-lg px-3 py-2 text-sm transition-colors",
                        isActive(s.href) ? "bg-cyan-400/10 text-cyan-200" : "text-zinc-400 hover:bg-white/5 hover:text-zinc-100",
                      ].join(" ")}
                    >
                      {s.label}
                    </Link>
                  ))}
              </div>
            ))}
          </nav>
        </aside>
        <div className="min-w-0 flex-1">
          <SupportBanner pathname={pathname} />
          {children}
        </div>
      </div>
    </AdminProvider>
  );
}

type OpenSupport = { userId: string; userEmail: string; userName: string; reason: string; expiresAt: number };

/** Fired on window by a page that may have opened or ended a support session. */
export const SUPPORT_CHANGED = "neo-admin-support-changed";

/**
 * While the administrator has a support session open on someone's account,
 * every admin page says so, with a way back to that account and a way to
 * end it. Checked on each page change and every minute.
 */
function SupportBanner({ pathname }: { pathname: string }) {
  const [s, setS] = useState<OpenSupport | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const check = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/support", { cache: "no-store" });
      const j = (await r.json().catch(() => ({}))) as { session?: OpenSupport | null };
      setS(r.ok ? (j.session ?? null) : null);
    } catch {
      // Leave the banner as it was; the next check corrects it.
    }
  }, []);
  useEffect(() => {
    check();
  }, [check, pathname]);
  useEffect(() => {
    window.addEventListener(SUPPORT_CHANGED, check);
    return () => window.removeEventListener(SUPPORT_CHANGED, check);
  }, [check]);
  useEffect(() => {
    const t = setInterval(() => {
      setNow(Date.now());
      check();
    }, 60_000);
    return () => clearInterval(t);
  }, [check]);
  if (!s || s.expiresAt <= now) return null;
  const end = async () => {
    await fetch(`/api/admin/users/${encodeURIComponent(s.userId)}/support`, { method: "DELETE" }).catch(() => undefined);
    setS(null);
    if (pathname.startsWith(`/admin/users/${s.userId}`)) window.location.reload();
  };
  const mins = Math.max(1, Math.round((s.expiresAt - now) / 60_000));
  return (
    <div role="status" className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-400/50 bg-amber-400/15 px-3 py-2 text-sm text-amber-100">
      <span>
        <b className="font-semibold">Support session open</b> on{" "}
        <Link href={`/admin/users/${encodeURIComponent(s.userId)}`} className="underline">
          {s.userName || s.userEmail}
        </Link>{" "}
        — {mins} min left. Everything you open on that account is recorded.
      </span>
      <button type="button" onClick={end} className="rounded-lg border border-amber-300/40 px-2.5 py-1 text-xs hover:bg-amber-300/10">
        End session
      </button>
    </div>
  );
}

/** Shown by a page whose permission the role lacks (the API refuses too). */
export function NoAccess({ permission }: { permission: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-6">
      <h1 className="text-lg font-semibold text-white">Not part of your role</h1>
      <p className="mt-1 text-sm text-zinc-400">
        This section needs the <code className="rounded bg-black/40 px-1">{permission}</code> permission. Ask the platform owner to change your role.
      </p>
    </div>
  );
}
