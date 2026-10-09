import { pageAllows } from "@/lib/admin/context";
import { NoAccess } from "../../AdminShell";
import RevenueClient from "./revenue-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AdminRevenuePage() {
  if (!(await pageAllows("billing:read"))) return <NoAccess permission="billing:read" />;
  return <RevenueClient />;
}
