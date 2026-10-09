import { pageAllows } from "@/lib/admin/context";
import { NoAccess } from "../../../AdminShell";
import CaseClient from "./case-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: { id: string } }) {
  if (!(await pageAllows("content:read"))) return <NoAccess permission="content:read" />;
  return <CaseClient id={params.id} />;
}
