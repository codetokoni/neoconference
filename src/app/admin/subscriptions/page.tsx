import { pageAllows } from "@/lib/admin/context";
import { NoAccess } from "../AdminShell";
import SubscriptionsClient from "./subscriptions-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AdminSubscriptionsPage() {
  if (!(await pageAllows("plans:read"))) return <NoAccess permission="plans:read" />;
  return <SubscriptionsClient />;
}
