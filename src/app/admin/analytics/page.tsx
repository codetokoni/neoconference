import { pageAllows } from "@/lib/admin/context";
import { NoAccess } from "../AdminShell";
import AnalyticsClient from "./analytics-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The /admin layout has already checked sign-in, administrator status and
// two-factor; this page needs its own permission on top.
export default async function AdminAnalyticsPage() {
  if (!(await pageAllows("analytics:read"))) return <NoAccess permission="analytics:read" />;
  return <AnalyticsClient />;
}
