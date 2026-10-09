import SecurityClient from "./security-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Every administrator has a Security page; the /admin layout has already
// checked who they are and their two-factor.
export default function AdminSecurityPage() {
  return <SecurityClient />;
}
