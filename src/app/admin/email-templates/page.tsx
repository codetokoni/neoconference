import { pageAllows } from "@/lib/admin/context";
import { NoAccess } from "../AdminShell";
import TemplatesClient from "./templates-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AdminEmailTemplatesPage() {
  if (!(await pageAllows("notifications:send"))) return <NoAccess permission="notifications:send" />;
  return <TemplatesClient />;
}
