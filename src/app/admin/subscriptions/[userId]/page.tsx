import Link from "next/link";
import { pageAllows } from "@/lib/admin/context";
import { NoAccess } from "../../AdminShell";
import { PageHeader } from "../../ui";
import SubscriptionPanel from "../SubscriptionPanel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The account's name and email are only known once the panel has loaded,
// so the panel's first card names whose subscription this is.
export default async function AdminSubscriptionPage({ params }: { params: { userId: string } }) {
  if (!(await pageAllows("plans:read"))) return <NoAccess permission="plans:read" />;
  const userId = decodeURIComponent(params.userId);
  return (
    <div>
      <Link href="/admin/subscriptions" className="text-sm text-zinc-400 hover:text-zinc-200">
        ← Subscriptions
      </Link>
      <div className="mt-1">
        <PageHeader
          title="Subscription"
          sub={
            <>
              One account&apos;s plan, its history and payments. Account <span className="break-all font-mono text-xs">{userId}</span> ·{" "}
              <Link href={`/admin/users/${encodeURIComponent(userId)}`} className="text-cyan-300 hover:underline">
                open the user
              </Link>
            </>
          }
        />
      </div>
      <SubscriptionPanel userId={userId} />
    </div>
  );
}
