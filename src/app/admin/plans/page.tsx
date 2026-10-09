import { pageAllows } from "@/lib/admin/context";
import { NoAccess } from "../AdminShell";
import PlansClient from "./plans-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AdminPlansPage() {
  if (!(await pageAllows("plans:read"))) return <NoAccess permission="plans:read" />;
  return <PlansClient />;
}
