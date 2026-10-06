// src/app/dashboard/groups/[id]/reports/[eid]/page.tsx
// One meeting's report: Moderator and up, as the API allows. Anyone else,
// or a meeting of another group, gets the same 404.

import { auth } from "@clerk/nextjs/server";
import { notFound, redirect } from "next/navigation";
import { getIdentity } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { getGroup, getMember, groupActor } from "@/lib/groupStore";
import { eventStore } from "@/lib/eventStore";
import { getMeetingReport, reportVisible } from "@/lib/groupReports";
import MeetingReportView from "./MeetingReportView";

export const dynamic = "force-dynamic";

export default async function MeetingReportPage({ params }: { params: Promise<{ id: string; eid: string }> }) {
  const { id, eid } = await params;
  const { userId } = await auth();
  if (!userId) redirect(`/sign-in?redirect_url=${encodeURIComponent(`/dashboard/groups/${id}/reports/${eid}`)}`);

  const [group, member] = await Promise.all([getGroup(id), getMember(id, userId)]);
  if (!group || !member) notFound();
  const actor = groupActor({ ...(await getIdentity()), userId }, member);
  if (!can(actor, "group:reports:view")) notFound();
  if (!(await reportVisible(await eventStore.byId(eid), id, userId))) notFound();
  const report = await getMeetingReport(eid);
  if (!report) notFound();

  return <MeetingReportView report={report} groupId={id} canExport={can(actor, "group:reports:export")} />;
}
