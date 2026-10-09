import { pageAllows } from "@/lib/admin/context";
import { NoAccess } from "../../AdminShell";
import ArticleEditor from "./article-editor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// /admin/help/new writes a new article; /admin/help/<id> edits one.
export default async function AdminHelpArticlePage({ params }: { params: { id: string } }) {
  if (!(await pageAllows("support:read"))) return <NoAccess permission="support:read" />;
  return <ArticleEditor id={params.id === "new" ? null : params.id} />;
}
