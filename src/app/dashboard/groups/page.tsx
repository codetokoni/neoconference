// src/app/dashboard/groups/page.tsx
// The groups you belong to, and a way to start a new one.

import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import { listGroupsForUser, roleLabel } from "@/lib/groupStore";
import { unreadChatCount } from "@/lib/groupChat";
import NewGroupButton from "./NewGroupButton";
import GroupIcon from "./GroupIcon";
import DashboardTabs from "@/components/groups/DashboardTabs";

export const dynamic = "force-dynamic";

export default async function GroupsPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in?redirect_url=/dashboard/groups");

  const groups = await listGroupsForUser(userId);
  const unread = await Promise.all(groups.map(({ group }) => unreadChatCount(group.id, userId).catch(() => 0)));

  return (
    <main className="min-h-screen bg-[#05070d] text-white">
      <div className="mx-auto max-w-4xl px-4 sm:px-6 py-10 md:py-14">
        <div className="mb-6">
          <DashboardTabs current="/dashboard/groups" />
        </div>
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
          <div>
            <Link href="/dashboard" className="text-xs text-white/50 hover:text-white transition">
              ← Dashboard
            </Link>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-white">Groups</h1>
            <p className="mt-1.5 text-sm text-white/60">The people you meet with again and again.</p>
          </div>
          <NewGroupButton />
        </div>

        {groups.length === 0 ? (
          <div className="mt-10 rounded-2xl border border-dashed border-slate-800 bg-slate-900/20 p-10 text-center">
            <p className="text-slate-200 font-medium">No groups yet</p>
            <p className="mt-1 text-sm text-slate-400">
              Create one here, or from the attendees of a meeting you hosted.
            </p>
          </div>
        ) : (
          <ul className="mt-8 grid gap-3">
            {groups.map(({ group, role, memberCount }, i) => (
              <li key={group.id} className="min-w-0">
                <Link
                  href={`/dashboard/groups/${encodeURIComponent(group.id)}`}
                  className="flex items-center gap-4 rounded-2xl border border-slate-800 bg-slate-900/40 p-4 hover:border-cyan-400/40 hover:bg-slate-900/70 transition"
                >
                  <GroupIcon name={group.name} iconUrl={group.iconUrl} size={48} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-slate-100">{group.name}</div>
                    <div className="mt-0.5 truncate text-xs text-slate-400">
                      {memberCount} {memberCount === 1 ? "member" : "members"}
                      {group.description ? ` · ${group.description}` : ""}
                    </div>
                  </div>
                  {unread[i] > 0 ? (
                    <span
                      aria-label={`${unread[i]} unread messages`}
                      className="shrink-0 min-w-[22px] h-[22px] px-1.5 rounded-full bg-cyan-500 text-[11px] font-semibold leading-[22px] text-slate-950 text-center"
                    >
                      {unread[i] > 99 ? "99+" : unread[i]}
                    </span>
                  ) : null}
                  <span className="shrink-0 text-xs px-2.5 py-1 rounded-full bg-slate-800/60 border border-slate-700 text-slate-300">
                    {roleLabel(role)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
