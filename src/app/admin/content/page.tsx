import { pageAllows } from "@/lib/admin/context";
import { NoAccess } from "../AdminShell";
import FilesClient from "./files-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AdminContentPage({ searchParams }: { searchParams: { owner?: string; type?: string } }) {
  if (!(await pageAllows("content:read"))) return <NoAccess permission="content:read" />;
  const pick = (v: unknown) => (typeof v === "string" ? v.slice(0, 80) : "");
  return <FilesClient initial={{ owner: pick(searchParams?.owner), type: pick(searchParams?.type) }} />;
}
