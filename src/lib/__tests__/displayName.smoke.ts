// Run: npx tsx src/lib/__tests__/displayName.smoke.ts
//
// The name others see in meetings can be chosen (src/lib/attendeeName.ts
// chosenMeetingName, /api/me/display-name). In the SA meeting of 23 Nov 2026
// someone shown by their KingsChat handle asked how to show their name and
// title: the join screen had a "Display name" field the server ignored.
// Driven through the real routes with Clerk, KV and LiveKit stood in for.

import assert from "node:assert/strict";
import "./apiV1-stubs/install";

process.env.CLERK_SECRET_KEY = "sk_test_display_name";
process.env.PLATFORM_OWNER_EMAILS = "platform@example.com";
process.env.ADMIN_EMAILS = "";
process.env.KV_REST_API_URL = "https://kv.invalid";
process.env.KV_REST_API_TOKEN = "stub";
process.env.NEXT_PUBLIC_LIVEKIT_URL = "wss://lk.test";
process.env.LIVEKIT_API_KEY = "lk_key";
process.env.LIVEKIT_API_SECRET = "lk_secret_that_is_long_enough_for_hs256";

type P = { identity: string; name?: string };
const g = globalThis as typeof globalThis & {
  __users: Record<string, { plan?: string; emails?: string[]; metadata?: Record<string, unknown> }>;
  __who?: string;
  __lkParticipants?: Record<string, P[]>;
  __lkUpdated?: Array<{ room: string; identity: string; name?: string }>;
};
g.__users = {
  user_owner: { plan: "enterprise", emails: ["owner@example.com"] },
  user_rainy: { emails: ["rainy@example.com"], metadata: { kingschat: { id: "kc123", username: "rainy" } } },
  user_other: { emails: ["other@example.com"] },
};

let finished = false;
process.on("exit", (code) => {
  if (code === 0 && !finished) {
    console.error("exited before the last check — something never answered");
    process.exitCode = 1;
  }
});
let n = 0;
const t = async (name: string, fn: () => Promise<void> | void) => {
  await fn();
  n++;
  console.log("  ok  " + name);
};

async function main() {
  const A = await import("../attendeeName");

  console.log("the rules");

  await t("a name with a title, any script, digits and . , ' - ( ) & is fine", () => {
    for (const ok of ["Pst Nomvula", "Pst. Nomvula Dube", "Bro John (Zone 3)", "Sis. Ọlá-Adé", "José & Maria", "Group 12"]) {
      assert.equal(A.meetingNameProblem(ok), "", ok);
    }
  });

  await t("an email, symbols, one letter, blank or too long are not", () => {
    assert.match(A.meetingNameProblem("rainy@example.com"), /not an email/);
    assert.match(A.meetingNameProblem("<script>"), /letters and numbers/);
    assert.match(A.meetingNameProblem("A"), /two letters/);
    assert.match(A.meetingNameProblem("   "), /Enter the name/);
    assert.match(A.meetingNameProblem("x".repeat(61)), /under 60/);
  });

  await t("the chosen name wins over a KingsChat handle and the account's own name; an invalid saved one is ignored", () => {
    const kc = { publicMetadata: { kingschat: { id: "kc1", username: "rainy" } } };
    assert.equal(A.displayNameFor(kc), "rainy");
    assert.equal(A.displayNameFor({ publicMetadata: { ...kc.publicMetadata, meetingName: "  Pst   Nomvula " } }), "Pst Nomvula");
    assert.equal(A.displayNameFor({ firstName: "Ann", lastName: "Lee", publicMetadata: { meetingName: "Sis Ann" } }), "Sis Ann");
    assert.equal(A.displayNameFor({ publicMetadata: { ...kc.publicMetadata, meetingName: "a@b.c" } }), "rainy");
  });

  console.log("/api/me/display-name");

  const { NextRequest } = await import("next/server");
  const route = await import("../../app/api/me/display-name/route");
  const token = await import("../../app/api/livekit/token/route");
  const { eventStore } = await import("../eventStore");
  const { rememberConfirmation } = await import("../attendanceName");
  const get = async (who?: string) => {
    g.__who = who;
    const res = await route.GET();
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const post = async (who: string | undefined, body: unknown) => {
    g.__who = who;
    const res = await route.POST(new Request("https://neolinguameet.com/api/me/display-name", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const tokenName = async (who: string) => {
    g.__who = who;
    await rememberConfirmation(who, "Nomvula Dube");
    const res = await token.GET(new NextRequest("https://neolinguameet.com/api/livekit/token?room=sa&event=sa&nonce=t1"));
    const body = (await res.json()) as { token?: string };
    assert.equal(res.status, 200, JSON.stringify(body));
    return (JSON.parse(Buffer.from(body.token!.split(".")[1], "base64url").toString()) as { name: string }).name;
  };
  const now = new Date().toISOString();
  await eventStore.create({
    id: "ev_sa", slug: "sa", name: "SA prayer", ownerUserId: "user_owner", ownerEmail: "owner@example.com",
    state: "live", visibility: "unlisted", livekitRoom: "sa", waitingRoomEnabled: false, waitForHost: false,
    createdAt: now, updatedAt: now, roles: [],
  } as unknown as Parameters<typeof eventStore.create>[0]);

  await t("signed in only", async () => {
    assert.equal((await get(undefined)).status, 401);
    assert.equal((await post(undefined, { name: "Pst Nomvula" })).status, 401);
  });

  await t("at first, meetings show the KingsChat handle, not chosen", async () => {
    assert.deepEqual((await get("user_rainy")).body, { name: "rainy", chosen: false });
    assert.equal(await tokenName("user_rainy"), "rainy");
  });

  await t("chosen: saved, and every meeting joined from now on shows it", async () => {
    const r = await post("user_rainy", { name: "  Pst   Nomvula " });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.name, "Pst Nomvula");
    assert.deepEqual((await get("user_rainy")).body, { name: "Pst Nomvula", chosen: true });
    assert.equal(await tokenName("user_rainy"), "Pst Nomvula");
  });

  await t("in a meeting: everyone there sees it at once, on each of this person's connections, and nobody else is renamed", async () => {
    g.__lkParticipants = { sa: [{ identity: "user_rainy#phone", name: "Pst Nomvula" }, { identity: "user_rainy#web", name: "Pst Nomvula" }, { identity: "user_other#x", name: "other" }, { identity: "user_rainyfan", name: "fan" }] };
    g.__lkUpdated = [];
    const r = await post("user_rainy", { name: "Pastor Nomvula Dube", room: "sa" });
    assert.equal(r.body.renamed, 2);
    assert.deepEqual(g.__lkUpdated.map((u) => [u.identity, u.name]).sort(), [["user_rainy#phone", "Pastor Nomvula Dube"], ["user_rainy#web", "Pastor Nomvula Dube"]]);
    assert.equal(g.__lkParticipants.sa.find((p) => p.identity === "user_rainyfan")?.name, "fan");
  });

  await t("not a name: refused with the reason, and the saved name is unchanged", async () => {
    const r = await post("user_rainy", { name: "rainy@example.com", room: "sa" });
    assert.equal(r.status, 400);
    assert.match(String(r.body.message), /not an email/);
    assert.equal((await get("user_rainy")).body.name, "Pastor Nomvula Dube");
  });

  await t("empty goes back to the usual name; the attendance name is untouched throughout", async () => {
    const r = await post("user_rainy", { name: "" });
    assert.deepEqual([r.body.name, r.body.chosen], ["rainy", false]);
    assert.equal(await tokenName("user_rainy"), "rainy");
    const { clerkClient } = await import("@clerk/nextjs/server");
    const u = await (await clerkClient()).users.getUser("user_rainy");
    assert.equal((u.privateMetadata as { attendanceName?: string }).attendanceName ?? "", "", "the attendance name was never set by this");
  });

  await t("a room name that is not one is ignored (saved, nobody renamed)", async () => {
    g.__lkUpdated = [];
    const r = await post("user_rainy", { name: "Pst Nomvula", room: "../etc" });
    assert.equal(r.status, 200);
    assert.equal(r.body.renamed, 0);
    assert.deepEqual(g.__lkUpdated, []);
  });

  finished = true;
  console.log(`\n${n} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
