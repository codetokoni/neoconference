import { pageAllows } from "@/lib/admin/context";
import { NoAccess } from "../../AdminShell";
import TicketClient from "./ticket-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AdminTicketPage({ params }: { params: { id: string } }) {
  if (!(await pageAllows("support:read"))) return <NoAccess permission="support:read" />;
  return <TicketClient id={params.id} />;
}
