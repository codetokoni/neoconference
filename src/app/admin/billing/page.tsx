import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// The billing area opens on its payments list.
export default function AdminBillingPage() {
  redirect("/admin/billing/payments");
}
