import { pageAllows } from "@/lib/admin/context";
import { NoAccess } from "../../AdminShell";
import SummaryClient from "./summary-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AdminAnalyticsSummaryPage() {
  if (!(await pageAllows("analytics:read"))) return <NoAccess permission="analytics:read" />;
  return <SummaryClient />;
}
