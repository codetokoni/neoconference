// src/app/admin/layout.tsx
//
// One gate for every /admin page: signed in, an administrator (or the
// owner), not suspended, two-factor set up, and a code entered this session.
// Only then are the pages rendered. Their API routes check the same things
// again (src/lib/admin/context.ts), so this is not the only line.

import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { loadAdminForPage, publicContext } from "@/lib/admin/context";
import AdminShell from "./AdminShell";
import { AdminRefused, MfaEnroll, MfaVerify } from "./AdminGate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const who = await loadAdminForPage();
  if (who.kind === "signed_out") redirect("/sign-in?redirect_url=/admin");
  if (who.kind !== "admin") {
    return who.kind === "admin_suspended" ? (
      <AdminRefused title="Administrator access suspended" body="Your administrator access has been suspended. Contact the platform owner." />
    ) : (
      <AdminRefused title="Access denied" body="This account is not a platform administrator." />
    );
  }
  const { ctx } = who;
  if (!ctx.mfa.enrolled) return <MfaEnroll email={ctx.email} isOwner={ctx.isOwner} />;
  if (!ctx.mfa.verified) return <MfaVerify email={ctx.email} />;
  return <AdminShell me={publicContext(ctx)}>{children}</AdminShell>;
}
