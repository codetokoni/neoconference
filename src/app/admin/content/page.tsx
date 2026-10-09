import { pageAllows } from "@/lib/admin/context";
import { NoAccess } from "../AdminShell";
import FilesClient from "./files-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Search = { owner?: string; type?: string; q?: string; state?: string };

export default async function AdminContentPage({ searchParams }: { searchParams: Search }) {
  if (!(await pageAllows("content:read"))) return <NoAccess permission="content:read" />;
  // Filters a link can carry: /admin/content?owner=…&type=…&q=…&state=all
  const pick = (v: unknown) => (typeof v === "string" ? v.slice(0, 120) : "");
  return <FilesClient initial={{ owner: pick(searchParams?.owner), type: pick(searchParams?.type), q: pick(searchParams?.q), state: pick(searchParams?.state) }} />;
}
