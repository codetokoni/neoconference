// GET /api/partner/v1/roles — the organisation's report administrators.
// PUT /api/partner/v1/roles { orgAdmins: ["u_1", …] } — replace them.
//
// The partner's own user ids. Administrators read every zone's reports and
// the organisation report. Set by the partner's server (it holds the key),
// or in NeoLinguaMeet's admin.

import { NextRequest } from "next/server";
import { fail, ok, readJson } from "@/lib/partners/http";
import { partnerCaller } from "@/lib/partners/reportAccess";
import { getOrgAdmins, setOrgAdmins } from "@/lib/partners/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const { integration } = await partnerCaller(req);
    return ok({ orgAdmins: await getOrgAdmins(integration.id) });
  } catch (e) {
    return fail(e);
  }
}

export async function PUT(req: NextRequest) {
  try {
    const { integration } = await partnerCaller(req);
    const body = await readJson(req);
    return ok({ orgAdmins: await setOrgAdmins(integration.id, body.orgAdmins, "partner") });
  } catch (e) {
    return fail(e);
  }
}
