import { pageAllows } from "@/lib/admin/context";
import { NoAccess } from "../AdminShell";
import VoicesClient from "./voices-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AdminVoicesPage() {
  if (!(await pageAllows("voices:manage"))) return <NoAccess permission="voices:manage" />;
  return <VoicesClient />;
}
