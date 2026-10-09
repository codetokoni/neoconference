// Run: npx tsx src/lib/__tests__/supportDesk.smoke.ts
//
// Customer support, driven through the real routes with Clerk, KV and R2
// stood in for (./apiV1-stubs): the contact form signed in and signed out
// (bot check, honeypot, rate limits, attachments), "My tickets" showing a
// user only their own tickets and never an internal note, the admin desk's
// permissions, replies (email + bell), assignment, status and bulk changes in
// the audit trail, response-time targets and overdue tickets, and help
// articles staying hidden until published. Mail and uploads are recorded,
// never sent.

import assert from "node:assert/strict";
import "./apiV1-stubs/install";

process.env.CLERK_SECRET_KEY = "sk_test_support_desk";
process.env.PLATFORM_OWNER_EMAILS = "owner@example.com";
delete process.env.ADMIN_EMAILS;
delete process.env.RESEND_API_KEY;

type Stubbed = typeof globalThis & {
  __users: Record<string, { plan?: string; role?: string; emails?: string[]; unverified?: string[]; first?: string; metadata?: Record<string, unknown> }>;
  __who?: string;
};
const g = globalThis as Stubbed;
g.__users = {
  user_owner: { emails: ["owner@example.com"], first: "Owner" },
  user_agent: { emails: ["agent@example.com"], first: "Agnes" },
  user_analyst: { emails: ["analyst@example.com"], first: "Ana" },
  user_billing: { emails: ["billing@example.com"], first: "Bill" },
  user_alice: { emails: ["alice@example.com"], first: "Alice", plan: "pro", metadata: { planExpiresAt: Date.UTC(2027, 0, 1) } },
  user_bob: { emails: ["bob@example.com"], unverified: ["alice.old@example.com"], first: "Bob" },
};

const realNow = Date.now.bind(Date);
let skew = 0;
Date.now = () => realNow() + skew;
const tick = (ms = 30_000) => {
  skew += ms;
};
const HOUR = 60 * 60 * 1000;

let n = 0;
const t = async (name: string, fn: () => Promise<void>) => {
  await fn();
  n++;
  console.log("  ok  " + name);
};

async function main() {
  const mfa = await import("../admin/mfa");
  const audit = await import("../admin/audit");
  const tickets = await import("../support/tickets");
  const notify = await import("../support/notify");
  const model = await import("../support/model");
  const help = await import("../support/help");
  const notifications = await import("../notificationStore");
  const payments = await import("../paymentsStore");
  const { eventStore } = await import("../eventStore");
  const R = {
    enroll: await import("../../app/api/admin/mfa/enroll/route"),
    confirm: await import("../../app/api/admin/mfa/confirm/route"),
    verify: await import("../../app/api/admin/mfa/verify/route"),
    team: await import("../../app/api/admin/team/route"),
    session: await import("../../app/api/support/session/route"),
    intake: await import("../../app/api/support/tickets/route"),
    mine: await import("../../app/api/support/tickets/[id]/route"),
    myReply: await import("../../app/api/support/tickets/[id]/messages/route"),
    suggest: await import("../../app/api/help/suggest/route"),
    desk: await import("../../app/api/admin/support/tickets/route"),
    bulk: await import("../../app/api/admin/support/tickets/bulk/route"),
    ticket: await import("../../app/api/admin/support/tickets/[id]/route"),
    agentMsg: await import("../../app/api/admin/support/tickets/[id]/messages/route"),
    sla: await import("../../app/api/admin/support/sla/route"),
    articles: await import("../../app/api/admin/help/articles/route"),
    article: await import("../../app/api/admin/help/articles/[id]/route"),
  };

  const mail: { to: string; subject: string; text: string }[] = [];
  notify.__setSupportMailer(async (m) => {
    mail.push({ to: String(m.to), subject: m.subject, text: m.text ?? "" });
    return { ok: true, id: `mail_${mail.length}` };
  });
  const uploads: { key: string; size: number; type: string }[] = [];
  tickets.__setSupportUploader(async (key, body, type) => {
    uploads.push({ key, size: body.length, type });
  });

  const jar: Record<string, string> = {};
  const secrets: Record<string, string> = {};

  async function call<P = Record<string, string>>(
    who: string | null,
    handler: (req: Request, ctx: { params: P }) => Promise<Response>,
    opts: { method?: string; body?: unknown; form?: FormData; params?: P; query?: string; ip?: string } = {},
  ) {
    g.__who = who ?? undefined;
    const headers: Record<string, string> = { "x-forwarded-for": opts.ip ?? "203.0.113.1" };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (who && jar[who]) headers.cookie = `neo_admin_mfa=${jar[who]}`;
    const res = await handler(
      new Request(`https://www.neoconference.app/api/x${opts.query ?? ""}`, {
        method: opts.method ?? (opts.body !== undefined || opts.form ? "POST" : "GET"),
        headers,
        body: opts.form ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
      }),
      { params: (opts.params ?? {}) as P },
    );
    const m = res.headers.get("set-cookie")?.match(/neo_admin_mfa=([^;]*)/);
    if (m && who) jar[who] = decodeURIComponent(m[1]);
    const text = await res.text();
    let body: Record<string, unknown> & { error?: string };
    try {
      body = JSON.parse(text);
    } catch {
      body = { text };
    }
    return { status: res.status, body, text };
  }

  const code = (who: string) => mfa.totpAt(mfa.base32Decode(secrets[who]), mfa.currentStep());
  async function enrollAndVerify(who: string) {
    const e = await call(who, R.enroll.POST, { method: "POST" });
    assert.equal(e.status, 200, JSON.stringify(e.body));
    secrets[who] = e.body.secret as string;
    tick();
    const c = await call(who, R.confirm.POST, { method: "POST", body: { code: code(who) } });
    assert.equal(c.status, 200, JSON.stringify(c.body));
  }
  async function stepUp(who: string) {
    tick();
    assert.equal((await call(who, R.verify.POST, { method: "POST", body: { code: code(who) } })).status, 200);
  }
  async function freshToken() {
    const s = await call(null, R.session.GET);
    tick(5_000);
    return s.body.token as string;
  }

  // Administrators: the owner, a Support agent, an Analyst (support:read
  // only) and a Billing admin (no support access at all).
  await enrollAndVerify("user_owner");
  await stepUp("user_owner");
  for (const [email, roleId] of [
    ["agent@example.com", "support"],
    ["analyst@example.com", "analyst"],
    ["billing@example.com", "billing"],
  ]) {
    const r = await call("user_owner", R.team.POST, { body: { email, roleId } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  for (const who of ["user_agent", "user_analyst", "user_billing"]) await enrollAndVerify(who);

  console.log("contact form, signed out");
  let guestTicket = "";
  await t("the form answers signed out with a token, and says who is signed in otherwise", async () => {
    const out = await call(null, R.session.GET);
    assert.equal(out.body.signedIn, false);
    assert.match(String(out.body.token), /^\d+\.[\w-]+$/);
    assert.equal((out.body.attachments as { allowed: boolean }).allowed, false, "no attachments signed out");
    const inn = await call("user_alice", R.session.GET);
    assert.equal(inn.body.signedIn, true);
    assert.equal(inn.body.email, "alice@example.com");
  });

  const guestForm = (over: Record<string, string> = {}) => ({
    subject: "Cannot join with my phone",
    category: "meetings",
    description: "The join button spins forever on Android.",
    email: "visitor@example.com",
    name: "Visitor",
    ...over,
  });

  await t("signed out needs the form token, filled in no faster than a person could", async () => {
    const none = await call(null, R.intake.POST, { body: guestForm() });
    assert.equal(none.body.error, "form_check_failed");
    assert.equal(none.body.reason, "missing");
    const s = await call(null, R.session.GET);
    const tooFast = await call(null, R.intake.POST, { body: guestForm({ token: s.body.token as string }) });
    assert.equal(tooFast.body.reason, "too_fast");
    const forged = await call(null, R.intake.POST, { body: guestForm({ token: `${Date.now() - 10_000}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA` }) });
    assert.equal(forged.body.reason, "invalid");
    tick(5_000);
    const ok = await call(null, R.intake.POST, { body: guestForm({ token: s.body.token as string }) });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    guestTicket = (ok.body.ticket as { id: string }).id;
    assert.ok((ok.body.ticket as { number: number }).number > 1000);
    assert.equal(mail.at(-1)?.to, "visitor@example.com");
    assert.match(mail.at(-1)!.subject, /^\[#\d+\] We received your request/);
    const stored = await tickets.getTicket(guestTicket);
    assert.equal(stored?.userId, null);
    assert.equal(stored?.source, "guest");
    tick(3 * HOUR);
    const stale = await call(null, R.intake.POST, { body: guestForm({ token: s.body.token as string }) });
    assert.equal(stale.body.reason, "expired");
  });

  await t("the honeypot refuses a bot and stores nothing; a file needs an account", async () => {
    const before = (await tickets.listTickets()).length;
    const bot = await call(null, R.intake.POST, { body: guestForm({ token: await freshToken(), website: "http://spam.example" }) });
    assert.equal(bot.status, 400);
    assert.equal(bot.body.error, "rejected");
    const fd = new FormData();
    for (const [k, v] of Object.entries(guestForm({ token: await freshToken() }))) fd.set(k, v);
    fd.set("file", new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" }));
    const file = await call(null, R.intake.POST, { form: fd });
    assert.equal(file.body.error, "sign_in_to_attach");
    assert.equal((await tickets.listTickets()).length, before);
    assert.equal((await call(null, R.intake.POST, { body: guestForm({ token: await freshToken(), email: "not-an-email" }) })).body.error, "invalid_email");
  });

  await t("rate limits: 3 an hour from one email, 5 an hour from one network", async () => {
    for (let i = 0; i < 3; i++) {
      const r = await call(null, R.intake.POST, { ip: "198.51.100.7", body: guestForm({ token: await freshToken(), email: "flood@example.com" }) });
      assert.equal(r.status, 201, JSON.stringify(r.body));
    }
    const fourth = await call(null, R.intake.POST, { ip: "198.51.100.8", body: guestForm({ token: await freshToken(), email: "flood@example.com" }) });
    assert.equal(fourth.status, 429);
    assert.ok(Number(fourth.body.retryAfter) > 0);
    for (let i = 0; i < 2; i++) {
      assert.equal((await call(null, R.intake.POST, { ip: "198.51.100.7", body: guestForm({ token: await freshToken(), email: `n${i}@example.com` }) })).status, 201);
    }
    const sixth = await call(null, R.intake.POST, { ip: "198.51.100.7", body: guestForm({ token: await freshToken(), email: "n9@example.com" }) });
    assert.equal(sixth.status, 429, "6th from the same address this hour");
    tick(HOUR);
    assert.equal((await call(null, R.intake.POST, { ip: "198.51.100.7", body: guestForm({ token: await freshToken(), email: "n9@example.com" }) })).status, 201, "the window rolls over");
  });

  console.log("contact form, signed in, and My tickets");
  let aliceTicket = "";
  let aliceGuestTicket = "";
  let bobGuestTicket = "";
  await t("signed in: no token needed, one attachment within the size and type limits, stored under the ticket", async () => {
    const fd = new FormData();
    fd.set("subject", "Recording missing");
    fd.set("category", "recording");
    fd.set("description", "Yesterday's recording never appeared in my library.");
    fd.set("file", new File([new Uint8Array(2048)], "../../etc/screen shot.png", { type: "image/png" }));
    const ok = await call("user_alice", R.intake.POST, { form: fd });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    aliceTicket = (ok.body.ticket as { id: string }).id;
    assert.equal(uploads.length, 1);
    assert.match(uploads[0].key, new RegExp(`^support/${aliceTicket}/[\\w-]+-screen shot\\.png$`));
    const big = new FormData();
    for (const k of ["subject", "category", "description"]) big.set(k, fd.get(k) as string);
    big.set("file", new File([new Uint8Array(5 * 1024 * 1024 + 1)], "big.png", { type: "image/png" }));
    assert.equal((await call("user_alice", R.intake.POST, { form: big })).status, 413);
    big.set("file", new File([new Uint8Array(10)], "run.exe", { type: "application/x-msdownload" }));
    assert.equal((await call("user_alice", R.intake.POST, { form: big })).status, 415);
    assert.equal(uploads.length, 1, "refused files are not stored");
    const stored = await tickets.getTicket(aliceTicket);
    assert.equal(stored?.userId, "user_alice");
    assert.equal(stored?.email, "alice@example.com");
  });

  await t("My tickets: your own, plus ones sent signed out from an address verified on your account", async () => {
    const tok = await freshToken();
    aliceGuestTicket = ((await call(null, R.intake.POST, { ip: "192.0.2.10", body: guestForm({ token: tok, email: "Alice@Example.com" }) })).body.ticket as { id: string }).id;
    bobGuestTicket = ((await call(null, R.intake.POST, { ip: "192.0.2.10", body: guestForm({ token: await freshToken(), email: "alice.old@example.com" }) })).body.ticket as { id: string }).id;
    const mine = await call("user_alice", R.intake.GET);
    const ids = (mine.body.tickets as { id: string }[]).map((x) => x.id);
    assert.ok(ids.includes(aliceTicket) && ids.includes(aliceGuestTicket));
    assert.ok(!ids.includes(guestTicket) && !ids.includes(bobGuestTicket));
    const bob = await call("user_bob", R.intake.GET);
    assert.deepEqual((bob.body.tickets as unknown[]).length, 0, "an unverified address on Bob's account does not claim its tickets");
    assert.equal((await call(null, R.intake.GET)).status, 401);
  });

  await t("a user cannot read, reply to or resolve someone else's ticket — it reads as not found", async () => {
    assert.equal((await call("user_bob", R.mine.GET, { params: { id: aliceTicket } })).status, 404);
    assert.equal((await call("user_bob", R.mine.GET, { params: { id: bobGuestTicket } })).status, 404);
    assert.equal((await call("user_bob", R.myReply.POST, { params: { id: aliceTicket }, body: { body: "hi" } })).status, 404);
    assert.equal((await call("user_bob", R.mine.PATCH, { method: "PATCH", params: { id: aliceTicket }, body: { status: "resolved" } })).status, 404);
    assert.equal((await call(null, R.mine.GET, { params: { id: aliceTicket } })).status, 401);
    const own = await call("user_alice", R.mine.GET, { params: { id: aliceTicket } });
    assert.equal(own.status, 200);
    const msgs = own.body.messages as { attachments: { url: string; name: string }[] }[];
    assert.equal(msgs[0].attachments[0].name, "screen shot.png");
    assert.match(msgs[0].attachments[0].url, /^https:\/\/signed\.test\/support\//);
    assert.ok(!own.text.includes('"key"'), "the storage key never reaches the browser");
  });

  console.log("admin desk: permissions");
  await t("support:read to look, support:write to act; nothing without either", async () => {
    assert.equal((await call(null, R.desk.GET)).body.error, "signed_out");
    assert.equal((await call("user_alice", R.desk.GET)).body.error, "not_admin");
    const billing = await call("user_billing", R.desk.GET);
    assert.equal(billing.body.error, "forbidden");
    assert.equal(billing.body.permission, "support:read");
    assert.equal((await call("user_billing", R.articles.GET)).body.error, "forbidden");
    assert.equal((await call("user_analyst", R.desk.GET)).status, 200);
    assert.equal((await call("user_analyst", R.ticket.GET, { params: { id: aliceTicket } })).status, 200);
    for (const [handler, opts] of [
      [R.ticket.PATCH, { method: "PATCH", params: { id: aliceTicket }, body: { priority: "high" } }],
      [R.agentMsg.POST, { params: { id: aliceTicket }, body: { kind: "reply", body: "x" } }],
      [R.agentMsg.POST, { params: { id: aliceTicket }, body: { kind: "note", body: "x" } }],
      [R.bulk.POST, { body: { ids: [aliceTicket], set: { status: "open" } } }],
      [R.sla.PUT, { method: "PUT", body: {} }],
      [R.articles.POST, { body: { title: "x", body: "y", category: "meetings" } }],
      [R.desk.POST, { body: { email: "a@b.co", subject: "x", body: "y", category: "other" } }],
    ] as const) {
      const r = await call("user_analyst", handler as never, opts as never);
      assert.equal(r.body.error, "forbidden", JSON.stringify(opts));
      assert.equal(r.body.permission, "support:write");
    }
  });

  console.log("replies, notes, assignment and status");
  await t("a public reply is emailed and rung on the bell, starts the first-response clock, and is audited", async () => {
    const mailsBefore = mail.length;
    const r = await call("user_agent", R.agentMsg.POST, { params: { id: aliceTicket }, body: { kind: "reply", body: "Found it — it is back in your library now." } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.emailed, true);
    assert.equal(r.body.bell, true);
    assert.equal(mail.length, mailsBefore + 1);
    assert.equal(mail.at(-1)!.to, "alice@example.com");
    assert.ok(mail.at(-1)!.text.includes("Found it"));
    const bell = await notifications.listNotifications("user_alice");
    assert.equal(bell.items[0].url, `/support/tickets/${aliceTicket}`);
    const tk = await tickets.getTicket(aliceTicket);
    assert.equal(tk?.status, "pending_user");
    assert.ok(tk?.firstResponseAt);
    assert.equal(tk?.assigneeId, "user_agent", "whoever answers an unassigned ticket takes it");
    const { items } = await audit.listAdminAudit({ action: "support.ticket.reply" });
    assert.equal(items[0].actorEmail, "agent@example.com");
    assert.deepEqual(items[0].before, { status: "new", firstResponseAt: null, assigneeId: null });
    assert.equal((items[0].after as { status: string }).status, "pending_user");
  });

  await t("an internal note never leaves the admin API: not in the user's ticket, list, bell or email", async () => {
    const secret = "INTERNAL-ONLY refund was refused by finance";
    const mailsBefore = mail.length;
    const note = await call("user_agent", R.agentMsg.POST, { params: { id: aliceTicket }, body: { kind: "note", body: secret } });
    assert.equal(note.status, 201);
    assert.equal(mail.length, mailsBefore, "a note emails nobody");
    for (const r of [
      await call("user_alice", R.mine.GET, { params: { id: aliceTicket } }),
      await call("user_alice", R.intake.GET),
      await call("user_alice", R.myReply.POST, { params: { id: aliceTicket }, body: { body: "Thanks, I can see it." } }),
    ]) {
      assert.ok(r.status < 300, JSON.stringify(r.body));
      assert.ok(!r.text.includes("INTERNAL-ONLY"), "note text leaked to the user");
    }
    assert.ok(!JSON.stringify(await notifications.listNotifications("user_alice")).includes("INTERNAL-ONLY"));
    const admin = await call("user_agent", R.ticket.GET, { params: { id: aliceTicket } });
    assert.equal((admin.body.notes as { body: string }[])[0].body, secret);
    assert.equal((admin.body.messages as { body: string }[]).some((m) => m.body.includes("INTERNAL-ONLY")), false);
    const { items } = await audit.listAdminAudit({ action: "support.ticket.note" });
    assert.ok(!JSON.stringify(items[0]).includes("INTERNAL-ONLY"), "the audit log records that a note was written, not what it says");
  });

  await t("the user's reply reopens the ticket", async () => {
    assert.equal((await tickets.getTicket(aliceTicket))?.status, "open");
  });

  await t("assigning: only an administrator who can answer tickets, or the owner; audited before and after", async () => {
    const desk = await call("user_agent", R.desk.GET);
    const assignees = desk.body.assignees as { userId: string; isOwner: boolean }[];
    assert.ok(assignees.some((a) => a.userId === "user_owner" && a.isOwner));
    assert.ok(assignees.some((a) => a.userId === "user_agent"));
    assert.ok(!assignees.some((a) => a.userId === "user_analyst"), "read-only admins are not assignees");
    assert.equal((await call("user_agent", R.ticket.PATCH, { method: "PATCH", params: { id: aliceTicket }, body: { assigneeId: "user_bob" } })).body.error, "invalid_assignee");
    assert.equal((await call("user_agent", R.ticket.PATCH, { method: "PATCH", params: { id: aliceTicket }, body: { assigneeId: "user_analyst" } })).body.error, "invalid_assignee");
    const r = await call("user_agent", R.ticket.PATCH, { method: "PATCH", params: { id: aliceTicket }, body: { assigneeId: "user_owner", priority: "high", tags: ["Recording", "recording", "VIP!"] } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const { items } = await audit.listAdminAudit({ action: "support.ticket.update", target: aliceTicket });
    assert.deepEqual(items[0].before, { priority: "normal", assigneeId: "user_agent", assigneeEmail: "agent@example.com", tags: [] });
    assert.deepEqual(items[0].after, { priority: "high", assigneeId: "user_owner", assigneeEmail: "owner@example.com", tags: ["recording", "vip"] });
  });

  await t("status changes are audited; the user sees a resolved ticket in their conversation; closed takes no replies", async () => {
    const r = await call("user_agent", R.ticket.PATCH, { method: "PATCH", params: { id: aliceTicket }, body: { status: "resolved" } });
    assert.equal((r.body.ticket as { status: string }).status, "resolved");
    const { items } = await audit.listAdminAudit({ action: "support.ticket.update", target: aliceTicket });
    assert.deepEqual(items[0].before, { status: "open" });
    assert.deepEqual(items[0].after, { status: "resolved" });
    const mine = await call("user_alice", R.mine.GET, { params: { id: aliceTicket } });
    assert.equal((mine.body.messages as { author: string; body: string }[]).at(-1)?.body, "Support marked this resolved.");
    assert.ok((await tickets.getTicket(aliceTicket))?.resolvedAt);
    await call("user_agent", R.ticket.PATCH, { method: "PATCH", params: { id: aliceTicket }, body: { status: "closed" } });
    assert.equal((await call("user_alice", R.myReply.POST, { params: { id: aliceTicket }, body: { body: "One more thing" } })).status, 409);
    assert.equal((await call("user_agent", R.ticket.PATCH, { method: "PATCH", params: { id: aliceTicket }, body: { status: "done" } })).body.error, "invalid_status");
  });

  await t("the user can mark their own ticket solved", async () => {
    const r = await call("user_alice", R.mine.PATCH, { method: "PATCH", params: { id: aliceGuestTicket }, body: { status: "resolved" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await tickets.getTicket(aliceGuestTicket))?.status, "resolved");
  });

  await t("bulk changes check every ticket first; each change is audited on its own ticket", async () => {
    const before = await tickets.getTicket(guestTicket);
    const bad = await call("user_agent", R.bulk.POST, { body: { ids: [guestTicket, "nope"], set: { priority: "urgent" } } });
    assert.equal(bad.status, 404);
    assert.equal((await tickets.getTicket(guestTicket))?.priority, before?.priority, "nothing changed");
    const badVal = await call("user_agent", R.bulk.POST, { body: { ids: [guestTicket], set: { assigneeId: "user_bob" } } });
    assert.equal(badVal.body.error, "invalid_assignee");
    const ok = await call("user_agent", R.bulk.POST, { body: { ids: [guestTicket, bobGuestTicket], set: { assigneeId: "user_agent", status: "open" } } });
    assert.equal(ok.body.changed, 2, JSON.stringify(ok.body));
    const { items } = await audit.listAdminAudit({ action: "support.ticket.update", q: "bulk change of 2" });
    assert.equal(items.length, 2);
    assert.deepEqual(items.map((e) => e.targetId).sort(), [guestTicket, bobGuestTicket].sort());
    assert.deepEqual(items[0].before, { status: "new", assigneeId: null, assigneeEmail: null });
  });

  console.log("account, history and chat conversion");
  await t("a ticket shows its account: plan, expiry, recent payments, meetings, and every ticket it raised", async () => {
    await payments.recordPayment({ paymentRef: "pay_test_1", userId: "user_alice", plan: "pro", billingCycle: "monthly", amountEsp: 25 } as never);
    await eventStore.create({ id: "ev_alice_1", slug: "alice-standup", name: "Alice standup", ownerUserId: "user_alice", state: "ended", createdAt: new Date().toISOString() } as never);
    const r = await call("user_analyst", R.ticket.GET, { params: { id: aliceGuestTicket } });
    const acct = r.body.account as { found: boolean; userId: string; plan: string; planExpiresAt: number; payments: { ref: string }[]; meetings: { name: string }[]; href: string };
    assert.equal(acct.found, true, "a signed-out ticket from a verified address finds the account");
    assert.equal(acct.userId, "user_alice");
    assert.equal(acct.plan, "pro");
    assert.equal(acct.planExpiresAt, Date.UTC(2027, 0, 1));
    assert.equal(acct.payments[0].ref, "pay_test_1");
    assert.equal(acct.meetings[0].name, "Alice standup");
    assert.equal(acct.href, "/admin/users/user_alice");
    const history = (r.body.history as { id: string }[]).map((h) => h.id);
    assert.ok(history.includes(aliceTicket) && history.includes(aliceGuestTicket));
    const bobs = await call("user_analyst", R.ticket.GET, { params: { id: bobGuestTicket } });
    assert.equal((bobs.body.account as { found: boolean }).found, false, "an unverified address does not tie a ticket to an account");
    assert.equal((bobs.body.account as { href: string }).href, "/admin?q=alice.old%40example.com", "no account: a search for the address");
  });

  await t("an agent turns a NeoSupport chat into a ticket on the right account; audited", async () => {
    const r = await call("user_agent", R.desk.POST, {
      body: { email: "alice@example.com", subject: "From chat: invoice copy", category: "billing", priority: "low", body: "Visitor: can I get my invoice?", chatRef: "conv_123" },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const tk = r.body.ticket as { id: string; userId: string; source: string };
    assert.equal(tk.userId, "user_alice");
    assert.equal(tk.source, "chat");
    const { items } = await audit.listAdminAudit({ action: "support.ticket.create" });
    assert.equal(items[0].targetId, tk.id);
    const mine = await call("user_alice", R.intake.GET);
    assert.ok((mine.body.tickets as { id: string }[]).some((x) => x.id === tk.id));
  });

  console.log("response times");
  let urgent = "";
  await t("an urgent ticket with no reply after its first-response target is overdue, and filters as overdue", async () => {
    const r = await call("user_bob", R.intake.POST, { body: { subject: "Meeting down", category: "technical", description: "Nobody can join the 9am all-hands!" } });
    urgent = (r.body.ticket as { id: string }).id;
    await call("user_agent", R.ticket.PATCH, { method: "PATCH", params: { id: urgent }, body: { priority: "urgent" } });
    tick(30 * 60_000);
    let row = (await call("user_agent", R.ticket.GET, { params: { id: urgent } })).body.ticket as { sla: { overdue: boolean; firstResponseOverdue?: boolean } };
    assert.equal(row.sla.overdue, false, "30 minutes in, inside the 1 hour target");
    tick(45 * 60_000);
    row = (await call("user_agent", R.ticket.GET, { params: { id: urgent } })).body.ticket as { sla: { overdue: boolean; firstResponseOverdue: boolean } };
    assert.equal(row.sla.firstResponseOverdue, true);
    const list = await call("user_agent", R.desk.GET, { query: "?overdue=1" });
    assert.deepEqual((list.body.items as { id: string }[]).map((x) => x.id), [urgent]);
    assert.equal((list.body.summary as { overdue: number }).overdue, 1);
    assert.equal((list.body.summary as { openByPriority: { urgent: number } }).openByPriority.urgent, 1);
  });

  await t("a late reply clears overdue but is recorded as a breach; resolution has its own clock", async () => {
    await call("user_agent", R.agentMsg.POST, { params: { id: urgent }, body: { kind: "reply", body: "Looking now.", status: "open" } });
    let row = (await call("user_agent", R.ticket.GET, { params: { id: urgent } })).body.ticket as { sla: { overdue: boolean; firstResponseBreached: boolean; firstResponseMs: number } };
    assert.equal(row.sla.overdue, false);
    assert.equal(row.sla.firstResponseBreached, true);
    assert.ok(row.sla.firstResponseMs > HOUR);
    tick(8 * HOUR);
    await stepUp("user_agent"); // the admin session lasts 12 hours of this test clock
    const later = await call("user_agent", R.ticket.GET, { params: { id: urgent } });
    assert.equal(later.status, 200, JSON.stringify(later.body));
    row = later.body.ticket as never;
    assert.equal((row as unknown as { sla: { resolutionOverdue: boolean } }).sla.resolutionOverdue, true);
  });

  await t("targets are configurable per priority and audited; nonsense is refused", async () => {
    const bad = await call("user_agent", R.sla.PUT, { method: "PUT", body: { urgent: { firstResponseHours: 10, resolutionHours: 2 } } });
    assert.equal(bad.body.error, "invalid_sla");
    const ok = await call("user_agent", R.sla.PUT, { method: "PUT", body: { urgent: { firstResponseHours: 2, resolutionHours: 48 }, low: { firstResponseHours: -5, resolutionHours: "x" } } });
    assert.equal(ok.status, 200);
    assert.deepEqual((ok.body.sla as Record<string, unknown>).low, model.DEFAULT_SLA.low, "invalid hours keep the old value");
    const row = (await call("user_agent", R.ticket.GET, { params: { id: urgent } })).body.ticket as { sla: { overdue: boolean } };
    assert.equal(row.sla.overdue, false, "the new 48 h target applies at once");
    const { items } = await audit.listAdminAudit({ action: "support.sla.update" });
    assert.deepEqual(items[0].before, { urgent: { firstResponseHours: 1, resolutionHours: 8 } });
    assert.deepEqual(items[0].after, { urgent: { firstResponseHours: 2, resolutionHours: 48 } });
  });

  await t("the summary's median first response compares the last 7 days with the 7 before", () => {
    const now = Date.UTC(2026, 9, 9);
    const mk = (createdH: number, answeredH: number | null): import("../support/model").Ticket =>
      ({ priority: "normal", status: "open", assigneeId: null, createdAt: now - createdH * HOUR, firstResponseAt: answeredH == null ? null : now - answeredH * HOUR, resolvedAt: null, closedAt: null }) as never;
    const s = model.summarize([mk(30, 28), mk(50, 44), mk(60, 59), mk(200, 190), mk(240, 236), mk(5, null)], model.DEFAULT_SLA, now);
    assert.equal(s.answeredThisWeek, 3);
    assert.equal(s.medianFirstResponseThisWeek, 2 * HOUR);
    assert.equal(s.answeredLastWeek, 2);
    assert.equal(s.medianFirstResponseLastWeek, 7 * HOUR);
    assert.equal(s.open, 6);
    return Promise.resolve();
  });

  await t("the desk filters, searches, sorts and pages", async () => {
    const byNum = await tickets.getTicket(aliceTicket);
    const q = await call("user_agent", R.desk.GET, { query: `?q=%23${byNum!.number}` });
    assert.deepEqual((q.body.items as { id: string }[]).map((x) => x.id), [aliceTicket]);
    const unassigned = await call("user_agent", R.desk.GET, { query: "?assignee=none&status=unresolved" });
    assert.ok((unassigned.body.items as { assigneeId: string | null }[]).every((x) => x.assigneeId === null));
    const mineQ = await call("user_agent", R.desk.GET, { query: "?assignee=me" });
    assert.ok((mineQ.body.items as { assigneeId: string }[]).every((x) => x.assigneeId === "user_agent"));
    assert.ok((mineQ.body.items as unknown[]).length >= 2);
    const page = await call("user_agent", R.desk.GET, { query: "?limit=2&page=2&sort=number&dir=asc" });
    const nums = (page.body.items as { number: number }[]).map((x) => x.number);
    assert.equal(nums.length, 2);
    assert.ok(nums[0] < nums[1]);
    assert.ok((page.body.pages as number) > 2);
    const cat = await call("user_agent", R.desk.GET, { query: "?category=recording" });
    assert.ok((cat.body.items as { category: string }[]).every((x) => x.category === "recording"));
  });

  console.log("help centre");
  let draftId = "";
  await t("a draft article is invisible to the public and to suggestions until it is published", async () => {
    const r = await call("user_agent", R.articles.POST, {
      body: { title: "Fix a recording that is missing", summary: "Where recordings go and how long they take.", body: "## Wait ten minutes\nRecordings take a while to process.", category: "recording", tags: ["recording", "library"] },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const a = r.body.article as { id: string; slug: string; status: string };
    draftId = a.id;
    assert.equal(a.status, "draft");
    assert.equal(a.slug, "fix-a-recording-that-is-missing");
    assert.equal(await help.publishedBySlug(a.slug), null);
    const s = await call(null, R.suggest.GET, { query: "?q=my+recording+is+missing&category=recording" });
    assert.deepEqual(s.body.items, []);
    assert.equal((await help.searchArticles("recording")).length, 0);
    const pub = await call("user_agent", R.article.PATCH, { method: "PATCH", params: { id: draftId }, body: { status: "published" } });
    assert.equal(pub.status, 200, JSON.stringify(pub.body));
    const s2 = await call(null, R.suggest.GET, { query: "?q=my+recording+is+missing&category=recording" });
    assert.equal((s2.body.items as { slug: string }[])[0]?.slug, a.slug);
    assert.ok(await help.publishedBySlug(a.slug));
    const { items } = await audit.listAdminAudit({ action: "help.article.publish" });
    assert.deepEqual(items[0].before, { status: "draft" });
    assert.deepEqual(items[0].after, { status: "published" });
  });

  await t("article edits are audited with before and after; slugs stay unique; deleting is audited", async () => {
    const edit = await call("user_agent", R.article.PATCH, { method: "PATCH", params: { id: draftId }, body: { title: "Find a missing recording" } });
    assert.equal(edit.status, 200);
    const { items } = await audit.listAdminAudit({ action: "help.article.update" });
    assert.deepEqual(items[0].before, { title: "Fix a recording that is missing" });
    assert.deepEqual(items[0].after, { title: "Find a missing recording" });
    const twin = await call("user_agent", R.articles.POST, { body: { title: "Fix a recording that is missing", body: "x", category: "recording", slug: "fix-a-recording-that-is-missing" } });
    assert.equal((twin.body.article as { slug: string }).slug, "fix-a-recording-that-is-missing-2");
    const unpub = await call("user_agent", R.article.PATCH, { method: "PATCH", params: { id: draftId }, body: { status: "draft" } });
    assert.equal(unpub.status, 200);
    assert.equal(await help.publishedBySlug("fix-a-recording-that-is-missing"), null, "unpublishing hides it again");
    const del = await call("user_agent", R.article.DELETE, { method: "DELETE", params: { id: (twin.body.article as { id: string }).id } });
    assert.equal(del.status, 200);
    assert.equal((await audit.listAdminAudit({ action: "help.article.delete" })).items.length, 1);
  });

  await t("every support change in the audit trail carries who did it", async () => {
    const { items } = await audit.listAdminAudit({ action: "support." });
    assert.ok(items.length >= 8);
    assert.ok(items.every((e) => e.actorEmail === "agent@example.com" && e.outcome === "ok"));
  });

  console.log(`\n${n} checks passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
