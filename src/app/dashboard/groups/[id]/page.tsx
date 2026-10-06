// src/app/dashboard/groups/[id]/page.tsx
// One group: who is in it, what has happened, and — for those whose rank
// allows — the controls to change it. Outside the group this is a 404, the
// same answer the API gives.

import { auth } from "@clerk/nextjs/server";
import { notFound, redirect } from "next/navigation";
import { getIdentity } from "@/lib/authz";
import {
  getGroup,
  getMember,
  groupActor,
  groupCapabilities,
  listActivity,
  listMembers,
} from "@/lib/groupStore";
import { unreadChatCount } from "@/lib/groupChat";
import GroupView from "./GroupView";

export const dynamic = "force-dynamic";

export default async function GroupPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  const { tab } = await searchParams;
  const { userId } = await auth();
  if (!userId) redirect(`/sign-in?redirect_url=${encodeURIComponent(`/dashboard/groups/${id}`)}`);

  const [group, member] = await Promise.all([getGroup(id), getMember(id, userId)]);
  if (!group || !member) notFound();

  const identity = await getIdentity();
  const actor = groupActor({ ...identity, userId }, member);
  const [members, activity, chatUnread] = await Promise.all([
    listMembers(id),
    listActivity(id, 50),
    unreadChatCount(id, userId).catch(() => 0),
  ]);

  return (
    <GroupView
      group={group}
      members={members}
      activity={activity}
      me={{ userId, role: member.role }}
      capabilities={groupCapabilities(actor)}
      chatUnread={chatUnread}
      {...(tab ? { initialTab: tab } : {})}
    />
  );
}
