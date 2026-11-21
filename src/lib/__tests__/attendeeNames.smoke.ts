// Run: npx tsx src/lib/__tests__/attendeeNames.smoke.ts
//
// Full names for KingsChat attendees (src/lib/attendeeName.ts,
// src/lib/attendeeNames.ts). Administrators saw only usernames and emails:
// KingsChat gives one `name`, sign-in looked for first and last names only,
// so KingsChat accounts had none. Through the real KingsChat sign-in, the
// /api/me/full-name, /api/livekit/token, attendance export and report
// routes, with Clerk, KV and LiveKit stood in for (./apiV1-stubs).

import assert from "node:assert/strict";
import "./apiV1-stubs/install";
import ExcelJS from "exceljs";

process.env.CLERK_SECRET_KEY = "sk_test_attendee_names";
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
};
const g = globalThis as typeof globalThis & { __users: Record<string, StubUser>; __who?: string };
g.__users = {
  user_owner: { plan: "pro", emails: ["owner@example.com"], first: "Olu", last: "Owner" },
  user_stranger: { emails: ["stranger@example.com"] },
  // Email sign-ups: one with a name, one without.
  user_ada: { emails: ["ada@example.com"], first: "Ada", last: "Lovelace", username: "adal" },
  user_plain: { emails: ["plain@example.com"], username: "plainuser" },
};

// KingsChat's profile endpoint, in its real shape: the person under
// profile.user, the email as an object of its own.
const realFetch = globalThis.fetch;
let kcPerson: Record<string, unknown> = {};
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (String(input).includes("kingsch.at/developer/api/profile")) {
    const body = { profile: { user: kcPerson, email: { address: null, name: "Not a person's name" } } };
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
  const N = await import("../attendeeName");
  const { __setNameLookup } = await import("../attendeeNames");
  const { signInWithKcTokens } = await import("../kc-signin");
  const { eventStore } = await import("../eventStore");
  const { recordAttendance, listAttendance, buildAttendanceReport } = await import("../attendance");
  const { getMeetingReport, withAttendeeNames } = await import("../groupReports");
  const { meetingWorkbook } = await import("../groupReportXlsx");
  const R = {
    fullName: await import("../../app/api/me/full-name/route"),
    token: await import("../../app/api/livekit/token/route"),
    attendance: await import("../../app/api/events/[id]/attendance/route"),
    report: await import("../../app/api/events/[id]/report/route"),
  };
  const signIn = (person: Record<string, unknown>) => {
    kcPerson = person;
    return signInWithKcTokens({ accessToken: "kc-token", expiresIn: 3600, saveTokens: false });
  };
  const meName = async (who: string) => {
    g.__who = who;
    const res = await R.fullName.GET();
    return (await res.json()) as { fullName: string; needed: boolean };
  };
  const saveName = async (who: string, fullName: unknown) => {
    g.__who = who;
    const res = await R.fullName.POST(
      new Request("https://www.neoconference.app/api/me/full-name", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fullName }),
      }),
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const roomName = async (who: string) => {
    g.__who = who;
    const res = await R.token.GET(new NextRequest("https://www.neoconference.app/api/livekit/token?room=token-room&event=token-room&nonce=n1"));
    const body = (await res.json()) as { token?: string };
    assert.equal(res.status, 200, JSON.stringify(body));
    return JSON.parse(Buffer.from(body.token!.split(".")[1], "base64url").toString()).name as string;
  };

  // A live meeting anyone signed in may join, for the names the room shows.
  await eventStore.create({
    id: "ev_token", slug: "token-room", name: "Token room", ownerUserId: "user_owner", ownerEmail: "owner@example.com",
    state: "live", visibility: "unlisted", livekitRoom: "token-room", waitingRoomEnabled: false, waitForHost: false,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  } as unknown as Parameters<typeof eventStore.create>[0]);

  console.log("the rules");

  await t("KingsChat's full name, from its real profile shape; separate given and family names joined", () => {
    assert.equal(N.kcProfileName({ profile: { user: { user_id: "1", username: "g", name: "  Grace   Adebayo Okon " } } }), "Grace Adebayo Okon");
    assert.equal(N.kcProfileName({ user: { first_name: "Tolu", last_name: "Bello" } }), "Tolu Bello");
    assert.equal(N.kcProfileName({ firstName: "Tolu", surname: "  " }), "Tolu", "a blank family name is left out");
    assert.equal(N.kcProfileName({ profile: { user: { username: "x", name: "   " }, email: { name: "Mail" } } }), "", "blank is missing; the email's own name is not theirs");
    assert.equal(N.kcProfileName(null), "");
  });

  await t("KingsChat's name first, then the account's own, else none; only KingsChat accounts are asked", () => {
    const kc = (name?: string) => ({ publicMetadata: { kingschat: { id: "9", username: "h", ...(name !== undefined ? { name } : {}) } } });
    assert.equal(N.accountFullName({ ...kc("KC Name"), firstName: "Local", lastName: "Name" }), "KC Name");
    assert.equal(N.accountFullName({ ...kc(" "), firstName: "Local", lastName: "Name" }), "Local Name");
    assert.equal(N.accountFullName({ ...kc(), firstName: " ", lastName: null }), "");
    assert.equal(N.needsFullName(kc()), true);
    assert.equal(N.needsFullName({ ...kc(), firstName: "Sam" }), false);
    assert.equal(N.needsFullName({ firstName: null, lastName: null, publicMetadata: {} }), false, "an email account is never asked");
    assert.deepEqual(N.splitFullName("Mary Jane  Smith"), { firstName: "Mary Jane", lastName: "Smith" });
    assert.deepEqual(N.splitFullName("Cher"), { firstName: "Cher", lastName: "" });
    assert.equal(N.reportName(""), "Name unavailable");
    assert.equal(N.fullNameProblem("   "), "Enter your full name.");
    assert.equal(N.fullNameProblem("12345"), "Enter your name in letters.");
    assert.equal(N.fullNameProblem("Ngozi Eze"), "");
  });

  await t("search finds a person by full name, username or email, ignoring case and spacing", () => {
    const p = { fullName: "Grace Adebayo Okon", username: "gracey", email: "kc-501@kc.neoconference.app" };
    for (const q of ["adebayo", "GRACE  ADEBAYO", "gracey", "kc-501@"]) assert.ok(N.matchesAttendee(p, q), q);
    assert.equal(N.matchesAttendee(p, "tolu"), false);
    assert.ok(N.matchesAttendee(p, "  "), "an empty search keeps everyone");
  });

  console.log("signing in with KingsChat");

  await t("a KingsChat attendee with a profile name: saved on the account, shown in the meeting, never asked", async () => {
    assert.equal((await signIn({ user_id: "501", username: "gracey", name: "Grace  Adebayo Okon" })).ok, true);
    const [id, u] = byKc("501");
    assert.equal(u.first, "Grace Adebayo");
    assert.equal(u.last, "Okon");
    assert.equal((u.metadata?.kingschat as { name?: string }).name, "Grace Adebayo Okon");
    assert.deepEqual(await meName(id), { fullName: "Grace Adebayo Okon", needed: false });
    assert.equal(await roomName(id), "Grace Adebayo Okon");
  });

  let samId = "";
  await t("a KingsChat attendee with no name is asked; a blank answer is refused; the answer is saved once", async () => {
    assert.equal((await signIn({ user_id: "503", username: "sam_kc", name: "   " })).ok, true);
    samId = byKc("503")[0];
    assert.deepEqual(await meName(samId), { fullName: "", needed: true });
    const blank = await saveName(samId, "   ");
    assert.equal(blank.status, 400);
    assert.equal(blank.body.message, "Enter your full name.");
    const saved = await saveName(samId, "  Samuel   Eto ");
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.fullName, "Samuel Eto");
    assert.deepEqual(await meName(samId), { fullName: "Samuel Eto", needed: false });
    assert.equal(await roomName(samId), "Samuel Eto");
  });

  await t("returning: a KingsChat attendee who typed their name is not asked again, and it is kept", async () => {
    assert.equal((await signIn({ user_id: "503", username: "sam_kc" })).ok, true);
    const u = g.__users[samId];
    assert.equal(u.first, "Samuel");
    assert.equal(u.last, "Eto");
    assert.deepEqual(await meName(samId), { fullName: "Samuel Eto", needed: false });
  });

  await t("returning with a name of their own and one from KingsChat: KingsChat's is used, theirs is not overwritten", async () => {
    g.__users.user_pastor = { emails: ["kc-504@kc.neoconference.app"], externalId: "kc:504", first: "Pastor", last: "Ma", username: "pastorma" };
    assert.equal((await signIn({ user_id: "504", username: "pastorma", name: "Mary Adewale" })).ok, true);
    assert.equal(g.__users.user_pastor.first, "Pastor");
    assert.equal(g.__users.user_pastor.last, "Ma");
    assert.equal((await meName("user_pastor")).fullName, "Mary Adewale");
    // KingsChat stops giving a name: theirs is used again.
    assert.equal((await signIn({ user_id: "504", username: "pastorma" })).ok, true);
    assert.equal((g.__users.user_pastor.metadata?.kingschat as { name?: string }).name, undefined);
    assert.equal((await meName("user_pastor")).fullName, "Pastor Ma");
  });

  await t("sign-in without KingsChat is unchanged: never asked, and the meeting shows the same name as before", async () => {
    assert.deepEqual(await meName("user_ada"), { fullName: "Ada Lovelace", needed: false });
    assert.equal(await roomName("user_ada"), "Ada Lovelace");
    assert.deepEqual(await meName("user_plain"), { fullName: "", needed: false });
    assert.equal(await roomName("user_plain"), "plainuser", "no name: the username, as before");
  });

  console.log("attendance reports and exports");

  // A finished meeting. Its records were written before this change: each
  // KingsChat attendee's record carries the handle as their name.
  const now = Date.now();
  const T = now - 2 * 60 * 60_000;
  const graceId = byKc("501")[0];
  const noNameId = (await signIn({ user_id: "505", username: "quiet_kc" }), byKc("505")[0]);
  await eventStore.create({
    id: "ev_names", slug: "names-room", name: "Names meeting", ownerUserId: "user_owner", ownerEmail: "owner@example.com",
    state: "ended", startedAt: new Date(T).toISOString(), endedAt: new Date(T + 60 * 60_000).toISOString(),
    visibility: "unlisted", livekitRoom: "names-room", waitingRoomEnabled: false, waitForHost: false,
    createdAt: new Date(T).toISOString(), updatedAt: new Date(T).toISOString(),
  } as unknown as Parameters<typeof eventStore.create>[0]);
  const rec = (action: "join" | "leave", userId: string, name: string, at: number, email?: string) =>
    recordAttendance("ev_names", { action, userId, name, ...(email ? { email } : {}), source: "webhook", ts: T + at * 60_000 });
  await rec("join", graceId, "gracey", 0, "kc-501@kc.neoconference.app");
  await rec("leave", graceId, "gracey", 20, "kc-501@kc.neoconference.app");
  await rec("join", graceId, "gracey", 25, "kc-501@kc.neoconference.app");
  await rec("leave", graceId, "gracey", 55, "kc-501@kc.neoconference.app");
  await rec("join", samId, "sam_kc", 2);
  await rec("leave", samId, "sam_kc", 40);
  await rec("join", noNameId, "quiet_kc", 3);
  await rec("leave", noNameId, "quiet_kc", 30);
  // An account that no longer exists, and a partner page's visitor (no account).
  await rec("join", "user_gone", "Old Name", 4, "gone@example.com");
  await rec("leave", "user_gone", "Old Name", 10, "gone@example.com");
  await rec("join", "pz-visitor-1", "Visitor Vee", 5);
  await rec("leave", "pz-visitor-1", "Visitor Vee", 15);
  await rec("join", "user_ada", "Ada Lovelace", 6, "ada@example.com");
  await rec("leave", "user_ada", "Ada Lovelace", 50, "ada@example.com");
  const raw = buildAttendanceReport((await eventStore.byId("ev_names"))!, await listAttendance("ev_names"));

  async function exportFor(who: string) {
    g.__who = who;
    const res = await R.attendance.GET(new NextRequest("https://www.neoconference.app/api/events/ev_names/attendance"), {
      params: Promise.resolve({ id: "ev_names" }),
    });
    return res;
  }

  await t("the spreadsheet: Full Name first, by the rules, blank where there is none; counts and times as before", async () => {
    __setNameLookup(null);
    const res = await exportFor("user_owner");
    assert.equal(res.status, 200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as unknown as ArrayBuffer);
    const sheet = wb.getWorksheet("Attendance")!;
    const header = (sheet.getRow(1).values as unknown[]).slice(1, 4);
    assert.deepEqual(header, ["Full Name", "Username", "Email"]);
    const rows = new Map<string, Record<string, unknown>>();
    const keys = (sheet.getRow(1).values as string[]).slice(1);
    sheet.eachRow((row, i) => {
      if (i === 1) return;
      const v = (row.values as unknown[]).slice(1);
      const o = Object.fromEntries(keys.map((k, j) => [k, v[j] ?? ""]));
      rows.set(String(o["Username"]), o);
    });
    assert.equal(rows.get(graceId)!["Full Name"], "Grace Adebayo Okon", "the handle in the old record gives way to the name");
    assert.equal(rows.get(samId)!["Full Name"], "Samuel Eto", "typed once, found for a meeting before it");
    assert.equal(rows.get(noNameId)!["Full Name"], "", "a KingsChat account with no name: blank");
    assert.equal(rows.get("user_gone")!["Full Name"], "", "no account to link it to: blank, not the old record's name");
    assert.equal(rows.get("pz-visitor-1")!["Full Name"], "Visitor Vee", "no account: the name they came in with");
    assert.equal(rows.get("user_ada")!["Full Name"], "Ada Lovelace");
    assert.equal(rows.get(graceId)!["Email"], "kc-501@kc.neoconference.app");
    // Nothing else moved.
    assert.equal(rows.size, raw.length);
    for (const r of raw) {
      const x = rows.get(r.username)!;
      assert.equal(x["Number of Entries"], r.numberOfEntries, r.username);
      assert.equal(x["Joined Time"], r.joinedTime, r.username);
      assert.equal(x["Left Time"], r.leftTime, r.username);
      assert.equal(x["Attendance Duration"], r.attendanceDuration, r.username);
    }
    assert.equal(rows.get(graceId)!["Number of Entries"], 2);
    const sessions = wb.getWorksheet("Sessions")!;
    const names: string[] = [];
    sessions.eachRow((row, i) => { if (i > 1) names.push(String((row.values as unknown[])[1] ?? "")); });
    assert.equal(names.filter((x) => x === "Grace Adebayo Okon").length, 2, "each of Grace's sessions");
  });

  await t("the spreadsheet is for the meeting's hosts, as before", async () => {
    const res = await exportFor("user_stranger");
    assert.equal(res.status, 403);
  });

  async function report(who: string, q?: string) {
    g.__who = who;
    const res = await R.report.GET(
      new NextRequest(`https://www.neoconference.app/api/events/ev_names/report${q !== undefined ? `?q=${encodeURIComponent(q)}` : ""}`),
      { params: Promise.resolve({ id: "ev_names" }) },
    );
    return { status: res.status, body: (await res.json()) as { report: { participants: Array<{ userId?: string; fullName?: string; username?: string; email: string }> } } };
  }

  await t("the report on screen: full names and usernames; none where there is none", async () => {
    const r = await report("user_owner");
    assert.equal(r.status, 200);
    const by = new Map(r.body.report.participants.map((p) => [p.userId ?? p.email, p]));
    assert.equal(by.get(graceId)!.fullName, "Grace Adebayo Okon");
    assert.equal(by.get(graceId)!.username, "gracey");
    assert.equal(by.get(noNameId)!.fullName, "");
    assert.equal(by.get("user_gone")!.fullName, "");
    assert.equal(N.reportName(by.get("user_gone")!.fullName), "Name unavailable");
    assert.equal((await report("user_stranger")).status, 403, "the same people may see it");
  });

  await t("searching the report on the server: by full name, username or email", async () => {
    const ids = async (q: string) => (await report("user_owner", q)).body.report.participants.map((p) => p.userId ?? p.email);
    assert.deepEqual(await ids("adebayo"), [graceId]);
    assert.deepEqual(await ids("SAMUEL eto"), [samId]);
    assert.deepEqual(await ids("quiet_kc"), [noNameId]);
    assert.deepEqual(await ids("gone@example"), ["user_gone"]);
    assert.deepEqual(await ids("nobody at all"), []);
  });

  await t("a name added after the report was saved reaches it: names are looked up when it is read", async () => {
    const cached = await getMeetingReport("ev_names");
    assert.ok(cached);
    assert.equal(cached!.participants.find((p) => p.userId === noNameId)!.fullName, undefined, "the saved report holds no names");
    assert.equal((await saveName(noNameId, "Quiet Person")).status, 200);
    __setNameLookup(null); // forget names read a moment ago
    const named = await withAttendeeNames((await getMeetingReport("ev_names"))!);
    assert.equal(named.participants.find((p) => p.userId === noNameId)!.fullName, "Quiet Person");
  });

  await t("the group report's spreadsheet uses the same names", async () => {
    const named = await withAttendeeNames((await getMeetingReport("ev_names"))!);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await meetingWorkbook(named)) as ArrayBuffer);
    const sheet = wb.getWorksheet("Attendance")!;
    const keys = (sheet.getRow(1).values as string[]).slice(1);
    const full = new Map<string, string>();
    sheet.eachRow((row, i) => {
      if (i === 1) return;
      const v = (row.values as unknown[]).slice(1);
      const o = Object.fromEntries(keys.map((k, j) => [k, v[j] ?? ""]));
      full.set(String(o["Username"]), String(o["Full Name"]));
    });
    assert.equal(full.get(graceId), "Grace Adebayo Okon");
    assert.equal(full.get("user_gone"), "");
    assert.equal(full.get("pz-visitor-1"), "Visitor Vee");
  });

  await t("a lookup that fails leaves names out rather than failing the export", async () => {
    __setNameLookup(async () => {
      throw new Error("clerk down (test)");
    });
    const res = await exportFor("user_owner");
    assert.equal(res.status, 200);
    __setNameLookup(null);
  });

  await t("the meeting page asks before it joins: no token, so no attendance, until the name is saved", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const page = readFileSync(path.resolve(__dirname, "../../app/room/[name]/page.tsx"), "utf8");
    assert.match(page, /const nameNeeded = Boolean\(isLoaded && isSignedIn && user && !nameSaved && needsFullName\(user\)\);/);
    assert.match(page, /if \(!isLoaded \|\| !isSignedIn \|\| !choices \|\| nameNeeded\) return;\s+let cancelled = false;\s+\(async \(\) => \{\s+try \{\s+const res = await fetch\(\s+`\/api\/livekit\/token/, "the token fetch waits");
    assert.match(page, /if \(!directJoin \|\| !isLoaded \|\| !isSignedIn \|\| choices \|\| nameNeeded\) return;/, "a direct join waits too");
    assert.ok(page.indexOf("if (nameNeeded) {") < page.indexOf("if (!choices) {"), "the prompt comes before the join screen");
  });

  finished = true;
  console.log(`attendeeNames: ${n} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
