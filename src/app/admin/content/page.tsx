import { pageAllows } from "@/lib/admin/context";
import { NoAccess } from "../AdminShell";
import FilesClient from "./files-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AdminContentPage() {
  if (!(await pageAllows("content:read"))) return <NoAccess permission="content:read" />;
  // Filters a link can carry (read from the address bar by the client):
  // /admin/content?owner=…&type=…&q=…&state=all&status=…&visibility=…&from=…&to=…
  return <FilesClient />;
}
