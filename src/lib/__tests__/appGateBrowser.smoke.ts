// Run: npx tsx src/lib/__tests__/appGateBrowser.smoke.ts
//
// A meeting's owner can let Android phones stay in the browser for it ("Phones
// open it in the browser"), so its link never shows "Get the NeoConference
// app". Asked for /testify … /testify10 and /live, rooms people watch from a
// link. Through the real PATCH /api/events/[id] and GET /api/app/gate with
// Clerk and KV stood in for (./apiV1-stubs).

import assert from "node:assert/strict";
import "./apiV1-stubs/install";

process.env.CLERK_SECRET_KEY = "";
process.env.ADMIN_EMAILS = "";

type Stubbed = typeof globalThis & { __users: Record<string, { emails?: string[] }>; __who?: string };
const g = globalThis as Stubbed;
g.__users = { user_owner: { emails: ["owner@example.com"] }, user_other: { emails: ["other@example.com"] } };

let finished = false;
process.on("exit", (code) => {
  if (code === 0 && !finished) {
    console.error("exited before the last check — something never answered");
    process.exitCode = 1;
  }
});

let n = 0;
const t = async (name: string, fn: () => Promise<void>) => {
  await fn();
  n++;
  console.log("  ok  " + name);
};

async function main() {
  const { eventStore } = await import("../eventStore");
  const R = {
    event: await import("../../app/api/events/[id]/route"),
    gate: await import("../../app/api/app/gate/route"),
  };
  const now = new Date().toISOString();
  for (const slug of ["testify", "meeting"]) {
    await eventStore.create({
      id: "ev_" + slug, slug, name: slug, ownerUserId: "user_owner", ownerEmail: "owner@example.com",
      state: "live", isPermanent: true, visibility: "unlisted", createdAt: now, updatedAt: now, roles: [],
    } as unknown as Parameters<typeof eventStore.create>[0]);
  }

  const gate = async (slug: string) =>
    (await (await R.gate.GET(new Request("https://www.neoconference.app/api/app/gate?slug=" + slug))).json()) as { browser: boolean };
  async function patch(who: string, id: string, body: unknown) {
    g.__who = who;
    const res = await R.event.PATCH(
      new Request("https://www.neoconference.app/api/events/" + id, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    );
    return res.status;
  }

  console.log("phones open a meeting in the browser");

  await t("by default a meeting's link asks Android phones for the app", async () => {
    assert.deepEqual(await gate("testify"), { browser: false });
  });

  await t("someone else cannot change it", async () => {
    assert.equal(await patch("user_other", "ev_testify", { browserOnPhones: true }), 403);
    assert.deepEqual(await gate("testify"), { browser: false });
  });

  await t("the owner turns it on: phones stay in the browser for that meeting only", async () => {
    assert.equal(await patch("user_owner", "ev_testify", { browserOnPhones: true }), 200);
    assert.deepEqual(await gate("testify"), { browser: true });
    assert.deepEqual(await gate("TESTIFY"), { browser: true });
    assert.deepEqual(await gate("meeting"), { browser: false });
  });

  await t("saving other settings leaves it as it is; turning it off brings the app screen back", async () => {
    assert.equal(await patch("user_owner", "ev_testify", { name: "Testify" }), 200);
    assert.deepEqual(await gate("testify"), { browser: true });
    assert.equal(await patch("user_owner", "ev_testify", { browserOnPhones: false }), 200);
    assert.deepEqual(await gate("testify"), { browser: false });
  });

  await t("an unknown or missing meeting: the usual app screen", async () => {
    assert.deepEqual(await gate("nobody-here"), { browser: false });
    assert.deepEqual(await gate(""), { browser: false });
  });

  await t("on the sign-in page, the meeting is the one it leads back to", async () => {
    const { meetingForGate } = await import("../appGate");
    // A signed-out visitor to /testify lands here; the setting must follow.
    assert.equal(meetingForGate("/sign-in", "?redirect_url=%2Ftestify"), "testify");
    assert.equal(meetingForGate("/sign-in", "?redirect_url=" + encodeURIComponent("https://www.neoconference.app/testify10")), "testify10");
    assert.equal(meetingForGate("/sign-up", "?redirect_url=%2Froom%2Flive%3Fevent%3Dlive"), "live");
    assert.equal(meetingForGate("/testify"), "testify");
    // Not a meeting, or another site: nothing.
    assert.equal(meetingForGate("/sign-in", "?redirect_url=%2Fdashboard"), null);
    assert.equal(meetingForGate("/sign-in", "?redirect_url=" + encodeURIComponent("https://evil.example/testify")), null);
    assert.equal(meetingForGate("/sign-in"), null);
    assert.equal(meetingForGate("/pricing", "?redirect_url=%2Ftestify"), null);
  });

  finished = true;
  console.log(`\n${n} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
