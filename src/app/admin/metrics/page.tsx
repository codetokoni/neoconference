import { redirect } from "next/navigation";

// Metrics became part of Analytics (/admin/analytics), which reads real plans
// instead of guessing them; old links land there.
export default function AdminMetricsPage() {
  redirect("/admin/analytics");
}
