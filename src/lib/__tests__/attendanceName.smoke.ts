// Run: npx tsx src/lib/__tests__/attendanceName.smoke.ts
//
// The "Full name for attendance" (src/lib/attendeeName.ts,
// src/lib/attendanceName.ts): asked of everyone before joining, saved on
// their account for next time, recorded on the attendance entry of each
// meeting they join, and shown as the first column of the attendance report
// and its exports — never in the meeting itself. Through the real KingsChat
// sign-in, /api/me/full-name, /api/livekit/token, the LiveKit webhook (signed
// as LiveKit signs it), the room's attendance beacon, the attendance export
// and the report routes, with Clerk, KV and LiveKit stood in for
// (./apiV1-stubs). The KingsChat account at the centre gives only a username
// and an email address, as most do.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import "./apiV1-stubs/install";
import ExcelJS from "exceljs";

process.env.CLERK_SECRET_KEY = "sk_test_attendance_name";
process.env.PLATFORM_OWNER_EMAILS = "platform@example.com";
process.env.ADMIN_EMAILS = "";
process.env.KV_REST_API_URL = "https://kv.invalid";
process.env.KV_REST_API_TOKEN = "stub";
process.env.NEXT_PUBLIC_LIVEKIT_URL = "wss://lk.test";
process.env.LIVEKIT_API_KEY = "lk_key";
process.env.LIVEKIT_API_SECRET = "lk_secret_that_is_long_enough_for_hs256";

type StubUser = {
  emails?: string[];
  plan?: string;
  first?: string | null;
  last?: string | null;
  username?: string;
  externalId?: string;
  metadata?: Record<string, unknown>;
  privateMetadata?: Record<string, unknown>;
};
const g = globalThis as typeof globalThis & { __users: Record<string, StubUser>; __who?: string };
g.__users = {
  user_owner: { plan: "pro", emails: ["owner@example.com"], first: "Olu", last: "Owner" },
  user_stranger: { emails: ["stranger@example.com"] },
  // Email sign-ups: one with a name of their own; one whose "first name" is its username.
  user_ada: { emails: ["ada@example.com"], first: "Ada", last: "Lovelace", username: "adal" },
  user_handle: { emails: ["h@example.com"], first: "handle99", username: "handle99" },
};

// A clock the test can move: confirmations last 12 hours.
const realNow = Date.now.bind(Date);
let skew = 0;
Date.now = () => realNow() + skew;
const HOUR = 60 * 60_000;

// KingsChat's profile endpoint, in its real shape: the person under
// profile.user, the email as an object of its own.
const realFetch = globalThis.fetch;
let kcPerson: Record<string, unknown> = {};
let kcEmail: string | null = null;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (String(input).includes("kingsch.at/developer/api/profile")) {
    const body = { profile: { user: kcPerson, email: { address: kcEmail, name: "Not a person's name" } } };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }
  return realFetch(input, init);
}) as typeof fetch;

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

const byKc = (kcId: string) => Object.entries(g.__users).find(([, u]) => u.externalId === "kc:" + kcId)!;

async function main() {
  const { NextRequest } = await import("next/server");
  const { AccessToken } = await import("livekit-server-sdk");
  const N = await import("../attendeeName");
  const { __setNameLookup } = await import("../attendeeNames");
  const { signInWithKcTokens } = await import("../kc-signin");
  const { eventStore } = await import("../eventStore");
  const { recordAttendance } = await import("../attendance");
  const { withAttendeeNames } = await import("../groupReports");
  const R = {
    fullName: await import("../../app/api/me/full-name/route"),
    token: await import("../../app/api/livekit/token/route"),
    webhook: await import("../../app/api/livekit/webhook/route"),
    beacon: await import("../../app/api/attendance/beacon/route"),
    attendance: await import("../../app/api/events/[id]/attendance/route"),
    report: await import("../../app/api/events/[id]/report/route"),
  };
  __setNameLookup(null);

  const signIn = (person: Record<string, unknown>, email: string | null = null) => {
    kcPerson = person;
    kcEmail = email;
    return signInWithKcTokens({ accessToken: "kc-token", expiresIn: 3600, saveTokens: false });
  };
  const prefill = async (who: string) => {
    g.__who = who;
    return (await (await R.fullName.GET()).json()) as { fullName: string; saved: boolean };
  };
  const confirm = async (who: string, fullName: unknown) => {
    g.__who = who;
    const res = await R.fullName.POST(
      new Request("https://www.neolinguameet.com/api/me/full-name", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fullName }),
      }),
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  /** The web join (no app header), or the app's (Bearer, with or without the attendance step). */
  const token = async (who: string, room: string, opts: { app?: "old" | "new"; nonce?: string } = {}) => {
    g.__who = who;
    const q = new URLSearchParams({ room, event: room, nonce: opts.nonce ?? "n1" });
    if (opts.app) q.set("client", "android 1.2.14+5226 Pixel 8 / Android 15");
    if (opts.app === "new") q.set("attendance", "1");
    const res = await R.token.GET(
      new NextRequest(`https://www.neolinguameet.com/api/livekit/token?${q}`, {
        headers: opts.app ? { authorization: "Bearer app-session-jwt" } : {},
      }),
    );
    const body = (await res.json()) as { token?: string; error?: string; message?: string };
    const claims = body.token ? JSON.parse(Buffer.from(body.token.split(".")[1], "base64url").toString()) : null;
    return { status: res.status, body, name: claims?.name as string | undefined, identity: claims?.sub as string | undefined };
  };
  /** LiveKit tells the app someone joined or left (signed as LiveKit signs it). */
  const lk = async (event: "participant_joined" | "participant_left", room: string, identity: string, name: string) => {
    const body = JSON.stringify({ event, room: { name: room }, participant: { sid: `PA_${identity}`, identity, name }, createdAt: String(Math.floor(Date.now() / 1000)) });
    const tok = new AccessToken(process.env.LIVEKIT_API_KEY!, process.env.LIVEKIT_API_SECRET!);
    tok.sha256 = createHash("sha256").update(body).digest("base64");
    const res = await R.webhook.POST(new Request("https://www.neolinguameet.com/api/livekit/webhook", { method: "POST", headers: { authorization: await tok.toJwt(), "content-type": "application/webhook+json" }, body }));
    assert.equal(res.status, 200, await res.clone().text());
  };
  const beacon = async (who: string, slug: string, action: "join" | "leave") => {
    g.__who = who;
    const res = await R.beacon.POST(new Request("https://www.neolinguameet.com/api/attendance/beacon", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug, action }) }));
    assert.equal(res.status, 200);
  };
  const meeting = async (id: string, slug: string, state: "live" | "ended" = "live") =>
    eventStore.create({
      id, slug, name: `Meeting ${slug}`, ownerUserId: "user_owner", ownerEmail: "owner@example.com",
      state, startedAt: new Date(Date.now() - HOUR).toISOString(), ...(state === "ended" ? { endedAt: new Date().toISOString() } : {}),
      visibility: "unlisted", livekitRoom: slug, waitingRoomEnabled: false, waitForHost: false,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    } as unknown as Parameters<typeof eventStore.create>[0]);
  const report = async (who: string, id: string) => {
    g.__who = who;
    const res = await R.report.GET(new NextRequest(`https://www.neolinguameet.com/api/events/${id}/report`), { params: Promise.resolve({ id }) });
    return { status: res.status, body: (await res.json()) as { report: { participants: Array<{ userId?: string; name: string; fullName?: string; username?: string; email: string; entries: number; status: string }> } } };
  };
  const exportRows = async (id: string) => {
    g.__who = "user_owner";
    const res = await R.attendance.GET(new NextRequest(`https://www.neolinguameet.com/api/events/${id}/attendance`), { params: Promise.resolve({ id }) });
    assert.equal(res.status, 200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as unknown as ArrayBuffer);
    const read = (name: string) => {
      const sheet = wb.getWorksheet(name)!;
      const keys = (sheet.getRow(1).values as string[]).slice(1);
      const out: Record<string, unknown>[] = [];
      sheet.eachRow((row, i) => {
        if (i > 1) out.push(Object.fromEntries(keys.map((k, j) => [k, (row.values as unknown[]).slice(1)[j] ?? ""])));
      });
      return { keys, rows: out };
    };
    return { attendance: read("Attendance"), sessions: read("Sessions") };
  };

  console.log("the rules");

  await t("accents, apostrophes, hyphens and single words are names; blanks, emails, digits and single letters are not", () => {
    for (const ok of ["Ngozi Eze", "Chiamaka Ọkọnkwọ", "Tunde O'Brien", "Tunde O’Brien", "Anne-Marie Dubois", "Adaeze", "José Núñez", "Dr. Ada Obi"]) {
      assert.equal(N.attendanceNameProblem(ok), "", ok);
    }
    assert.equal(N.attendanceNameProblem(""), "Enter your full name for attendance");
    assert.equal(N.attendanceNameProblem("    "), "Enter your full name for attendance");
    assert.equal(N.attendanceNameProblem("A"), "Enter your full name for attendance");
    assert.equal(N.attendanceNameProblem("grace@example.com"), "Enter your name, not an email address.");
    assert.notEqual(N.attendanceNameProblem("Ada 2"), "");
    assert.notEqual(N.attendanceNameProblem("<b>Ada</b>"), "");
    assert.notEqual(N.attendanceNameProblem("x".repeat(101)), "");
    assert.equal(N.cleanFullName("  Grace   Adebayo  "), "Grace Adebayo");
  });

  console.log("a KingsChat account with only a username and an email");

  let grace = "";
  /** The address the account has (KingsChat sign-in gives it one of its own). */
  const emailOf = (id: string) => (g.__users[id].emails ?? [])[0];
  await t("signing in: the field starts blank — never the username or the email — and nothing is saved yet", async () => {
    assert.equal((await signIn({ user_id: "601", username: "grace_kc" }, "grace@kc.example")).ok, true);
    grace = byKc("601")[0];
    assert.ok(emailOf(grace), "the account has an email address");
    assert.deepEqual(await prefill(grace), { fullName: "", saved: false });
  });

  await t("the join is turned back until a name is confirmed: no token, so no attendance", async () => {
    await meeting("ev_a", "room-a");
    const r = await token(grace, "room-a");
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, { error: "attendance_name_required", message: "Enter your full name for attendance" });
  });

  await t("confirming checks the name on the server too, tidies its spaces and saves it on the account, privately", async () => {
    const blank = await confirm(grace, "   ");
    assert.equal(blank.status, 400);
    assert.equal(blank.body.message, "Enter your full name for attendance");
    assert.equal((await confirm(grace, "grace@kc.example")).status, 400);
    assert.equal((await confirm(grace, undefined)).status, 400);
    const ok = await confirm(grace, "  Grace   Adebayo ");
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.fullName, "Grace Adebayo");
    assert.equal(g.__users[grace].privateMetadata?.attendanceName, "Grace Adebayo");
    assert.equal((g.__users[grace].metadata ?? {}).attendanceName, undefined, "not in the public profile");
  });

  await t("then the join goes ahead, and the meeting shows the KingsChat username — not the attendance name", async () => {
    const r = await token(grace, "room-a");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.name, "grace_kc");
    assert.equal(r.identity, `${grace}#n1`);
  });

  await t("join, drop, reconnect from another tab: one attendee with two entries, under the confirmed name", async () => {
    await lk("participant_joined", "room-a", `${grace}#n1`, "grace_kc");
    await lk("participant_left", "room-a", `${grace}#n1`, "grace_kc");
    skew += 5 * 60_000;
    assert.equal((await token(grace, "room-a", { nonce: "n2" })).status, 200);
    await lk("participant_joined", "room-a", `${grace}#n2`, "grace_kc");
    const r = await report("user_owner", "ev_a");
    assert.equal(r.status, 200);
    const mine = r.body.report.participants.filter((p) => p.userId === grace);
    assert.equal(mine.length, 1, "not a duplicate attendee");
    assert.equal(mine[0].fullName, "Grace Adebayo");
    assert.equal(mine[0].username, "grace_kc");
    assert.equal(mine[0].email, emailOf(grace));
    assert.equal(mine[0].name, "grace_kc", "the name shown to others is still the username");
    assert.equal(mine[0].entries, 2);
  });

  await t("the export: Full Name first, beside the KingsChat username and the email; every session too", async () => {
    const x = await exportRows("ev_a");
    assert.deepEqual(x.attendance.keys.slice(0, 3), ["Full Name", "Username", "Email"]);
    const row = x.attendance.rows.find((r) => r["Username"] === "grace_kc")!;
    assert.equal(row["Full Name"], "Grace Adebayo");
    assert.equal(row["Email"], emailOf(grace));
    assert.equal(row["Number of Entries"], 2);
    assert.equal(x.attendance.rows.length, 1);
    assert.deepEqual(x.sessions.rows.map((r) => [r["Full Name"], r["Username"]]), [["Grace Adebayo", "grace_kc"], ["Grace Adebayo", "grace_kc"]]);
  });

  console.log("others in the same meeting");

  await t("two people with the same full name are two attendees", async () => {
    assert.equal((await signIn({ user_id: "602", username: "grace_two" }, "grace2@kc.example")).ok, true);
    const other = byKc("602")[0];
    assert.equal((await confirm(other, "Grace Adebayo")).status, 200);
    assert.equal((await token(other, "room-a")).status, 200);
    await lk("participant_joined", "room-a", `${other}#n1`, "grace_two");
    const r = await report("user_owner", "ev_a");
    const named = r.body.report.participants.filter((p) => p.fullName === "Grace Adebayo");
    assert.deepEqual(named.map((p) => p.username).sort(), ["grace_kc", "grace_two"]);
    const x = await exportRows("ev_a");
    assert.equal(x.attendance.rows.filter((r) => r["Full Name"] === "Grace Adebayo").length, 2);
  });

  await t("on first use: KingsChat's own full name is offered, else the account's own name, never a handle", async () => {
    assert.equal((await signIn({ user_id: "603", username: "mary_kc", name: "Mary  Adewale" })).ok, true);
    assert.deepEqual(await prefill(byKc("603")[0]), { fullName: "Mary Adewale", saved: false });
    assert.deepEqual(await prefill("user_ada"), { fullName: "Ada Lovelace", saved: false });
    assert.deepEqual(await prefill("user_handle"), { fullName: "", saved: false }, "a username saved as a first name is not a name");
    // An email account keeps showing the name it always showed.
    assert.equal((await confirm("user_ada", "Augusta Ada King")).status, 200);
    assert.equal((await token("user_ada", "room-a")).name, "Ada Lovelace");
  });

  await t("the web room's own join record (its beacon) carries the confirmed name too", async () => {
    await meeting("ev_c", "room-c");
    assert.equal((await token("user_ada", "room-c")).status, 200);
    await beacon("user_ada", "room-c", "join");
    const p = (await report("user_owner", "ev_c")).body.report.participants.find((q) => q.userId === "user_ada")!;
    assert.equal(p.fullName, "Augusta Ada King");
    assert.equal(p.name, "Ada Lovelace");
  });

  console.log("returning, and changing the name");

  await t("next time the field starts with the saved name; a change applies from then on and the past stays as it was", async () => {
    assert.deepEqual(await prefill(grace), { fullName: "Grace Adebayo", saved: true });
    assert.equal((await confirm(grace, "Grace Adebayo Okon")).status, 200);
    await meeting("ev_b", "room-b");
    assert.equal((await token(grace, "room-b")).status, 200);
    await lk("participant_joined", "room-b", `${grace}#n1`, "grace_kc");
    const b = (await report("user_owner", "ev_b")).body.report.participants.find((p) => p.userId === grace)!;
    assert.equal(b.fullName, "Grace Adebayo Okon");
    const a = (await report("user_owner", "ev_a")).body.report.participants.find((p) => p.userId === grace)!;
    assert.equal(a.fullName, "Grace Adebayo", "the earlier meeting keeps the name it was attended under");
    assert.deepEqual(await prefill(grace), { fullName: "Grace Adebayo Okon", saved: true });
  });

  await t("a confirmation lasts 12 hours: a join after that asks again", async () => {
    skew += 13 * HOUR;
    assert.equal((await token(grace, "room-b")).body.error, "attendance_name_required");
    assert.equal((await confirm(grace, "Grace Adebayo Okon")).status, 200);
    assert.equal((await token(grace, "room-b")).status, 200);
  });

  console.log("the app");

  await t("an app with the step must confirm too; an older app, which cannot ask, still gets in", async () => {
    assert.equal((await signIn({ user_id: "604", username: "app_user" })).ok, true);
    const appUser = byKc("604")[0];
    const fresh = await token(appUser, "room-b", { app: "new" });
    assert.equal(fresh.status, 400);
    assert.equal(fresh.body.error, "attendance_name_required");
    const old = await token(appUser, "room-b", { app: "old" });
    assert.equal(old.status, 200, JSON.stringify(old.body));
    assert.equal((await confirm(appUser, "Kemi Bello")).status, 200);
    assert.equal((await token(appUser, "room-b", { app: "new" })).status, 200);
  });

  console.log("meetings from before names were captured");

  await t("their records say \"Name not captured\" in the export and on screen, with username and email as before", async () => {
    await meeting("ev_old", "room-old", "ended");
    await recordAttendance("ev_old", { action: "join", userId: grace, name: "grace_kc", email: emailOf(grace), source: "webhook", ts: Date.now() - 50 * 60_000 });
    await recordAttendance("ev_old", { action: "leave", userId: grace, name: "grace_kc", source: "webhook", ts: Date.now() - 20 * 60_000 });
    await recordAttendance("ev_old", { action: "join", userId: "pz-visitor-1", name: "Visitor Vee", source: "webhook", ts: Date.now() - 40 * 60_000 });
    const x = await exportRows("ev_old");
    const kcRow = x.attendance.rows.find((r) => r["Username"] === "grace_kc")!;
    assert.equal(kcRow["Full Name"], N.NAME_NOT_CAPTURED);
    assert.equal(kcRow["Email"], emailOf(grace));
    assert.equal(x.attendance.rows.find((r) => r["Username"] === "pz-visitor-1")!["Full Name"], "Visitor Vee", "no account: the name they typed");
    const r = await report("user_owner", "ev_old");
    const p = r.body.report.participants.find((q) => q.userId === grace)!;
    assert.equal(p.fullName, "", "on screen: \"Name not captured\"");
    assert.equal(p.username, "grace_kc");
  });

  await t("a report saved before this change: its old names are not taken for attendance names", async () => {
    const legacy = {
      eventId: "ev_legacy", slug: "x", title: "Old", group: null, kind: "meeting", state: "ended", hosts: [],
      scheduledStart: null, actualStart: null, actualEnd: null,
      participants: [
        { key: grace, userId: grace, name: "Grace Adebayo Okon", email: "", invited: false, status: "present", declined: false, joinedAt: 1, leftAt: 2, attendedMs: 1, entries: 1, callAttempts: 0, missedCalls: 0,
          row: { fullName: "Grace Adebayo Okon", username: grace, email: "", meetingTitle: "Old", joinedDate: "", joinedTime: "", leftTime: "", timeZone: "UTC", attendanceDuration: "0s", repeatAttendance: false, numberOfEntries: 1, role: "", attendanceStatus: "left", inactivityWarnings: 0, intervals: [] } },
        { key: "name:vee", name: "Visitor Vee", email: "", invited: false, status: "present", declined: false, joinedAt: 1, leftAt: 2, attendedMs: 1, entries: 1, callAttempts: 0, missedCalls: 0,
          row: { fullName: "Visitor Vee", username: "pz-visitor-1", email: "", meetingTitle: "Old", joinedDate: "", joinedTime: "", leftTime: "", timeZone: "UTC", attendanceDuration: "0s", repeatAttendance: false, numberOfEntries: 1, role: "", attendanceStatus: "left", inactivityWarnings: 0, intervals: [] } },
      ],
    } as unknown as Parameters<typeof withAttendeeNames>[0];
    const named = await withAttendeeNames(legacy);
    assert.equal(named.participants[0].fullName, "");
    assert.equal(named.participants[0].username, "grace_kc");
    assert.equal(named.participants[1].fullName, "Visitor Vee");
  });

  console.log("who sees it");

  await t("only the meeting's hosts get the report and the export; a confirmation is only ever the caller's own", async () => {
    assert.equal((await report("user_stranger", "ev_a")).status, 403);
    g.__who = "user_stranger";
    const res = await R.attendance.GET(new NextRequest("https://www.neolinguameet.com/api/events/ev_a/attendance"), { params: Promise.resolve({ id: "ev_a" }) });
    assert.equal(res.status, 403);
    // Confirming writes the caller's account only, whatever the body says.
    g.__who = "user_stranger";
    await R.fullName.POST(new Request("https://www.neolinguameet.com/api/me/full-name", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fullName: "Someone Else", userId: grace }) }));
    assert.equal(g.__users[grace].privateMetadata?.attendanceName, "Grace Adebayo Okon");
    g.__who = undefined;
    assert.equal((await R.fullName.GET()).status, 401);
  });

  finished = true;
  console.log(`attendanceName: ${n} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
