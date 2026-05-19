"use client";

// src/app/admin/AdminTabs.tsx
// Dark-glass tab strip shown at the top of every admin section page.
// Active tab gets a cyan underline + brighter text. Inactive tabs are
// muted and brighten on hover.

import Link from "next/link";
import { usePathname } from "next/navigation";

type Tab = { label: string; href: string };

const TABS: Tab[] = [
  { label: "Users", href: "/admin" },
  { label: "Events", href: "/admin/events" },
];

export default function AdminTabs() {
  const pathname = usePathname() || "";
  return (
    <div
      className="border-b backdrop-blur-xl"
      style={{
        background: "rgba(0,0,0,0.4)",
        borderBottomColor: "rgba(255,255,255,0.08)",
        borderBottomWidth: "0.5px",
      }}
    >
      <nav
        className="mx-auto flex max-w-7xl items-center gap-1 px-4 sm:px-6"
        aria-label="Admin sections"
      >
        {TABS.map((t) => {
          const active =
            t.href === "/admin"
              ? pathname === "/admin"
              : pathname === t.href || pathname.startsWith(t.href + "/");
          return (
            <Link
              key={t.href}
              href={t.href}
              aria-current={active ? "page" : undefined}
              className={[
                "relative px-4 py-3 text-sm font-medium transition-colors",
                active
                  ? "text-cyan-300"
                  : "text-zinc-400 hover:text-zinc-200",
              ].join(" ")}
            >
              {t.label}
              {active && (
                <span
                  aria-hidden="true"
                  className="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-cyan-400 shadow-[0_0_12px_rgba(34,211,238,0.55)]"
                />
              )}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
