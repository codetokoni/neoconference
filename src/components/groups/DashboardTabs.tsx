// The dashboard's three sections: your meetings, your groups, and reports of
// the group meetings you were part of.

import Link from "next/link";

const TABS = [
  { href: "/dashboard", label: "Meetings" },
  { href: "/dashboard/groups", label: "Groups" },
  { href: "/dashboard/reports", label: "Reports" },
] as const;

export default function DashboardTabs({ current }: { current: "/dashboard" | "/dashboard/groups" | "/dashboard/reports" }) {
  return (
    <nav aria-label="Dashboard" className="flex gap-1 border-b border-white/10 overflow-x-auto">
      {TABS.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          aria-current={t.href === current ? "page" : undefined}
          className={
            "px-4 py-2.5 text-sm whitespace-nowrap border-b-2 -mb-px transition " +
            (t.href === current ? "border-cyan-400 text-cyan-100" : "border-transparent text-slate-400 hover:text-slate-200")
          }
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
