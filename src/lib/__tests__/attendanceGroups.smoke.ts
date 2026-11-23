// Run: npx tsx src/lib/__tests__/attendanceGroups.smoke.ts
//
// Attendance by church or group (src/lib/attendanceGroups.ts), asked for in
// the SA prayer meeting's feedback: the owner lists the churches with their
// leaders; people pick theirs when confirming their full name; after each
// session the owner gets a spreadsheet with a tab per church and each leader
// their own people. Driven through the real routes — the meeting's settings,
// the full-name step, the LiveKit webhook (start, joins, leaves, finish), the
// end route, the job, the downloads and the owner's panel — with Clerk, KV
// and LiveKit stood in for (./apiV1-stubs) and the messages recorded.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import "./apiV1-stubs/install";

process.env.CLERK_SECRET_KEY = "sk_test_attendance_groups";
process.env.PLATFORM_OWNER_EMAILS = "platform@example.com";
process.env.ADMIN_EMAILS = "";
process.env.KV_REST_API_URL = "https://kv.invalid";
process.env.KV_REST_API_TOKEN = "stub";
process.env.NEXT_PUBLIC_LIVEKIT_URL = "wss://lk.test";
process.env.LIVEKIT_API_KEY = "lk";
process.env.LIVEKIT_API_SECRET = "lk_secret_that_is_long_enough_for_hs256";
process.env.CRON_SECRET = "cron-secret-attendance-groups";

const g = globalThis as typeof globalThis & {
  __users: Record<string, { plan?: string; emails?: string[]; metadata?: Record<string, unknown> }>;
  __who?: string;
  __lkParticipants?: Record<string, Array<{ identity: string }>>;
};
g.__users = {
  user_owner: { plan: "enterprise", emails: ["region@example.com"] },
  user_free: { emails: ["free@example.com"] },
  user_ann: { emails: ["ann@example.com"] },
  user_ben: { emails: ["ben@example.com"] },
  user_cy: { emails: ["cy@example.com"] },
  user_dee: { emails: ["dee@example.com"] },
};
g.__lkParticipants = { sa: [] };

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
  const { NextRequest } = await import("next/server");
  const { AccessToken } = await import("livekit-server-sdk");
  const AG = await import("../attendanceGroups");
  const { eventStore } = await import("../eventStore");
  const R = {
    event: await import("../../app/api/events/[id]/route"),
    end: await import("../../app/api/events/[id]/end/route"),
    panel: await import("../../app/api/events/[id]/attendance-groups/route"),
    fullName: await import("../../app/api/me/full-name/route"),
    webhook: await import("../../app/api/livekit/webhook/route"),
    cron: await import("../../app/api/cron/attendance-groups/route"),
    download: await import("../../app/api/attendance-groups/[token]/route"),
  };
  type Sent = { to: string; subject?: string; text: string; via: "kc" | "mail" };
  const sent: Sent[] = [];
  AG.__setAttendanceSenders({
    kc: async (_from, to, text) => (sent.push({ to, text, via: "kc" }), { ok: true }),
    mail: async (to, subject, text) => (sent.push({ to, subject, text, via: "mail" }), { ok: true }),
    ownerEmail: async () => "region@example.com",
  });

  const json = async (res: Response) => ({ status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> });
  const as = (who: string | undefined) => (g.__who = who);
  const patch = (who: string, id: string, body: unknown) => {
    as(who);
    return R.event.PATCH(new Request(`https://neolinguameet.com/api/events/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) }).then(json);
  };
  const nameGet = (who: string, slug?: string) => {
    as(who);
    return R.fullName.GET(new Request(`https://neolinguameet.com/api/me/full-name${slug ? `?event=${slug}` : ""}`)).then(json);
  };
  const namePost = (who: string, body: unknown) => {
    as(who);
    return R.fullName.POST(new Request("https://neolinguameet.com/api/me/full-name", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).then(json);
  };
  const webhook = async (event: Record<string, unknown>) => {
    const body = JSON.stringify(event);
    const at = new AccessToken("lk", process.env.LIVEKIT_API_SECRET!);
    at.sha256 = createHash("sha256").update(body).digest("base64");
    const res = await R.webhook.POST(new NextRequest("https://neolinguameet.com/api/livekit/webhook", { method: "POST", headers: { authorization: await at.toJwt(), "content-type": "application/webhook+json" }, body }));
    return json(res);
  };
  const cron = () => R.cron.GET(new NextRequest("https://neolinguameet.com/api/cron/attendance-groups", { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } })).then(json);
  const download = async (token: string) => R.download.GET(new Request(`https://neolinguameet.com/api/attendance-groups/${token}`), { params: Promise.resolve({ token }) });
  const sheets = async (res: Response) => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await res.arrayBuffer());
    const out: Record<string, string[][]> = {};
    wb.eachSheet((s) => {
      const rows: string[][] = [];
      s.eachRow((r) => rows.push((r.values as unknown[]).slice(1).map((v) => String(v ?? ""))));
      out[s.name] = rows;
    });
    return out;
  };

  const now = new Date().toISOString();
  const make = (id: string, slug: string, owner: string) =>
    eventStore.create({
      id, slug, name: "SA Prayer Meeting", ownerUserId: owner, ownerEmail: `${owner}@example.com`,
      state: "scheduled", visibility: "unlisted", livekitRoom: slug, waitingRoomEnabled: false, waitForHost: false,
      createdAt: now, updatedAt: now, roles: [],
    } as unknown as Parameters<typeof eventStore.create>[0]);
  await make("ev_sa", "sa", "user_owner");
  await make("ev_free", "freemeet", "user_free");

  console.log("the list");

  await t("tidied; a name twice, the reserved 'Not given', a bad leader or too many are refused", () => {
    assert.deepEqual(AG.cleanGroups([{ name: "  Christ Embassy   Soweto " }, { name: "" }]), [{ name: "Christ Embassy Soweto" }]);
    assert.match((AG.cleanGroups([{ name: "Soweto" }, { name: "soweto" }]) as { problem: string }).problem, /listed twice/);
    assert.match((AG.cleanGroups([{ name: "Not given" }]) as { problem: string }).problem, /kept for people/);
    assert.match((AG.cleanGroups([{ name: "A", leader: { email: "nope" } }]) as { problem: string }).problem, /not a KingsChat handle or an email/);
    assert.match((AG.cleanGroups(Array.from({ length: 301 }, (_, i) => ({ name: `G${i}` }))) as { problem: string }).problem, /At most 300/);
    assert.equal(AG.cleanGroups(null), null);
    assert.equal(AG.cleanGroups([]), null);
  });

  await t("saved by the owner on a paid plan; refused with the reason; a free plan is asked to upgrade", async () => {
    const bad = await patch("user_owner", "ev_sa", { attendanceGroups: { groups: [{ name: "A" }, { name: "a" }] } });
    assert.equal(bad.status, 400);
    assert.match(String(bad.body.message), /listed twice/);
    assert.equal((await patch("user_free", "ev_free", { attendanceGroups: { groups: [{ name: "A" }] } })).status, 402);
    assert.equal((await patch("user_ann", "ev_sa", { attendanceGroups: { groups: [{ name: "A" }] } })).status, 403, "not the owner");
    const ok = await patch("user_owner", "ev_sa", {
      attendanceGroups: {
        groups: [
          { name: "Soweto", leader: { email: "Soweto.Lead@example.com" } },
          { name: "Pretoria", leader: { kcHandle: "@nobody_signed_in", email: "pta@example.com" } },
          { name: "Durban" },
        ],
      },
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const ev = await eventStore.byId("ev_sa");
    assert.deepEqual(AG.groupNames(ev!), ["Soweto", "Pretoria", "Durban"]);
    assert.equal(ev!.attendanceGroups!.groups[0].leader!.email, "soweto.lead@example.com");
  });

  console.log("picking one when joining (/api/me/full-name)");

  await t("asked with the meeting: the list and their last pick; without it, nothing changes", async () => {
    const r = await nameGet("user_ann", "sa");
    assert.deepEqual([r.body.groups, r.body.group], [["Soweto", "Pretoria", "Durban"], ""]);
    assert.equal((await nameGet("user_ann")).body.groups, undefined);
    assert.equal((await nameGet("user_ann", "freemeet")).body.groups, undefined, "a meeting with no list");
  });

  await t("a pick not on the list is refused and nothing is saved; one on it (any case) is kept as listed", async () => {
    const bad = await namePost("user_ann", { fullName: "Ann Mokoena", event: "sa", group: "Cape Town" });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.message, "Choose your church or group from the list.");
    assert.equal((await nameGet("user_ann", "sa")).body.fullName, "", "the name was not saved either");
    const ok = await namePost("user_ann", { fullName: "Ann Mokoena", event: "sa", group: "  soweto " });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.group, "Soweto");
    assert.equal((await nameGet("user_ann", "sa")).body.group, "Soweto");
  });

  await t("no pick (an app too old to ask) still confirms the name", async () => {
    const r = await namePost("user_dee", { fullName: "Dee Naidoo" });
    assert.equal(r.status, 200);
    assert.equal(r.body.group, undefined);
  });

  for (const [who, name, group] of [["user_ben", "Ben Dlamini", "Soweto"], ["user_cy", "Cy van Wyk", "Pretoria"]] as const) {
    await namePost(who, { fullName: name, event: "sa", group });
  }

  console.log("a session ends; the job sends it");

  // An hour and ten minutes ago, so it ended twelve minutes ago.
  const base = Math.floor(Date.now() / 1000) - 70 * 60;
  const at = (min: number) => String(base + min * 60);
  const person = (identity: string, name: string) => ({ identity, name, metadata: JSON.stringify({ role: "attendee" }) });
  // Yesterday's session, before the list existed: never sent.
  await webhook({ event: "participant_joined", room: { name: "sa" }, participant: person("user_ben#old", "ben"), createdAt: String(base - 24 * 3600) });
  await webhook({ event: "participant_left", room: { name: "sa" }, participant: person("user_ben#old", "ben"), createdAt: String(base - 24 * 3600 + 600) });

  await t("the webhook's room_finished queues it; nothing goes out until five minutes after the end", async () => {
    assert.equal((await webhook({ event: "room_started", room: { name: "sa" }, createdAt: at(0) })).status, 200);
    await webhook({ event: "participant_joined", room: { name: "sa" }, participant: person("user_ann#p", "ann_kc"), createdAt: at(1) });
    await webhook({ event: "participant_joined", room: { name: "sa" }, participant: person("user_ben#w", "ben_kc"), createdAt: at(2) });
    await webhook({ event: "participant_joined", room: { name: "sa" }, participant: person("user_cy#w", "cy_kc"), createdAt: at(3) });
    await webhook({ event: "participant_joined", room: { name: "sa" }, participant: person("user_dee#a", "dee_kc"), createdAt: at(4) });
    for (const [id, nm, m] of [["user_ann#p", "ann_kc", 50], ["user_ben#w", "ben_kc", 55], ["user_cy#w", "cy_kc", 56], ["user_dee#a", "dee_kc", 57]] as const) {
      await webhook({ event: "participant_left", room: { name: "sa" }, participant: person(id, nm), createdAt: at(m) });
    }
    const fin = await webhook({ event: "room_finished", room: { name: "sa" }, createdAt: at(58) });
    assert.equal(fin.body.transitioned, true, JSON.stringify(fin.body));
    assert.deepEqual(await AG.sendDue((base + 58 * 60) * 1000 + 3 * 60_000), { sent: 0, skipped: 0 }, "not yet: three minutes after it ended");
  });

  let ownerToken = "";
  let leaderLink = "";
  await t("then the owner gets every group and each leader their own people, once", async () => {
    const r = await cron();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.sent, 1);
    const soweto = sent.find((s) => s.to === "soweto.lead@example.com")!;
    assert.match(soweto.text, /^Attendance for Soweto: SA Prayer Meeting/);
    assert.match(soweto.text, /2 of your people attended/);
    const pta = sent.filter((s) => s.to === "pta@example.com");
    assert.equal(pta.length, 1);
    assert.match(pta[0].text, /1 of your people attended/);
    assert.equal(sent.filter((s) => s.via === "kc").length, 0, "nobody signed in with the Pretoria handle: no KingsChat message");
    assert.equal(sent.some((s) => /Durban/.test(s.text) && s.to !== "region@example.com"), false, "Durban has no leader");
    const owner = sent.find((s) => s.to === "region@example.com")!;
    assert.match(owner.text, /^4 attended on /);
    ownerToken = /\/api\/attendance-groups\/([A-Za-z0-9_-]{32})/.exec(owner.text)![1];
    leaderLink = /\/api\/attendance-groups\/([A-Za-z0-9_-]{32})/.exec(soweto.text)![1];
    assert.deepEqual((await cron()).body.sent, 0, "a second run sends nothing");
  });

  await t("the owner's spreadsheet: a tab per group in their order, then Not given; full names, handles and emails", async () => {
    // A pick no longer on the list (the owner renamed or removed it) counts as not given, not a tab of its own.
    await AG.setChoice("ev_sa", "user_dee", "Cape Town");
    const res = await download(ownerToken);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    assert.match(res.headers.get("content-disposition") ?? "", /SA%20Prayer%20Meeting%20\d{4}-\d\d-\d\d%20-%20by%20group\.xlsx/);
    const s = await sheets(res);
    assert.deepEqual(Object.keys(s), ["Summary", "Soweto", "Pretoria", "Durban", "Not given"]);
    assert.deepEqual(s.Soweto[0], ["Full name", "KingsChat / username", "Email", "First joined (UTC)", "Last left (UTC)", "Time in the meeting", "Times joined"]);
    assert.deepEqual(s.Soweto.slice(1).map((r) => [r[0], r[2]]), [["Ann Mokoena", "ann@example.com"], ["Ben Dlamini", "ben@example.com"]]);
    assert.deepEqual(s.Pretoria.slice(1).map((r) => r[0]), ["Cy van Wyk"]);
    assert.equal(s.Durban.length, 1, "nobody picked Durban: just the header");
    assert.deepEqual(s["Not given"].slice(1).map((r) => r[0]), ["Dee Naidoo"]);
    assert.equal(s.Soweto[1][6], "1", "yesterday's join is not in this session");
  });

  await t("a leader's spreadsheet: their group only, no email addresses; a bad or unknown link is refused", async () => {
    const s = await sheets(await download(leaderLink));
    assert.deepEqual(Object.keys(s), ["Summary", "Soweto"]);
    assert.equal(s.Soweto[0].includes("Email"), false);
    assert.equal(JSON.stringify(s).includes("@example.com"), false, "no email address anywhere in a leader's file");
    assert.deepEqual(s.Soweto.slice(1).map((r) => r[0]), ["Ann Mokoena", "Ben Dlamini"]);
    assert.equal((await download("x".repeat(32))).status, 404);
    assert.equal((await download("short")).status, 404);
  });

  await t("the owner's panel lists the session with its download, and who was reached", async () => {
    as("user_owner");
    const r = await json(await R.panel.GET(new Request("https://neolinguameet.com/api/events/ev_sa/attendance-groups"), { params: Promise.resolve({ id: "ev_sa" }) }));
    assert.equal(r.status, 200);
    assert.equal(r.body.allowed, true);
    const sends = r.body.sends as Array<{ attended: number; download: string; leaders: Array<{ group: string; kc: boolean; email: boolean }> }>;
    assert.equal(sends.length, 1);
    assert.equal(sends[0].attended, 4);
    assert.match(sends[0].download, new RegExp(`/api/attendance-groups/${ownerToken}$`));
    assert.deepEqual(sends[0].leaders, [{ group: "Soweto", kc: false, email: true }, { group: "Pretoria", kc: false, email: true }]);
    const reach = r.body.reach as Array<{ group: string; kcHandleKnown: boolean | null }>;
    assert.equal(reach.find((x) => x.group === "Pretoria")?.kcHandleKnown, false);
    as("user_ann");
    assert.equal((await R.panel.GET(new Request("https://neolinguameet.com/api/events/ev_sa/attendance-groups"), { params: Promise.resolve({ id: "ev_sa" }) })).status, 403);
  });

  await t("signed out, a leader's link gets through the middleware (they may have no account); the owner's panel does not", async () => {
    const middleware = (await import("../../middleware")).default as unknown as (req: InstanceType<typeof NextRequest>, ev: unknown) => Promise<Response | undefined>;
    as(undefined);
    const blocked = async (path: string) => {
      try {
        const res = await middleware(new NextRequest(`https://neolinguameet.com${path}`, { headers: { host: "neolinguameet.com" } }), { waitUntil() {} });
        const st = res?.status ?? 200;
        return st >= 300 && st < 500 && st !== 200;
      } catch {
        return true;
      }
    };
    assert.equal(await blocked(`/api/attendance-groups/${leaderLink}`), false);
    assert.equal(await blocked("/api/events/ev_sa/attendance-groups"), true);
  });

  console.log("ended by a host");

  await t("the end route queues the session it ends, which is sent like the other", async () => {
    sent.length = 0;
    const start = Date.now() - 20 * 60_000;
    await eventStore.update("ev_sa", (prev) => ({ ...prev, state: "live", startedAt: new Date(start).toISOString() }));
    await webhook({ event: "room_started", room: { name: "sa" }, createdAt: String(Math.floor(start / 1000)) });
    await webhook({ event: "participant_joined", room: { name: "sa" }, participant: person("user_ann#p", "ann_kc"), createdAt: String(Math.floor(start / 1000) + 60) });
    as("user_owner");
    const end = await R.end.POST(new NextRequest("https://neolinguameet.com/api/events/ev_sa/end", { method: "POST" }), { params: Promise.resolve({ id: "ev_sa" }) });
    assert.equal(end.status, 200);
    assert.deepEqual(await AG.sendDue(Date.now() + 6 * 60_000), { sent: 1, skipped: 0 });
    assert.match(sent.find((s) => s.to === "soweto.lead@example.com")!.text, /1 of your people attended/);
  });

  await t("one session queued twice (the end route and LiveKit's room_finished) is sent once", async () => {
    sent.length = 0;
    const start = Date.now() - 40 * 60_000;
    const ev = { id: "ev_sa", attendanceGroups: (await eventStore.byId("ev_sa"))!.attendanceGroups, startedAt: new Date(start).toISOString() };
    await AG.markSessionStart("ev_sa", start);
    assert.equal(await AG.queueSession(ev, start + 20 * 60_000), true);
    assert.equal(await AG.queueSession(ev, start + 21 * 60_000), true);
    assert.deepEqual(await AG.sendDue(Date.now()), { sent: 1, skipped: 1 });
    assert.equal(sent.filter((x) => x.to === "region@example.com").length, 1);
  });

  await t("a meeting used again on the same link: the next session runs from its own room start, and is sent too", async () => {
    sent.length = 0;
    // As /saregionalmeeting: first started weeks ago, ended by its host after every session.
    await eventStore.update("ev_sa", (prev) => ({ ...prev, state: "ended", endedBy: "host", startedAt: new Date(Date.now() - 20 * 86_400_000).toISOString() }));
    const start = Math.floor(Date.now() / 1000) - 15 * 60;
    await webhook({ event: "room_started", room: { name: "sa" }, createdAt: String(start) });
    await webhook({ event: "participant_joined", room: { name: "sa" }, participant: person("user_cy#n", "cy_kc"), createdAt: String(start + 60) });
    as("user_owner");
    assert.equal((await R.end.POST(new NextRequest("https://neolinguameet.com/api/events/ev_sa/end", { method: "POST" }), { params: Promise.resolve({ id: "ev_sa" }) })).status, 200);
    assert.deepEqual(await AG.sendDue(Date.now() + 6 * 60_000), { sent: 1, skipped: 0 }, "not taken for an earlier session already sent");
    const owner = sent.find((s) => s.to === "region@example.com")!;
    assert.match(owner.text, /^1 attended on /, "only this session's people, not everyone since the first start");
    assert.match(sent.find((s) => s.to === "pta@example.com")!.text, /1 of your people attended/);
    assert.match(sent.find((s) => s.to === "soweto.lead@example.com")!.text, /\n0 of your people attended/, "nobody from Soweto came this time");
  });

  await t("an always-open room never ends, so its session goes out when the room empties", async () => {
    sent.length = 0;
    await eventStore.create({
      id: "ev_perm", slug: "perm", name: "Always open", ownerUserId: "user_owner", ownerEmail: "user_owner@example.com",
      state: "live", visibility: "unlisted", livekitRoom: "perm", waitingRoomEnabled: false, waitForHost: false, isPermanent: true,
      startedAt: new Date(Date.now() - 60 * 86_400_000).toISOString(), createdAt: now, updatedAt: now, roles: [],
    } as unknown as Parameters<typeof eventStore.create>[0]);
    assert.equal((await patch("user_owner", "ev_perm", { attendanceGroups: { groups: [{ name: "Soweto", leader: { email: "soweto.lead@example.com" } }] } })).status, 200);
    await namePost("user_ann", { fullName: "Ann Mokoena", event: "perm", group: "Soweto" });
    const start = Math.floor(Date.now() / 1000) - 12 * 60;
    await webhook({ event: "room_started", room: { name: "perm" }, createdAt: String(start) });
    await webhook({ event: "participant_joined", room: { name: "perm" }, participant: person("user_ann#q", "ann_kc"), createdAt: String(start + 30) });
    await webhook({ event: "participant_left", room: { name: "perm" }, participant: person("user_ann#q", "ann_kc"), createdAt: String(start + 300) });
    const fin = await webhook({ event: "room_finished", room: { name: "perm" }, createdAt: String(start + 320) });
    assert.equal(fin.body.reason, "permanent_room", "still not ended");
    assert.equal((await eventStore.byId("ev_perm"))!.state, "live");
    assert.deepEqual(await AG.sendDue(Date.now() + 6 * 60_000), { sent: 1, skipped: 0 });
    assert.match(sent.find((s) => s.to === "soweto.lead@example.com")!.text, /1 of your people attended/);
  });

  await t("with no room start known, a session is never taken to have run more than a day", async () => {
    const end = Date.now();
    assert.equal(await AG.sessionStart({ id: "ev_unmarked", startedAt: new Date(end - 30 * 86_400_000).toISOString() }, end), end - AG.MAX_SESSION_MS);
    assert.equal(await AG.sessionStart({ id: "ev_unmarked", startedAt: new Date(end - 3_600_000).toISOString() }, end), end - 3_600_000);
  });

  await t("a meeting with no list is never queued", async () => {
    assert.equal(await AG.queueSession({ id: "ev_free", attendanceGroups: undefined, startedAt: new Date(Date.now() - 60_000).toISOString() }, Date.now()), false);
  });

  finished = true;
  console.log(`\n${n} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
