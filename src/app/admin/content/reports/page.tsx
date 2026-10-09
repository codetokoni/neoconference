import { pageAllows } from "@/lib/admin/context";
import { NoAccess } from "../../AdminShell";
import ReportsClient from "./reports-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function Page() {
  if (!(await pageAllows("content:read"))) return <NoAccess permission="content:read" />;
  return <ReportsClient />;
}
