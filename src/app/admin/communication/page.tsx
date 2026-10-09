import { pageAllows } from "@/lib/admin/context";
import { NoAccess } from "../AdminShell";
import CommsClient from "./comms-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AdminCommunicationPage() {
  if (!(await pageAllows("notifications:send"))) return <NoAccess permission="notifications:send" />;
  return <CommsClient />;
}
