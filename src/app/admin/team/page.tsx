import { pageAllows } from "@/lib/admin/context";
import { NoAccess } from "../AdminShell";
import TeamClient from "./team-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AdminTeamPage() {
  if (!(await pageAllows("admins:read"))) return <NoAccess permission="admins:read" />;
  return <TeamClient />;
}
