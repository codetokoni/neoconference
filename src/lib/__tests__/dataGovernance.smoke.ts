// Run: npx tsx src/lib/__tests__/dataGovernance.smoke.ts
//
// Admin phase 11 — data governance and recovery — through the real routes,
// with Clerk, KV and R2 stood in for (./apiV1-stubs). KV is "configured",
// so every store runs its real KV code against the in-memory Redis, and
// nothing here can reach production data.
//
// What it proves:
//   - the data map and the erase steps cover each other;
//   - an export holds exactly the person's own data: no one else's, no secrets;
//   - a deletion request moves requested -> scheduled -> completed, can be
//     cancelled in its grace period, and a legal hold refuses it;
//   - completing it deletes or anonymises every place in the data map
//     (checked by sweeping the whole store for the person), removes their R2
//     files, deletes the Clerk user last, and leaves a certificate in the
//     audit trail with counts and no personal data;
//   - the platform owner can never be deleted, by any path;
//   - bulk actions need a preview token: missing, forged, expired, someone
//     else's, for another selection, spent, or without the typed phrase -> refused;
//   - deleted meetings, groups and recordings go to a trash an administrator
//     restores from; conflicts and expired items are refused;
//   - retention changes preview what they affect; purges remove only what is past it;
//   - permissions, step-up and the audit trail.

import assert from "node:assert/strict";
import "./apiV1-stubs/install";

process.env.CLERK_SECRET_KEY = "sk_test_data_gov";
process.env.PLATFORM_OWNER_EMAILS = "owner@example.com";
process.env.ADMIN_EMAILS = "";
delete process.env.RESEND_API_KEY;
delete process.env.LIVEKIT_API_KEY;
delete process.env.LIVEKIT_API_SECRET;
process.env.KV_REST_API_URL = "https://kv.invalid";
process.env.KV_REST_API_TOKEN = "stub";

type StubUser = { plan?: string; emails?: string[]; first?: string; last?: string; banned?: boolean; createdAt?: number; metadata?: Record<string, unknown> };
type Obj = { key: string; size: number; lastModified?: string; body?: Buffer };
type Stubbed = typeof globalThis & {
  __users: Record<string, StubUser>;
  __clerkSessions: Record<string, { id: string; status: string }[]>;
  __who?: string;
  __kvStore: Map<string, unknown>;
  __objects: Obj[];
};
const g = globalThis as Stubbed;
const day = 24 * 60 * 60 * 1000;
g.__users = {
  user_owner: { emails: ["owner@example.com"], first: "Owner" },
  user_super: { emails: ["super@example.com"], first: "Sue" },
  user_support: { emails: ["support@example.com"], first: "Sam" },
  user_analyst: { emails: ["analyst@example.com"], first: "Ana" },
  user_alice: { emails: ["alice@example.com"], first: "Alicia", last: "Zephyr", plan: "pro", metadata: { kingschat: { id: "kc1", username: "aliciakc" } } },
  user_bob: { emails: ["bob@example.com"], first: "Bob", last: "Brown" },
  user_dave: { emails: ["dave@example.com"], first: "Dave" },
  user_pat: { emails: ["pat@example.com"], first: "Pat" },
  user_held: { emails: ["held@example.com"], first: "Hal" },
};
g.__clerkSessions = { user_alice: [{ id: "sess_a1", status: "active" }] };
const iso = (ms: number) => new Date(ms).toISOString();
g.__objects = [
  { key: "recordings/user_alice/alice-weekly/2026-10-01-10-00-00.mp4", size: 5_000_000, lastModified: iso(Date.now() - 3 * day) },
  { key: "recordings/user_alice/alice-weekly/2026-10-01-10-00-00.m4a", size: 900_000, lastModified: iso(Date.now() - 3 * day) },
  { key: "chat/user_alice/u1-notes.pdf", size: 1000, lastModified: iso(Date.now() - day) },
  { key: "recordings/user_bob/bob-standup/2026-09-01-09-00-00.mp4", size: 7_000_000, lastModified: iso(Date.now() - 40 * day) },
];

const realNow = Date.now.bind(Date);
let skew = 0;
Date.now = () => realNow() + skew;
const tick = (ms = 30_000) => {
  skew += ms;
};

let n = 0;
const t = async (name: string, fn: () => Promise<void>) => {
  await fn();
  n++;
  console.log("  ok  " + name);
};

async function main() {
  const mfa = await import("../admin/mfa");
  const audit = await import("../admin/audit");
  const store = await import("../admin/store");
  const users = await import("../admin/users");
  const groups = await import("../groupStore");
  const sessions = await import("../sessionStore");
  const payments = await import("../paymentsStore");
  const meetings = await import("../userMeetings");
  const notif = await import("../notificationStore");
  const push = await import("../pushStore");
  const fcm = await import("../fcmStore");
  const kcTokens = await import("../kc-tokens");
  const groupChat = await import("../groupChat");
  const { activity } = await import("../activity");
  const tickets = await import("../support/tickets");
  const jobs = await import("../ops/jobs");
  const { eventStore } = await import("../eventStore");
  const { kv } = await import("../kv");
  const { DATA_MAP, erasableLocations } = await import("../dataMap");
  const erase = await import("../dataGov/erase");
  const requests = await import("../dataGov/requests");
  const trash = await import("../dataGov/trash");
  const { readZip } = await import("../dataGov/zip");
  const R = {
    enroll: await import("../../app/api/admin/mfa/enroll/route"),
    confirm: await import("../../app/api/admin/mfa/confirm/route"),
    verify: await import("../../app/api/admin/mfa/verify/route"),
    data: await import("../../app/api/admin/data/route"),
    bulk: await import("../../app/api/admin/data/bulk/[action]/[step]/route"),
    req: await import("../../app/api/admin/data/requests/[uid]/route"),
    adminExport: await import("../../app/api/admin/users/[id]/export/route"),
    adminExportJob: await import("../../app/api/admin/data/exports/[exportId]/route"),
    deletion: await import("../../app/api/admin/users/[id]/deletion/route"),
    purge: await import("../../app/api/admin/users/[id]/deletion/purge/route"),
    meExport: await import("../../app/api/me/data/export/route"),
    meDeletion: await import("../../app/api/me/data/deletion/route"),
    eventDelete: await import("../../app/api/events/delete/route"),
    groupRoute: await import("../../app/api/groups/[id]/route"),
    recordings: await import("../../app/api/recordings/route"),
  };

  const jar: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  type Body = Record<string, unknown> & { error?: string; message?: string };
  async function call<P = Record<string, string>>(
    who: string,
    handler: (req: Request, ctx: { params: P }) => Promise<Response>,
    opts: { method?: string; body?: unknown; params?: P; query?: string } = {},
  ) {
    g.__who = who;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (jar[who]) headers.cookie = `neo_admin_mfa=${jar[who]}`;
    const res = await handler(
      new Request(`https://www.neoconference.app/api/x${opts.query ?? ""}`, {
        method: opts.method ?? "GET",
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      }),
      { params: (opts.params ?? {}) as P },
    );
    const m = res.headers.get("set-cookie")?.match(/neo_admin_mfa=([^;]*)/);
    if (m) jar[who] = decodeURIComponent(m[1]);
    const body = (await res.json().catch(() => ({}))) as Body;
    return { status: res.status, body };
  }
  const code = (who: string) => mfa.totpAt(mfa.base32Decode(secrets[who]), mfa.currentStep());
  async function enrollAndVerify(who: string) {
    const e = await call(who, R.enroll.POST, { method: "POST" });
    assert.equal(e.status, 200, JSON.stringify(e.body));
    secrets[who] = e.body.secret as string;
    tick();
    assert.equal((await call(who, R.confirm.POST, { method: "POST", body: { code: code(who) } })).status, 200);
  }
  async function stepUp(who: string) {
    tick();
    const v = await call(who, R.verify.POST, { method: "POST", body: { code: code(who) } });
    assert.equal(v.status, 200, JSON.stringify(v.body));
  }
  const bulk = (who: string, action: string, step: "preview" | "apply", body: unknown) =>
    call(who, R.bulk.POST as never, { method: "POST", params: { action, step }, body }) as Promise<{ status: number; body: Body }>;
  const lastAudit = async (action: string) => (await audit.listAdminAudit({ action })).items[0];
  /** Every KV key and value, as text, for "is this person still anywhere?" sweeps. */
  const kvText = (skip: (k: string) => boolean) =>
    [...g.__kvStore.entries()]
      .filter(([k]) => !skip(k))
      .map(([k, v]) => `${k} => ${v instanceof Set ? JSON.stringify([...v]) : v instanceof Map ? JSON.stringify([...v.entries()]) : typeof v === "string" ? v : JSON.stringify(v)}`);

  const now0 = Date.now();
  const appoint = (userId: string, email: string, roleId: string) =>
    store.saveMember({ userId, email, name: email, roleId, status: "active", appointedBy: "user_owner", appointedAt: now0, updatedAt: now0 });
  await appoint("user_super", "super@example.com", "super_admin");
  await appoint("user_support", "support@example.com", "support");
  await appoint("user_analyst", "analyst@example.com", "analyst");
  for (const who of ["user_owner", "user_super", "user_support", "user_analyst"]) await enrollAndVerify(who);

  /* ------------------------------- the world ------------------------------- */
  const ev = (id: string, slug: string, owner: string, extra: Record<string, unknown> = {}) =>
    eventStore.create({
      id,
      slug,
      name: slug,
      ownerUserId: owner,
      visibility: "public",
      createdAt: iso(Date.now() - 2 * day),
      updatedAt: iso(Date.now()),
      waitingRoomEnabled: true,
      livekitRoom: slug,
      qrSeed: "x",
      roles: [],
      ...extra,
    } as unknown as Parameters<typeof eventStore.create>[0]);
  // Alice owns one meeting; Bob owns one Alice is in.
  await ev("ev_alice", "alice-weekly", "user_alice", {
    ownerEmail: "alice@example.com",
    ownerName: "Alicia Zephyr",
    roles: [{ identifier: "bob@example.com", role: "cohost", label: "Bob Brown" }],
    waitingRoom: [{ id: "user_bob", name: "Bob Brown", email: "bob@example.com", requestedAt: 1, status: "admitted" }],
  });
  await ev("ev_bob", "bob-standup", "user_bob", {
    ownerEmail: "bob@example.com",
    roles: [
      { identifier: "user_alice", role: "cohost", label: "Alicia" },
      { identifier: "dave@example.com", role: "attendee" },
    ],
    waitingRoom: [{ id: "user_alice", name: "Alicia Zephyr", email: "alice@example.com", requestedAt: 1, status: "admitted" }],
    recentRedemptions: [{ token: "t", identifier: "alice@example.com", role: "attendee", ts: 1 }],
  });
  const chatMsg = (id: string, userId: string, name: string, text: string, extra: Record<string, unknown> = {}) => ({ id, userId, name, text, ts: iso(Date.now()), ...extra });
  await kv.set("neo:chat:ev_alice", [chatMsg("c1", "user_alice", "Alicia", "ALICE-OWN-ROOM"), chatMsg("c2", "user_bob", "Bob Brown", "BOB-SECRET-IN-ALICE-ROOM")]);
  await kv.set("neo:chat:ev_bob", [
    chatMsg("c3", "user_alice", "Alicia", "ALICE-IN-BOB-ROOM", { attachments: [{ url: "https://signed/chat/user_alice/u1-notes.pdf", name: "notes.pdf" }] }),
    chatMsg("c4", "user_bob", "Bob Brown", "BOB-REPLY", { replyTo: { id: "c3", name: "Alicia", snippet: "x" } }),
  ]);
  const att = (userId: string, name: string, email: string, action: string) => JSON.stringify({ ts: Date.now(), action, userId, name, email, role: "attendee", source: "webhook" });
  await kv.lpush("neo:attendance:ev_bob:events", att("user_alice", "Alicia", "alice@example.com", "join"), att("user_bob", "Bob Brown", "bob@example.com", "join"));
  await kv.lpush("neo:attendance:ev_alice:events", att("user_bob", "Bob Brown", "bob@example.com", "join"));
  await kv.set("neo:report:ev_bob", {
    eventId: "ev_bob",
    hosts: ["Bob Brown", "Alicia"],
    participants: [
      { key: "user_alice", userId: "user_alice", name: "Alicia", email: "alice@example.com", status: "present" },
      { key: "user_bob", userId: "user_bob", name: "Bob Brown", email: "bob@example.com", status: "present" },
    ],
    summary: { firstToJoin: "Alicia" },
  });
  await kv.hset("neo:meeting:ev_bob:roles", { user_alice: JSON.stringify({ role: "cohost" }), "bob@example.com": JSON.stringify({ role: "host" }) });
  await kv.hset("neo:event:ev_bob:calls", { user_alice: JSON.stringify({ status: "answered" }), user_dave: JSON.stringify({ status: "missed" }) });
  await kv.hset("neo:event:ev_bob:invited", { "alice@example.com": JSON.stringify({ name: "Alicia", email: "alice@example.com" }) });
  await kv.hset("neo:owner:user_bob:recurring", { user_alice: JSON.stringify({ role: "cohost" }), user_dave: JSON.stringify({ role: "cohost" }) });
  await meetings.addUserMeeting("user_alice", "ev_bob", Date.now() - day);

  // Groups: Bob's book club (Alice a member), Alice's solo group, and a shared one Alice owns.
  const club = await groups.createGroup({ name: "Book club" }, { userId: "user_bob", name: "Bob Brown", email: "bob@example.com" }, [
    { userId: "user_alice", name: "Alicia Zephyr", email: "alice@example.com" },
  ]);
  const solo = await groups.createGroup({ name: "Solo notes" }, { userId: "user_alice", name: "Alicia Zephyr", email: "alice@example.com" });
  const shared = await groups.createGroup({ name: "Shared space" }, { userId: "user_alice", name: "Alicia Zephyr", email: "alice@example.com" }, [
    { userId: "user_dave", name: "Dave", email: "dave@example.com" },
  ]);
  g.__objects.push({ key: `groups/${solo.id}/x-photo.png`, size: 300, lastModified: iso(Date.now()) });
  await groupChat.postMessage(club.id, { userId: "user_alice", name: "Alicia Zephyr" }, { text: "ALICE-GROUP-MESSAGE" }, await groups.listMembers(club.id));
  await kv.lpush(`neo:group:${club.id}:msgs`, JSON.stringify({ id: "gm2", userId: "user_bob", name: "Bob Brown", text: "BOB-GROUP-SECRET", ts: iso(Date.now()) }));
  await kv.hset(`neo:group:${club.id}:read`, { user_alice: String(Date.now()), user_bob: String(Date.now()) });
  // A pending place under Alice's address (as if added before she signed up with it).
  await groups.addPendingMembers(club.id, [{ kind: "email", value: "alice@example.com" }], { userId: "user_bob", role: "owner" } as never);

  // Personal stores.
  await notif.addNotification("user_alice", { type: "group_call" as never, title: "Bob Brown is calling", body: "Book club", url: "/dashboard" });
  await notif.addNotification("user_bob", { type: "group_call" as never, title: "Old one", body: "x", url: "/dashboard" }, Date.now() - 400 * day);
  await notif.addNotification("user_bob", { type: "group_call" as never, title: "New one", body: "x", url: "/dashboard" });
  await push.saveSubscription("user_alice", { endpoint: "https://push.example/PUSH-ENDPOINT-SECRET", keys: { p256dh: "P256-SECRET", auth: "AUTH-SECRET" } } as never, "Firefox on Linux");
  await fcm.saveFcmToken("user_alice", "FCM-TOKEN-SECRET-0123456789abcdefghijklmnopqrstuvwxyz");
  await kcTokens.saveKcTokens("user_alice", { accessToken: "KC-ACCESS-SECRET", refreshToken: "KC-REFRESH-SECRET", expiresAt: Date.now() + day } as never);
  await kv.set("neo:kc:handle-to-clerk:aliciakc", "user_alice");
  await sessions.createSession("user_alice", { ip: "203.0.113.77", fingerprint: "fpA", userAgent: "Firefox" });
  await payments.recordPayment({ paymentRef: "pay_alice_1", userId: "user_alice", plan: "pro", billingCycle: "monthly", amountEsp: 10, periodStart: Date.now(), periodEnd: Date.now() + 30 * day });
  await payments.recordPayment({ paymentRef: "pay_bob_1", userId: "user_bob", plan: "pro", billingCycle: "monthly", amountEsp: 10, periodStart: Date.now(), periodEnd: Date.now() + 30 * day });
  await kv.sadd("apikeys:user:user_alice", "key1");
  await kv.set("apikey:meta:key1", { id: "key1", name: "CI key", plan: "free", createdAt: Date.now(), maskedKey: "nck_MASKED-PART" });
  await kv.set("apikey:hash:key1", "APIKEYHASHSECRET");
  await kv.set("apikey:APIKEYHASHSECRET", { id: "key1", ownerUserId: "user_alice", name: "CI key" });
  await kv.sadd("meetings:user:user_alice", "m1");
  await kv.set("meeting:m1", { id: "m1", name: "API meeting", ownerUserId: "user_alice" });
  const recKey = "recordings/user_alice/alice-weekly/2026-10-01-10-00-00.mp4";
  const b64 = Buffer.from(recKey).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  await kv.set("neo:transcribe:job1", { id: "job1", recordingKey: recKey, status: "done", text: "TRANSCRIPT-WORDS-OF-EVERYONE", createdAt: iso(Date.now()) });
  await kv.set(`neo:transcribe:key:${b64}`, "job1");
  await kv.set(`neo:rec:views:${b64}`, 4);
  await kv.set("neo:share:tok1", { token: "tok1", key: recKey, ownerUserId: "user_alice", label: "share" });
  await kv.hset("neo:rec-usage:user_alice", { "2026-10": 600 });
  await kv.set("neo:personal-room:user_alice", "ev_alice");
  await users.addNote("user_alice", { byId: "user_super", byEmail: "super@example.com", text: "VIP customer note" });
  // Stores the other admin phases added: activity, a support ticket, notification preferences, a subscription.
  await activity.record("meeting.joined", { userId: "user_alice", account: "user_bob", props: { room: "bob-standup" } });
  await activity.record("signin", { userId: "user_bob" });
  const ticket = await tickets.createTicket({
    subject: "Help with ALICE-TICKET",
    category: "account",
    body: "ALICE-TICKET-BODY",
    userId: "user_alice",
    email: "alice@example.com",
    name: "Alicia Zephyr",
    source: "web",
  });
  await tickets.appendMessage(ticket, { author: "agent", authorName: "Agent Smithers", body: "SUPPORT-REPLY", attachments: [] });
  await tickets.addNote(ticket, { userId: "user_super", email: "super@example.com" }, "INTERNAL-NOTE-ABOUT-ALICE");
  await kv.set("neo:comms:prefs:user_alice", { product: { email: false, inApp: true, push: true }, updatedAt: Date.now(), updatedVia: "settings" });
  await kv.set("neo:sub:user_alice", { userId: "user_alice", email: "alice@example.com", planId: "pro", baseTier: "pro", version: 1, snapshot: { name: "Pro", prices: {}, limits: {} }, status: "active", cycle: "monthly", periodStart: Date.now(), periodEnd: Date.now() + 30 * day, source: "self" });
  await kv.sadd("neo:subs:users", "user_alice");
  await kv.lpush("neo:sub:h:user_alice", JSON.stringify({ ts: Date.now(), action: "purchase", by: { userId: "user_alice", email: "alice@example.com" }, summary: "Bought Pro", before: null, after: null }));
  await kv.lpush("neo:sub:h:user_alice", JSON.stringify({ ts: Date.now(), action: "extend", by: { userId: "user_super", email: "super@example.com" }, summary: "Extended by a week", before: null, after: null }));

  /* ------------------------------- data map ------------------------------- */
  console.log("data map");
  await t("every delete/anonymise location has an erase step, and every step covers real map entries", async () => {
    const stepIds = new Set([...erase.ERASE_STEPS.map((s) => s.id), erase.CLERK_STEP.id]);
    for (const loc of erasableLocations()) assert.ok(loc.erasedBy && stepIds.has(loc.erasedBy), `${loc.id} has no erase step`);
    const ids = new Set(DATA_MAP.map((d) => d.id));
    for (const s of [...erase.ERASE_STEPS, erase.CLERK_STEP]) for (const c of s.covers) assert.ok(ids.has(c), `${s.id} covers unknown ${c}`);
    assert.equal(new Set(DATA_MAP.map((d) => d.id)).size, DATA_MAP.length, "ids are unique");
  });

  /* -------------------------------- export -------------------------------- */
  console.log("export");
  let aliceZip: Map<string, Buffer> | null = null;
  await t("Download my data: built in steps, stored in R2, a short signed link — and only the person's own data, no secrets", async () => {
    const start = await call("user_alice", R.meExport.POST, { method: "POST", body: {} });
    assert.equal(start.status, 200, JSON.stringify(start.body));
    const id = (start.body.export as { id: string }).id;
    assert.equal((await call("user_alice", R.meExport.POST, { method: "POST", body: {} })).body.error, "already_running");
    let status = "running";
    for (let i = 0; i < 20 && status === "running"; i++) {
      const r = await call("user_alice", R.meExport.POST, { method: "POST", body: { id } });
      status = (r.body.export as { status: string }).status;
    }
    assert.equal(status, "ready");
    // Nobody else can fetch it.
    assert.equal((await call("user_bob", R.meExport.GET, { query: `?download=${id}` })).status, 404);
    const dl = await call("user_alice", R.meExport.GET, { query: `?download=${id}` });
    assert.equal(dl.status, 200);
    assert.match(String(dl.body.url), /^https:\/\/signed\.test\/data-exports\/user_alice\/exp_.*\.zip\?expires=300$/);
    const obj = g.__objects.find((o) => o.key.startsWith("data-exports/user_alice/"));
    assert.ok(obj?.body);
    aliceZip = readZip(obj!.body!);
    for (const f of ["README.txt", "manifest.json", "profile.json", "meetings.json", "meetings.csv", "attendance.json", "chat.json", "groups.json", "notifications.json", "devices.json", "payments.json", "api-keys.json", "recordings.json", "subscription.json", "billing.json", "support-tickets.json", "activity.json"]) {
      assert.ok(aliceZip.has(f), `missing ${f}`);
    }
    const all = [...aliceZip.values()].map((b) => b.toString("utf8")).join("\n");
    // Theirs:
    for (const s of ["alice@example.com", "ALICE-OWN-ROOM", "ALICE-IN-BOB-ROOM", "ALICE-GROUP-MESSAGE", "pay_alice_1", "CI key", "alice-weekly", "Book club", "aliciakc", "203.0.113.77", "Bob Brown is calling", "ALICE-TICKET-BODY", "SUPPORT-REPLY", "meeting.joined", "Bought Pro", "Extended by a week", "an administrator"]) {
      assert.ok(all.includes(s), `export lacks ${s}`);
    }
    // Not theirs, or secret:
    for (const s of [
      "bob@example.com",
      "dave@example.com",
      "BOB-SECRET-IN-ALICE-ROOM",
      "BOB-REPLY",
      "BOB-GROUP-SECRET",
      "pay_bob_1",
      "PUSH-ENDPOINT-SECRET",
      "P256-SECRET",
      "FCM-TOKEN-SECRET",
      "KC-ACCESS-SECRET",
      "KC-REFRESH-SECRET",
      "APIKEYHASHSECRET",
      "MASKED-PART",
      "TRANSCRIPT-WORDS-OF-EVERYONE",
      "VIP customer note",
      "super@example.com",
      "recordings/user_bob",
      "Agent Smithers",
      "INTERNAL-NOTE-ABOUT-ALICE",
    ]) {
      assert.ok(!all.includes(s), `export leaks ${s}`);
    }
    const attendance = JSON.parse(aliceZip.get("attendance.json")!.toString()) as { attendance: { eventId: string }[] };
    assert.deepEqual(attendance.attendance.map((a) => a.eventId), ["ev_bob"]);
    const manifest = JSON.parse(aliceZip.get("manifest.json")!.toString()) as { dataMap: unknown[] };
    assert.equal(manifest.dataMap.length, DATA_MAP.length);
  });

  await t("admin export: data:export needed; the owner's account is refused; start, advance, download are audited", async () => {
    assert.equal((await call("user_analyst", R.adminExport.POST, { method: "POST", params: { id: "user_bob" } })).body.error, "forbidden");
    assert.equal((await call("user_support", R.adminExport.POST, { method: "POST", params: { id: "user_owner" } })).body.error, "owner_protected");
    const s = await call("user_support", R.adminExport.POST, { method: "POST", params: { id: "user_bob" } });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    const id = (s.body.export as { id: string }).id;
    let status = "running";
    for (let i = 0; i < 20 && status === "running"; i++) status = ((await call("user_support", R.adminExportJob.POST, { method: "POST", params: { exportId: id } })).body.export as { status: string }).status;
    assert.equal(status, "ready");
    const dl = await call("user_support", R.adminExportJob.GET, { params: { exportId: id }, query: "?download=1" });
    assert.equal(dl.status, 200);
    assert.equal((await lastAudit("data.export.start")).targetId, "user_bob");
    assert.equal((await lastAudit("data.export.download")).targetId, "user_bob");
    // An admin's export cannot be fetched through the self-service route, and vice versa.
    assert.equal((await call("user_bob", R.meExport.GET, { query: `?download=${id}` })).status, 404);
  });

  /* ------------------------------ deletion ------------------------------ */
  console.log("deletion requests");
  await t("self-service request: typed confirmation, grace period from the setting, cancel in the grace period", async () => {
    assert.equal((await call("user_pat", R.meDeletion.POST, { method: "POST", body: { confirm: "yes" } })).body.error, "confirmation_required");
    const r = await call("user_pat", R.meDeletion.POST, { method: "POST", body: { confirm: "DELETE" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const req = r.body.request as { status: string; requestedAt: number; deleteAfter: number };
    assert.equal(req.status, "requested");
    assert.equal(req.deleteAfter - req.requestedAt, 30 * day);
    assert.equal(g.__users.user_pat.banned ?? false, false, "a self-service request leaves the account usable");
    const q = await call("user_analyst", R.data.GET);
    assert.equal((q.body.requests as { userId: string; status: string }[]).find((x) => x.userId === "user_pat")?.status, "requested");
    assert.equal((await call("user_pat", R.meDeletion.DELETE, { method: "DELETE" })).status, 200);
    assert.equal(await requests.getRequest("user_pat"), null);
    assert.equal((await requests.closedRequests()).find((c) => c.userId === "user_pat")?.status, "cancelled");
    assert.equal((await lastAudit("data.deletion.cancel")).actorEmail, "account holder");
  });

  await t("the owner can never be deleted: self-service, admin request, completion and erase itself all refuse", async () => {
    const self = await call("user_owner", R.meDeletion.POST, { method: "POST", body: { confirm: "DELETE" } });
    assert.equal(self.status, 403);
    assert.equal(self.body.error, "owner_protected");
    await stepUp("user_super");
    assert.equal((await call("user_super", R.deletion.POST, { method: "POST", params: { id: "user_owner" }, body: { reason: "x" } })).body.error, "owner_protected");
    // Even a request planted straight into KV does not get the owner deleted.
    await users.setDeletion("user_owner", { requestedAt: Date.now() - 60 * day, deleteAfter: Date.now() - day, requestedById: "x", requestedByEmail: "x", reason: "x", wasBanned: false });
    const p = await bulk("user_super", "complete-deletions", "preview", { selection: { userIds: ["user_owner"] } });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(p.body.count, 0);
    assert.match(JSON.stringify((p.body.extra as { skipped: unknown }).skipped), /owner_protected/);
    const direct = await erase.eraseAccount("user_owner", { userId: "user_super", email: "super@example.com" }, { id: "r", requestedAt: 0, source: "admin" });
    assert.equal(direct.ok, false);
    assert.ok(g.__users.user_owner, "still there");
    await users.clearDeletion("user_owner");
  });

  await t("legal hold: data:delete + step-up; an open request is refused; new requests are refused; release", async () => {
    assert.equal((await call("user_held", R.meDeletion.POST, { method: "POST", body: { confirm: "DELETE" } })).status, 200);
    assert.equal((await call("user_support", R.req.POST, { method: "POST", params: { uid: "user_held" }, body: { action: "hold", reason: "Litigation" } })).body.error, "forbidden");
    tick(11 * 60_000);
    assert.equal((await call("user_super", R.req.POST, { method: "POST", params: { uid: "user_held" }, body: { action: "hold", reason: "Litigation" } })).body.error, "step_up_required");
    await stepUp("user_super");
    assert.equal((await call("user_super", R.req.POST, { method: "POST", params: { uid: "user_held" }, body: { action: "hold" } })).body.error, "reason_required");
    const h = await call("user_super", R.req.POST, { method: "POST", params: { uid: "user_held" }, body: { action: "hold", reason: "Litigation" } });
    assert.equal(h.status, 200, JSON.stringify(h.body));
    assert.equal(await requests.getRequest("user_held"), null);
    assert.equal((await requests.closedRequests()).find((c) => c.userId === "user_held")?.status, "refused");
    const again = await call("user_held", R.meDeletion.POST, { method: "POST", body: { confirm: "DELETE" } });
    assert.equal(again.body.error, "refused");
    assert.ok(!JSON.stringify(again.body).toLowerCase().includes("litigation"), "the holder is not told why");
    assert.equal((await call("user_super", R.deletion.POST, { method: "POST", params: { id: "user_held" }, body: { reason: "x" } })).body.error, "legal_hold");
    assert.equal((await lastAudit("data.hold.place")).targetId, "user_held");
    // Even a due request planted straight into KV is not completed while the hold stands.
    await users.setDeletion("user_held", { requestedAt: Date.now() - 60 * day, deleteAfter: Date.now() - day, requestedById: "x", requestedByEmail: "x", reason: "x", wasBanned: true });
    const planted = await bulk("user_super", "complete-deletions", "preview", { selection: { userIds: ["user_held"] } });
    assert.equal(planted.body.count, 0);
    assert.match(JSON.stringify(planted.body.extra), /legal_hold/);
    assert.equal((await erase.eraseAccount("user_held", { userId: "user_super", email: "super@example.com" }, { id: "r", requestedAt: 0, source: "admin" })).ok, false);
    assert.ok(g.__users.user_held);
    await users.clearDeletion("user_held");
    assert.equal((await call("user_super", R.req.POST, { method: "POST", params: { uid: "user_held" }, body: { action: "release" } })).status, 200);
    assert.equal(await requests.getHold("user_held"), null);
  });

  /* ------------------------------ bulk tokens ----------------------------- */
  console.log("bulk preview tokens");
  let alicePreview: Body | null = null;
  await t("completion is previewed: grace period first; then blocked while Alice owns a shared group; the preview counts every step", async () => {
    assert.equal((await call("user_alice", R.meDeletion.POST, { method: "POST", body: { confirm: "DELETE" } })).status, 200);
    const early = await bulk("user_super", "complete-deletions", "preview", { selection: { userIds: ["user_alice"] } });
    assert.equal(early.body.count, 0);
    assert.match(JSON.stringify(early.body.extra), /grace period runs until/);
    tick(31 * day);
    await stepUp("user_super");
    const q = await call("user_super", R.data.GET);
    assert.equal((q.body.requests as { userId: string; status: string }[]).find((x) => x.userId === "user_alice")?.status, "scheduled");
    const blocked = await bulk("user_super", "complete-deletions", "preview", { selection: { userIds: ["user_alice"] } });
    assert.equal(blocked.body.count, 0);
    assert.match(JSON.stringify(blocked.body.extra), /owns_groups/);
    // Phase 2's "Delete now" says the same, server-side.
    assert.equal((await call("user_super", R.purge.POST, { method: "POST", params: { id: "user_alice" } })).body.error, "owns_groups");
    await groups.adminTransferOwnership(shared.id, "user_dave", "user_super");
    const p = await bulk("user_super", "complete-deletions", "preview", { selection: { userIds: ["user_alice"] } });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(p.body.count, 1);
    assert.equal(p.body.confirmPhrase, "complete 1");
    const plan = (p.body.extra as { plans: Record<string, Record<string, number>> }).plans.user_alice;
    for (const step of ["groups", "ownedEvents", "othersEvents", "fieldsInOthers", "meetingChat", "attendance", "reports", "groupChat", "personalKeys", "subscriptions", "tickets", "comms", "activity", "payments", "apiKeys", "recordingMeta", "r2", "exports", "admin"]) {
      assert.ok(plan[step] > 0, `preview counts nothing for ${step}: ${JSON.stringify(plan)}`);
    }
    assert.ok(g.__users.user_alice, "a preview changes nothing");
    assert.ok(g.__kvStore.has("neo:event:ev_alice"));
    alicePreview = p.body;
  });

  await t("apply refuses: no token, forged token, someone else's, wrong selection, no typed phrase, expired", async () => {
    const tok = alicePreview!.token as string;
    const sel = { userIds: ["user_alice"] };
    assert.equal((await bulk("user_super", "complete-deletions", "apply", { selection: sel })).body.error, "preview_required");
    const forged = tok.split(".")[0] + ".AAAA";
    assert.equal((await bulk("user_super", "complete-deletions", "apply", { selection: sel, token: forged, confirm: "complete 1" })).body.error, "bad_token");
    // A token for another action does not work here either.
    const other = await bulk("user_super", "purge", "preview", { selection: { category: "trash" } });
    assert.equal((await bulk("user_super", "complete-deletions", "apply", { selection: sel, token: other.body.token, confirm: "complete 1" })).body.error, "bad_token");
    // The owner previews the same thing; the super admin cannot use the owner's token.
    await stepUp("user_owner");
    const ownerPreview = await bulk("user_owner", "complete-deletions", "preview", { selection: sel });
    assert.equal(ownerPreview.status, 200, JSON.stringify(ownerPreview.body));
    assert.equal((await bulk("user_super", "complete-deletions", "apply", { selection: sel, token: ownerPreview.body.token, confirm: "complete 1" })).body.error, "bad_token");
    // A different selection than previewed.
    assert.equal((await bulk("user_super", "complete-deletions", "apply", { selection: { userIds: ["user_bob"] }, token: tok, confirm: "complete 1" })).body.error, "selection_changed");
    assert.equal((await bulk("user_super", "complete-deletions", "apply", { selection: sel, token: tok })).body.error, "confirmation_required");
    assert.equal((await bulk("user_super", "complete-deletions", "apply", { selection: sel, token: tok, confirm: "complete 2" })).body.error, "confirmation_required");
    tick(11 * 60_000);
    await stepUp("user_super");
    assert.equal((await bulk("user_super", "complete-deletions", "apply", { selection: sel, token: tok, confirm: "complete 1" })).body.error, "preview_expired");
    assert.ok(g.__users.user_alice, "nothing ran");
    const denied = await audit.listAdminAudit({ action: "data.bulk.complete-deletions", outcome: "denied" });
    assert.ok(denied.total >= 6, "refused applies are audited");
  });

  /* ------------------------------ completion ------------------------------ */
  console.log("completion");
  await t("completion deletes or anonymises every data-map location, removes R2 files, deletes Clerk last, writes a certificate", async () => {
    const p = await bulk("user_super", "complete-deletions", "preview", { selection: { userIds: ["user_alice"] } });
    const r = await bulk("user_super", "complete-deletions", "apply", { selection: { userIds: ["user_alice"] }, token: p.body.token, confirm: "complete 1" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual((r.body.result as { completed: string[] }).completed, ["user_alice"]);

    // Clerk, last.
    assert.equal(g.__users.user_alice, undefined);
    // Owned meeting and everything hanging off it.
    for (const k of ["neo:event:ev_alice", "neo:slug:alice-weekly", "neo:chat:ev_alice", "neo:attendance:ev_alice:events", "neo:owner:user_alice", "neo:personal-room:user_alice"]) {
      assert.equal(g.__kvStore.has(k), false, `${k} survived`);
    }
    // Others' meeting: Alice's entries gone, Bob's kept.
    const bobEv = (await eventStore.byId("ev_bob")) as unknown as { roles: { identifier: string }[]; waitingRoom: unknown[]; recentRedemptions: unknown[] };
    assert.deepEqual(bobEv.roles.map((x) => x.identifier), ["dave@example.com"]);
    assert.equal(bobEv.waitingRoom.length, 0);
    assert.equal(bobEv.recentRedemptions.length, 0);
    assert.deepEqual(Object.keys((await kv.hgetall("neo:meeting:ev_bob:roles")) ?? {}), ["bob@example.com"]);
    assert.deepEqual(Object.keys((await kv.hgetall("neo:event:ev_bob:calls")) ?? {}), ["user_dave"]);
    assert.equal(await kv.hgetall("neo:event:ev_bob:invited"), null);
    assert.deepEqual(Object.keys((await kv.hgetall("neo:owner:user_bob:recurring")) ?? {}), ["user_dave"]);
    const chat = (await kv.get("neo:chat:ev_bob")) as { userId: string | null; name: string; text: string; attachments?: unknown; replyTo?: { name: string } }[];
    assert.deepEqual(chat.map((m) => [m.userId, m.name, m.text]), [
      [null, "Deleted user", "ALICE-IN-BOB-ROOM"],
      ["user_bob", "Bob Brown", "BOB-REPLY"],
    ]);
    assert.equal(chat[0].attachments, undefined);
    assert.equal(chat[1].replyTo?.name, "Deleted user");
    const attendance = ((await kv.lrange("neo:attendance:ev_bob:events", 0, -1)) as { userId: string; name: string; email?: string }[]).map((e) => [e.userId.startsWith("erased_") ? "erased" : e.userId, e.name, e.email ?? null]);
    assert.deepEqual(attendance.sort(), [["erased", "Deleted user", null], ["user_bob", "Bob Brown", "bob@example.com"]].sort());
    const report = (await kv.get("neo:report:ev_bob")) as { participants: { name: string; email: string }[]; hosts: string[]; summary: { firstToJoin: string } };
    assert.deepEqual(report.participants.map((x) => x.name), ["Deleted user", "Bob Brown"]);
    assert.deepEqual(report.hosts, ["Bob Brown", "Deleted user"]);
    assert.equal(report.summary.firstToJoin, "Deleted user");
    // Groups: out of Bob's, solo group deleted with its files, shared one stays with Dave.
    assert.equal(await groups.getMember(club.id, "user_alice"), null);
    assert.equal(await groups.getGroup(solo.id), null);
    assert.ok(!g.__objects.some((o) => o.key.startsWith(`groups/${solo.id}/`)));
    assert.equal((await groups.getMember(shared.id, "user_dave"))?.role, "owner");
    const gmsgs = ((await kv.lrange(`neo:group:${club.id}:msgs`, 0, -1)) as { userId: string; name: string; text: string }[]).map((m) => [m.name, m.text]);
    assert.ok(gmsgs.some(([name, text]) => name === "Deleted user" && text === "ALICE-GROUP-MESSAGE"), JSON.stringify(gmsgs));
    assert.ok(gmsgs.some(([name, text]) => name === "Bob Brown" && text === "BOB-GROUP-SECRET"));
    assert.deepEqual(Object.keys((await kv.hgetall(`neo:group:${club.id}:read`)) ?? {}), ["user_bob"]);
    // Payments kept, detached; the per-person index gone; Bob's untouched.
    const kept = (await kv.get("billing:payment:pay_alice_1")) as { userId: string; amountEsp: number };
    assert.match(kept.userId, /^erased_[0-9a-f]{16}$/);
    assert.equal(kept.amountEsp, 10);
    assert.equal(g.__kvStore.has("billing:payments:user_alice"), false);
    assert.equal(((await kv.get("billing:payment:pay_bob_1")) as { userId: string }).userId, "user_bob");
    // Files: Alice's recordings, uploads and exports gone; Bob's stay.
    assert.ok(!g.__objects.some((o) => o.key.includes("user_alice")), JSON.stringify(g.__objects.map((o) => o.key)));
    assert.ok(g.__objects.some((o) => o.key.startsWith("recordings/user_bob/")));
    // Tombstone and closed request.
    assert.equal(await requests.isErased("user_alice"), true);
    const closed = (await requests.closedRequests()).find((c) => c.userId === "user_alice");
    assert.equal(closed?.status, "completed");
    assert.match(String(closed?.certificateId), /^cert_/);

    // The sweep: nothing in KV still names Alice, outside the audit trail and
    // the governance records that must (request log, tombstone).
    const allowed = (k: string) => k.startsWith("neo:admin:audit:") || k === "neo:data:requests:log" || k === "neo:data:erased";
    const left = kvText(allowed).filter((line) => /user_alice|alice@example\.com|alicia|aliciakc|203\.0\.113\.77|ALICE-OWN-ROOM/i.test(line));
    assert.deepEqual(left, [], "still names Alice:\n" + left.join("\n"));

    // The certificate: counts, when, by whom — no personal data.
    const cert = await lastAudit("data.deletion.certificate");
    assert.equal(cert.targetId, "user_alice");
    assert.equal(cert.actorEmail, "super@example.com");
    const certText = JSON.stringify(cert.after);
    assert.ok(!/alice@example\.com|alicia|zephyr|aliciakc/i.test(certText), certText);
    const removed = (cert.after as { removed: Record<string, number> }).removed;
    assert.equal(removed.clerk, 1);
    assert.ok(removed.r2 >= 3 && removed.ownedEvents >= 1 && removed.payments >= 1, JSON.stringify(removed));
  });

  await t("phase 2's \"Delete now\" runs the same completion and needs data:delete and a typed confirmation", async () => {
    assert.equal((await call("user_super", R.deletion.POST, { method: "POST", params: { id: "user_pat" }, body: { reason: "Asked by email" } })).status, 200);
    assert.equal(g.__users.user_pat.banned, true, "an administrator's request suspends");
    // The person cannot take back a request an administrator made.
    assert.equal((await call("user_pat", R.meDeletion.DELETE, { method: "DELETE" })).body.error, "not_yours");
    assert.ok(await requests.getRequest("user_pat"));
    tick(31 * day);
    await stepUp("user_super");
    assert.equal((await call("user_super", R.purge.POST, { method: "POST", params: { id: "user_pat" } })).body.error, "confirmation_required");
    const r = await call("user_super", R.purge.POST, { method: "POST", params: { id: "user_pat" }, body: { confirm: "delete" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(g.__users.user_pat, undefined);
    assert.match(String((r.body.certificate as { id: string }).id), /^cert_/);
    assert.equal((await lastAudit("data.deletion.certificate")).targetId, "user_pat");
  });

  /* --------------------------------- trash -------------------------------- */
  console.log("trash");
  // A month has passed: every admin session has ended.
  for (const who of ["user_analyst", "user_support"]) await stepUp(who);
  await stepUp("user_super");
  await t("a deleted meeting, group and recording go to the trash; restoring puts each back as it was", async () => {
    await ev("ev_bob2", "bob-retro", "user_bob");
    await kv.hset("neo:meeting:ev_bob2:roles", { user_dave: JSON.stringify({ role: "cohost" }) });
    const del = await call("user_bob", R.eventDelete.POST, { method: "POST", body: { slug: "bob-retro", confirm: "bob-retro" } });
    assert.equal(del.status, 200, JSON.stringify(del.body));
    assert.equal(await eventStore.bySlug("bob-retro"), null, "gone for the user, as before");
    const club2 = await groups.createGroup({ name: "Chess" }, { userId: "user_bob", name: "Bob Brown" }, [{ userId: "user_dave", name: "Dave" }]);
    const gdel = await call("user_bob", R.groupRoute.DELETE as never, { method: "DELETE", params: { id: club2.id } as never, body: { confirmName: "Chess" } });
    assert.equal(gdel.status, 200, JSON.stringify(gdel.body));
    assert.equal(await groups.getGroup(club2.id), null);
    const rkey = "recordings/user_bob/bob-standup/2026-09-01-09-00-00.mp4";
    const rdel = await call("user_bob", R.recordings.DELETE, { method: "DELETE", query: `?key=${encodeURIComponent(rkey)}` });
    assert.equal(rdel.status, 200, JSON.stringify(rdel.body));
    assert.ok(!g.__objects.some((o) => o.key === rkey));
    assert.ok(g.__objects.some((o) => o.key === "trash/" + rkey));

    const items = await trash.listTrash({ ownerId: "user_bob" });
    assert.deepEqual(items.map((i) => i.kind).sort(), ["group", "meeting", "recording"]);
    const ids = items.map((i) => i.id);
    assert.equal((await bulk("user_analyst", "restore", "preview", { selection: { ids } })).body.error, "forbidden");
    const p = await bulk("user_super", "restore", "preview", { selection: { ids } });
    assert.equal(p.body.count, 3);
    assert.equal(p.body.confirmPhrase, null, "restoring is not destructive");
    const r = await bulk("user_super", "restore", "apply", { selection: { ids }, token: p.body.token });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((r.body.result as { restored: string[] }).restored.length, 3);
    assert.equal((await eventStore.bySlug("bob-retro"))?.id, "ev_bob2");
    assert.ok((await eventStore.listByOwner("user_bob")).some((e) => e.id === "ev_bob2"));
    assert.deepEqual(Object.keys((await kv.hgetall("neo:meeting:ev_bob2:roles")) ?? {}), ["user_dave"]);
    assert.equal((await groups.getGroup(club2.id))?.name, "Chess");
    assert.ok((await groups.listGroupsForUser("user_dave")).some((s) => s.group.id === club2.id));
    assert.ok(g.__objects.some((o) => o.key === rkey));
    // One audit entry per restored item. They are written in trash-id order, and items deleted in the
    // same millisecond differ only by a random suffix, so compare the set, not which came last.
    const restoredAudit = (await audit.listAdminAudit({ action: "data.trash.restore", limit: 3 })).items;
    assert.deepEqual(restoredAudit.map((e) => e.targetType).sort(), ["group", "meeting", "recording"]);
  });

  await t("restore is refused when something took its place, and once the restore window has passed", async () => {
    await call("user_bob", R.eventDelete.POST, { method: "POST", body: { slug: "bob-retro", confirm: "bob-retro" } });
    const item = (await trash.listTrash({ kind: "meeting", ownerId: "user_bob" }))[0];
    await ev("ev_new", "bob-retro", "user_dave"); // the address is taken again
    const p = await bulk("user_super", "restore", "preview", { selection: { ids: [item.id] } });
    assert.match(JSON.stringify((p.body.extra as { conflicts: unknown }).conflicts), /conflict/);
    const r = await bulk("user_super", "restore", "apply", { selection: { ids: [item.id] }, token: p.body.token });
    assert.match(JSON.stringify((r.body.result as { failed: unknown }).failed), /conflict/);
    assert.equal((await eventStore.bySlug("bob-retro"))?.id, "ev_new", "nothing overwritten");
    // A group whose key is in use again is not written over either.
    const chess2 = await groups.createGroup({ name: "Chess two" }, { userId: "user_bob", name: "Bob Brown" });
    assert.equal((await call("user_bob", R.groupRoute.DELETE as never, { method: "DELETE", params: { id: chess2.id } as never, body: { confirmName: "Chess two" } })).status, 200);
    const gItem = (await trash.listTrash({ kind: "group", ownerId: "user_bob" })).find((x) => x.ref === chess2.id)!;
    await kv.hset(`neo:group:${chess2.id}`, { id: JSON.stringify(chess2.id), name: JSON.stringify("Someone else's") });
    const gp = await bulk("user_super", "restore", "preview", { selection: { ids: [gItem.id] } });
    assert.match(JSON.stringify((gp.body.extra as { conflicts: unknown }).conflicts), /in use again/);
    const ga = await bulk("user_super", "restore", "apply", { selection: { ids: [gItem.id] }, token: gp.body.token });
    assert.match(JSON.stringify((ga.body.result as { failed: unknown }).failed), /conflict/);
    assert.equal((await groups.getGroup(chess2.id))?.name, "Someone else's");
    tick(31 * day);
    await stepUp("user_super");
    const late = await bulk("user_super", "restore", "preview", { selection: { ids: [item.id] } });
    assert.equal(late.body.count, 0);
    assert.deepEqual((late.body.extra as { notRestorable: string[] }).notRestorable, [item.id]);
  });

  /* ------------------------- retention and purges -------------------------- */
  console.log("retention and purges");
  for (const who of ["user_analyst", "user_support"]) await stepUp(who);
  await t("a retention change previews what it affects, needs data:delete + step-up, and is audited; values are bounded", async () => {
    assert.equal((await bulk("user_support", "retention", "preview", { selection: { category: "trash", days: 7 } })).body.error, "forbidden");
    assert.equal((await bulk("user_super", "retention", "preview", { selection: { category: "audit", days: 100 } })).body.error, "bad_selection");
    assert.equal((await bulk("user_super", "retention", "preview", { selection: { category: "accounts", days: null } })).body.error, "bad_selection");
    // An open request moves with the grace period.
    assert.equal((await call("user_dave", R.meDeletion.POST, { method: "POST", body: { confirm: "DELETE" } })).status, 200);
    const before = (await requests.getRequest("user_dave"))!;
    const p = await bulk("user_super", "retention", "preview", { selection: { category: "accounts", days: 14 } });
    assert.equal(p.body.count, 1);
    assert.equal((p.body.extra as { current: number }).current, 30);
    const r = await bulk("user_super", "retention", "apply", { selection: { category: "accounts", days: 14 }, token: p.body.token });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await requests.getRequest("user_dave"))!.deleteAfter, before.requestedAt + 14 * day);
    const e = await lastAudit("data.retention.change");
    assert.deepEqual([e.targetId, (e.before as { days: number }).days, (e.after as { days: number }).days], ["accounts", 30, 14]);
    // A spent token is spent.
    const n1 = await bulk("user_super", "retention", "preview", { selection: { category: "notifications", days: 30 } });
    assert.equal((await bulk("user_super", "retention", "apply", { selection: { category: "notifications", days: 30 }, token: n1.body.token })).status, 200);
    assert.equal((await bulk("user_super", "retention", "apply", { selection: { category: "notifications", days: 30 }, token: n1.body.token })).body.error, "token_used");
    await call("user_dave", R.meDeletion.DELETE, { method: "DELETE" });
  });

  await t("purges remove exactly what is past its period, after a typed confirmation, and say so in the audit with counts", async () => {
    // Weeks have passed in this test: both earlier notifications are past 30 days; this one is not.
    await notif.addNotification("user_bob", { type: "group_call" as never, title: "Fresh one", body: "x", url: "/dashboard" });
    const p = await bulk("user_super", "purge", "preview", { selection: { category: "notifications" } });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(p.body.count, 1, JSON.stringify(p.body));
    assert.equal((p.body.totals as { entries: number }).entries, 2);
    assert.equal(p.body.confirmPhrase, "purge 1");
    const r = await bulk("user_super", "purge", "apply", { selection: { category: "notifications" }, token: p.body.token, confirm: "purge 1" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual((await notif.listNotifications("user_bob")).items.map((x) => x.title), ["Fresh one"]);
    const e = await lastAudit("data.purge");
    assert.equal((e.after as { removed: number }).removed, 2);
    assert.ok(!JSON.stringify(e).includes("Old one"));
    // Expired trash goes; a category whose store is not on main says so.
    const tp = await bulk("user_super", "purge", "preview", { selection: { category: "trash" } });
    assert.ok((tp.body.count as number) >= 1);
    assert.equal((await bulk("user_super", "purge", "apply", { selection: { category: "trash" }, token: tp.body.token, confirm: tp.body.confirmPhrase })).status, 200);
    assert.ok(!g.__objects.some((o) => o.key.startsWith("trash/") && o.key.includes("bob-retro")));
    // KV snapshots older than the backups period (14 days) go: file and index entry, as the operations phase's own retention does.
    const meta = (id: string, age: number) => JSON.stringify({ id, kind: "scheduled", createdAt: Date.now() - age, createdBy: "vercel-cron", r2Key: `ops-backups/kv/${id}.json.gz`, bytes: 10, rawBytes: 20, keyCount: 3, sha256: id, truncated: false, prefixes: null });
    await kv.hset("neo:ops:backups", { bk_old: meta("bk_old", 30 * day), bk_new: meta("bk_new", day) });
    g.__objects.push({ key: "ops-backups/kv/bk_old.json.gz", size: 10 }, { key: "ops-backups/kv/bk_new.json.gz", size: 10 });
    const backups = await bulk("user_super", "purge", "preview", { selection: { category: "backups" } });
    assert.equal(backups.body.count, 1, JSON.stringify(backups.body));
    assert.equal((await bulk("user_super", "purge", "apply", { selection: { category: "backups" }, token: backups.body.token, confirm: "purge 1" })).status, 200);
    assert.deepEqual(Object.keys((await kv.hgetall("neo:ops:backups")) ?? {}), ["bk_new"]);
    assert.deepEqual(g.__objects.filter((o) => o.key.startsWith("ops-backups/")).map((o) => o.key), ["ops-backups/kv/bk_new.json.gz"]);
    // Every purge ran through the operations job runner, recorded and locked.
    const runs = await jobs.listRuns("data-purge", 50);
    assert.ok(runs.length >= 3 && runs.every((x) => x.outcome === "ok" && x.actor === "super@example.com"), JSON.stringify(runs));
    assert.ok((await jobs.listRuns("data-deletions", 10)).length >= 1);
    assert.ok((await jobs.listRuns("data-export", 50)).length >= 2);
    // While the same job runs, apply is refused before the token is spent.
    assert.equal(await jobs.acquireJobLock("data-purge", "run_elsewhere", 60_000), true);
    const lp = await bulk("user_super", "purge", "preview", { selection: { category: "exports" } });
    assert.equal((await bulk("user_super", "purge", "apply", { selection: { category: "exports" }, token: lp.body.token, confirm: lp.body.confirmPhrase })).body.error, "busy");
    await jobs.releaseJobLock("data-purge", "run_elsewhere");
    // Raw activity past its period goes by whole days; Bob's sign-in is weeks old by now.
    const act = await bulk("user_super", "purge", "preview", { selection: { category: "activity" } });
    assert.equal(act.status, 200, JSON.stringify(act.body));
    assert.equal((await bulk("user_super", "purge", "apply", { selection: { category: "activity" }, token: act.body.token, confirm: act.body.confirmPhrase })).status, 200);
    assert.ok((act.body.count as number) >= 1, JSON.stringify(act.body));
    assert.ok(!kvText(() => false).some((l) => l.startsWith("neo:act:log:") && l.includes("signin")), "the old raw day is gone");
    // Closed tickets go once a period is set; open ones and recent ones stay.
    const oldT = await tickets.createTicket({ subject: "Old one", category: "account", body: "x", userId: "user_bob", email: "bob@example.com", name: "Bob Brown", source: "web" });
    await tickets.saveTicket({ ...oldT, status: "closed", closedAt: Date.now() - 200 * day });
    const openT = await tickets.createTicket({ subject: "Still open", category: "account", body: "x", userId: "user_bob", email: "bob@example.com", name: "Bob Brown", source: "web" });
    const tp0 = await bulk("user_super", "purge", "preview", { selection: { category: "tickets" } });
    assert.match(String((tp0.body.extra as { unavailable: string }).unavailable), /kept/);
    const rt = await bulk("user_super", "retention", "preview", { selection: { category: "tickets", days: 90 } });
    assert.equal(rt.body.count, 1, "the change preview lists the ticket it would make purgeable");
    assert.equal((await bulk("user_super", "retention", "apply", { selection: { category: "tickets", days: 90 }, token: rt.body.token })).status, 200);
    const tk = await bulk("user_super", "purge", "preview", { selection: { category: "tickets" } });
    assert.equal(tk.body.count, 1);
    assert.equal((await bulk("user_super", "purge", "apply", { selection: { category: "tickets" }, token: tk.body.token, confirm: "purge 1" })).status, 200);
    assert.equal(await tickets.getTicket(oldT.id), null);
    assert.ok(await tickets.getTicket(openT.id));
    const files = await bulk("user_super", "purge", "preview", { selection: { category: "files" } });
    assert.equal(files.body.count, 0, "files are kept by default");
  });

  await t("the audit retention purge keeps integrity honest: removed months are not reported as tampering", async () => {
    await kv.lpush("neo:admin:audit:2020-01", JSON.stringify({ seq: 1, ts: Date.UTC(2020, 0, 5), actorId: "x", actorEmail: "x", action: "old", outcome: "ok" }));
    await kv.sadd("neo:admin:audit:months", "2020-01");
    const r = await audit.purgeAuditMonths(["2020-01", new Date(Date.now()).toISOString().slice(0, 7)]);
    assert.equal(r.months, 1, "the current month is never removed");
    const integrity = await audit.checkAuditIntegrity();
    assert.ok(!integrity.missing.includes(1));
  });

  /* ------------------------------ permissions ----------------------------- */
  console.log("permissions");
  await t("the Data page reads with users:read; every change needs data:delete and a fresh code; signed-out is refused", async () => {
    assert.equal((await call("user_analyst", R.data.GET)).status, 200);
    assert.equal((await call("user_bob", R.data.GET)).body.error, "not_admin");
    assert.equal((await bulk("user_analyst", "purge", "preview", { selection: { category: "trash" } })).body.error, "forbidden");
    tick(11 * 60_000);
    assert.equal((await bulk("user_super", "purge", "preview", { selection: { category: "trash" } })).body.error, "step_up_required");
    assert.equal((await bulk("user_super", "nonsense", "preview", { selection: {} })).status, 404);
    g.__who = undefined;
    const signedOut = await R.meExport.GET(new Request("https://www.neoconference.app/api/me/data/export"));
    assert.equal(signedOut.status, 401);
  });

  await t("no audit entry this phase wrote carries a deleted person's email or name", async () => {
    const mine = (await audit.listAdminAudit({ action: "data." , limit: 1000 })).items;
    assert.ok(mine.length > 10);
    for (const e of mine) assert.ok(!/alice@example\.com|alicia|zephyr|pat@example\.com/i.test(JSON.stringify(e)), JSON.stringify(e));
  });

  console.log(`\n${n} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
