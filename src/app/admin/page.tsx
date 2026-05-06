import { redirect } from "next/navigation";
import { getCurrentRole } from "@/lib/roles";
import AdminClient from "./admin-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const role = await getCurrentRole();
  if (!role) redirect("/sign-in");
  if (role !== "admin") {
    return (
      <main className="max-w-2xl mx-auto p-8">
        <h1 className="text-2xl font-semibold mb-3">Access denied</h1>
        <p className="text-sm text-zinc-600">
          Your account role is <code className="px-1.5 py-0.5 rounded bg-zinc-100">{role}</code>. Only admins can view this page.
        </p>
      </main>
    );
  }
  return <AdminClient />;
}
