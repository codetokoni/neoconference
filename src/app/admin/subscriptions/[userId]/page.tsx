import Link from "next/link";
import { pageAllows } from "@/lib/admin/context";
import { NoAccess } from "../../AdminShell";
import SubscriptionPanel from "../SubscriptionPanel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AdminSubscriptionPage({ params }: { params: { userId: string } }) {
  if (!(await pageAllows("plans:read"))) return <NoAccess permission="plans:read" />;
  return (
    <div>
      <Link href="/admin/subscriptions" className="text-sm text-zinc-400 hover:text-zinc-200">
        ← Subscriptions
      </Link>
      <h1 className="mb-4 mt-1 text-2xl font-semibold text-cyan-50">Subscription</h1>
      <SubscriptionPanel userId={decodeURIComponent(params.userId)} />
    </div>
  );
}
