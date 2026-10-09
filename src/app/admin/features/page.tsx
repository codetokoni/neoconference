import { pageAllows } from "@/lib/admin/context";
import { NoAccess } from "../AdminShell";
import FeaturesClient from "./features-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AdminFeaturesPage() {
  if (!(await pageAllows("features:write"))) return <NoAccess permission="features:write" />;
  return <FeaturesClient />;
}
