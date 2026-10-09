// Run: npx tsx src/lib/__tests__/comms.smoke.ts
//
// Admin → Communication, driven through the real routes with Clerk and KV
// stood in for (./apiV1-stubs) and Resend answered by a fake fetch, so no
// email leaves: who an announcement reaches (plan, status, sign-up date,
// groups, named people), that nothing goes out before the preview is
// confirmed, step-up for large sends, a send job that never sends twice on a
// retry, pause / resume / cancel, preferences (and that transactional mail
// ignores them), signed unsubscribe links, Resend's signed delivery reports,
// email templates whose defaults are the wording the code sent before, usage
// reminders, permissions and the audit trail.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import "./apiV1-stubs/install";
import type { NeoEvent } from "@/types/event";

process.env.CLERK_SECRET_KEY = "sk_test_comms";
process.env.PLATFORM_OWNER_EMAILS = "owner@example.com";
process.env.RESEND_API_KEY = "re_test_fake";
process.env.MAIL_FROM = "NeoConference <hello@neo.test>";
delete process.env.RESEND_WEBHOOK_SECRET;
delete process.env.ADMIN_EMAILS;
Object.assign(process.env, {
  NEXT_PUBLIC_VAPID_PUBLIC_KEY: "test-public-key",
  VAPID_PRIVATE_KEY: "test-private-key",
  VAPID_SUBJECT: "mailto:test@example.com",
});

type U = { plan?: string; role?: string; emails?: string[]; first?: string; createdAt?: number; banned?: boolean; locked?: boolean; metadata?: Record<string, unknown> };
type Stubbed = typeof globalThis & { __users: Record<string, U>; __who?: string; __kvStore: Map<string, unknown> };
const g = globalThis as Stubbed;
const D = (s: string) => Date.parse(s + "T12:00:00Z");
g.__users = {
  user_owner: { emails: ["owner@example.com"], plan: "business", first: "Owner", createdAt: D("2025-01-01") },
  user_comms: { emails: ["comms@example.com"], plan: "business", first: "Cora", createdAt: D("2025-01-02") },
  user_help: { emails: ["help@example.com"], plan: "business", first: "Hal", createdAt: D("2025-01-03") },
  u_a: { emails: ["a@example.com"], first: "Ann", createdAt: D("2026-01-10"), metadata: { meetingsCreated: 3 } },
  u_b: { emails: ["b@example.com"], banned: true, createdAt: D("2026-02-10") },
  u_c: { emails: ["c@example.com"], plan: "pro", first: "Cy", createdAt: D("2026-05-01") },
  u_d: { emails: ["d@example.com"], plan: "pro", first: "Di", createdAt: D("2026-09-01") },
  u_e: { emails: ["e@example.com"], plan: "business", locked: true, createdAt: D("2026-03-01") },
  u_f: { emails: [], first: "Noel", createdAt: D("2026-04-01") },
};

// Resend, answered here. Every email the code tries to send lands in `mails`.
type Mail = { url: string; body: unknown; headers: Record<string, string> };
const mails: Mail[] = [];
let mailFail: string | null = null;
let mid = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith("https://api.resend.com/")) return realFetch(input, init);
  const body = JSON.parse(String(init?.body));
  mails.push({ url, body, headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])) });
  if (mailFail) return new Response(JSON.stringify({ message: mailFail }), { status: 422 });
  if (url.endsWith("/batch")) return Response.json({ data: (body as unknown[]).map(() => ({ id: `re_${++mid}` })) });
  return Response.json({ id: `re_${++mid}` });
}) as typeof fetch;
type BatchItem = { to: string[]; subject: string; html?: string; text?: string; headers?: Record<string, string> };
const batches = () => mails.filter((m) => m.url.endsWith("/batch"));
const singles = () => mails.filter((m) => m.url.endsWith("/emails"));
const lastBatch = () => batches().at(-1)!.body as BatchItem[];

const realNow = Date.now.bind(Date);
let skew = 0;
Date.now = () => realNow() + skew;
const tick = (ms = 30_000) => {
  skew += ms;
};

let n = 0;
const t = async (name: string, fn: () => Promise<void> | void) => {
  await fn();
  n++;
  console.log("  ok  " + name);
};

async function main() {
  const mfa = await import("../admin/mfa");
  const audit = await import("../admin/audit");
  const sends = await import("../comms/sends");
  const prefsLib = await import("../comms/prefs");
  const tpl = await import("../comms/templates");
  const logLib = await import("../comms/log");
  const webhook = await import("../comms/webhook");
  const notif = await import("../notificationStore");
  const push = await import("../pushStore");
  const groups = await import("../groupStore");
  const groupNotify = await import("../groupNotify");
  const plan = await import("../plan");
  const recUsage = await import("../recordingUsage");
  const R = {
    enroll: await import("../../app/api/admin/mfa/enroll/route"),
    confirmMfa: await import("../../app/api/admin/mfa/confirm/route"),
    verify: await import("../../app/api/admin/mfa/verify/route"),
    team: await import("../../app/api/admin/team/route"),
    roles: await import("../../app/api/admin/roles/route"),
    sends: await import("../../app/api/admin/comms/sends/route"),
    send: await import("../../app/api/admin/comms/sends/[id]/route"),
    confirm: await import("../../app/api/admin/comms/sends/[id]/confirm/route"),
    control: await import("../../app/api/admin/comms/sends/[id]/control/route"),
    process: await import("../../app/api/admin/comms/sends/[id]/process/route"),
    recipients: await import("../../app/api/admin/comms/sends/[id]/recipients/route"),
    templates: await import("../../app/api/admin/comms/templates/route"),
    template: await import("../../app/api/admin/comms/templates/[id]/route"),
    revert: await import("../../app/api/admin/comms/templates/[id]/revert/route"),
    test: await import("../../app/api/admin/comms/templates/[id]/test/route"),
    delivery: await import("../../app/api/admin/comms/delivery/route"),
    prefs: await import("../../app/api/admin/comms/prefs/route"),
    reminders: await import("../../app/api/admin/comms/reminders/route"),
    myPrefs: await import("../../app/api/me/comms-prefs/route"),
    unsub: await import("../../app/api/comms/unsubscribe/route"),
    hook: await import("../../app/api/comms/resend-webhook/route"),
  };

  const jar: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  type Body = Record<string, unknown> & { error?: string; message?: string };
  async function call<P = Record<string, string>>(
    who: string | undefined,
    handler: (req: Request, ctx: { params: P }) => Promise<Response>,
    opts: { method?: string; body?: unknown; params?: P; query?: string } = {},
  ): Promise<{ status: number; body: Body }> {
    g.__who = who;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (who && jar[who]) headers.cookie = `neo_admin_mfa=${jar[who]}`;
    const res = await handler(
      new Request(`https://www.neoconference.app/api/admin/x${opts.query ?? ""}`, {
        method: opts.method ?? "GET",
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      }),
      { params: (opts.params ?? {}) as P },
    );
    const m = res.headers.get("set-cookie")?.match(/neo_admin_mfa=([^;]*)/);
    if (m && who) jar[who] = decodeURIComponent(m[1]);
    const text = await res.text();
    let body: Body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { text };
    }
    return { status: res.status, body };
  }
  const code = (who: string) => mfa.totpAt(mfa.base32Decode(secrets[who]), mfa.currentStep());
  async function enrollAndVerify(who: string) {
    const e = await call(who, R.enroll.POST, { method: "POST" });
    assert.equal(e.status, 200, JSON.stringify(e.body));
    secrets[who] = e.body.secret as string;
    tick();
    const c = await call(who, R.confirmMfa.POST, { method: "POST", body: { code: code(who) } });
    assert.equal(c.status, 200, JSON.stringify(c.body));
  }
  async function stepUp(who: string) {
    tick();
    const v = await call(who, R.verify.POST, { method: "POST", body: { code: code(who) } });
    assert.equal(v.status, 200, JSON.stringify(v.body));
  }
  type SendBody = { send: { id: string; status: string; counts: { recipients: number; sent: Record<string, number>; skipped: Record<string, number>; unknown: Record<string, number>; failed: Record<string, number> } }; preview: { count: number; exact: boolean; sample: { uid: string; email: string }[]; unmatched: string[]; groups: unknown[] }; channels: { email: { subject: string; html: string; text: string } | null; inApp: { title: string; body: string } | null }; needsStepUp: boolean };
  async function draft(who: string, body: Record<string, unknown>) {
    const r = await call(who, R.sends.POST, { method: "POST", body: { kind: "announcement", title: "Hello", body: "A message.", channels: { inApp: true }, ...body } });
    return r as unknown as { status: number; body: SendBody & Body };
  }
  const audiences = async (audience: unknown) => {
    const r = await draft("user_comms", { audience });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.preview;
  };
  const statusOf = async (id: string, chunk: number, uid: string) =>
    JSON.parse(String((g.__kvStore.get(`neo:comms:send:${id}:st:${chunk}`) as Record<string, string>)[uid]));
  const auditOf = async (action: string) => (await audit.listAdminAudit({ action })).items;

  /* ------------------------------------------------------------------ */
  console.log("permissions");
  let commsRole = "";
  await t("only an administrator with notifications:send reaches any communication route", async () => {
    await enrollAndVerify("user_owner");
    const role = await call("user_owner", R.roles.POST, { method: "POST", body: { name: "Comms", permissions: ["notifications:send"] } });
    assert.equal(role.status, 201, JSON.stringify(role.body));
    commsRole = (role.body.role as { id: string }).id;
    assert.equal((await call("user_owner", R.team.POST, { method: "POST", body: { email: "comms@example.com", roleId: commsRole } })).status, 201);
    assert.equal((await call("user_owner", R.team.POST, { method: "POST", body: { email: "help@example.com", roleId: "support" } })).status, 201);
    await enrollAndVerify("user_comms");
    await enrollAndVerify("user_help");

    const id = { id: "snd_x" };
    const tid = { id: "group.scheduled" };
    const routes: Array<[string, (req: Request, ctx: { params: never }) => Promise<Response>, string, unknown?]> = [
      ["sends GET", R.sends.GET as never, "GET"],
      ["sends POST", R.sends.POST as never, "POST", id],
      ["send GET", R.send.GET as never, "GET", id],
      ["send DELETE", R.send.DELETE as never, "DELETE", id],
      ["confirm", R.confirm.POST as never, "POST", id],
      ["control", R.control.POST as never, "POST", id],
      ["process", R.process.POST as never, "POST", id],
      ["recipients", R.recipients.GET as never, "GET", id],
      ["templates", R.templates.GET as never, "GET"],
      ["template GET", R.template.GET as never, "GET", tid],
      ["template PUT", R.template.PUT as never, "PUT", tid],
      ["revert", R.revert.POST as never, "POST", tid],
      ["test send", R.test.POST as never, "POST", tid],
      ["delivery", R.delivery.GET as never, "GET"],
      ["reminders GET", R.reminders.GET as never, "GET"],
      ["reminders PUT", R.reminders.PUT as never, "PUT"],
    ];
    for (const [name, h, method, params] of routes) {
      const r = await call("user_help", h, { method, params: params as never, body: method === "GET" || method === "DELETE" ? undefined : {} });
      assert.equal(r.body.error, "forbidden", `${name}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.permission, "notifications:send", name);
      assert.equal((await call(undefined, h, { method, params: params as never })).status, 401, `${name} signed out`);
    }
    // Looking up a person's preferences is a users:read matter.
    assert.equal((await call("user_comms", R.prefs.GET, { query: "?user=a@example.com" })).body.error, "forbidden");
    assert.equal((await call("user_help", R.prefs.GET, { query: "?user=a@example.com" })).status, 200);
  });

  /* ------------------------------------------------------------------ */
  console.log("audience");
  await t("plan, account status and sign-up date pick exactly the matching accounts", async () => {
    const free = await audiences({ kind: "filter", plans: ["free"], statuses: ["active"] });
    assert.deepEqual(free.sample.map((s) => s.uid).sort(), ["u_a", "u_f"]);
    assert.equal(free.count, 2);
    assert.equal(free.exact, true);
    assert.deepEqual((await audiences({ kind: "filter", statuses: ["suspended"] })).sample.map((s) => s.uid), ["u_b"]);
    assert.deepEqual((await audiences({ kind: "filter", statuses: ["locked"] })).sample.map((s) => s.uid), ["u_e"]);
    assert.deepEqual((await audiences({ kind: "filter", plans: ["pro"] })).sample.map((s) => s.uid).sort(), ["u_c", "u_d"]);
    const range = await audiences({ kind: "filter", signedUpFrom: "2026-04-15", signedUpTo: "2026-06-01" });
    assert.deepEqual(range.sample.map((s) => s.uid), ["u_c"]);
    const owner = await audiences({ kind: "filter", plans: ["enterprise"] });
    assert.deepEqual(owner.sample.map((s) => s.uid), ["user_owner"], "the owner counts as enterprise whatever the account says");
  });

  await t("named people and group members resolve; names that match nobody are reported", async () => {
    const named = await audiences({ kind: "users", users: ["A@example.com", "u_c", "nobody@example.com", "user_missing"] });
    assert.equal(named.count, 2);
    assert.deepEqual(named.sample.map((s) => s.uid).sort(), ["u_a", "u_c"]);
    assert.deepEqual(named.unmatched.sort(), ["nobody@example.com", "user_missing"]);
    const choir = await groups.createGroup({ name: "Choir" }, { userId: "u_c", name: "Cy" }, [{ userId: "u_d", name: "Di" }, { userId: "u_b", name: "B" }]);
    const viaGroup = await audiences({ kind: "groups", groupIds: [choir.id, "gone"], statuses: ["active"] });
    assert.deepEqual(viaGroup.sample.map((s) => s.uid).sort(), ["u_c", "u_d"], "the banned member is filtered out");
    assert.deepEqual(viaGroup.unmatched, ["group gone"]);
    assert.deepEqual(viaGroup.groups, [{ id: choir.id, name: "Choir" }, { id: "gone", missing: true }]);
    assert.equal((await draft("user_comms", { audience: { kind: "filter" } })).body.error, "invalid_audience");
    assert.equal((await draft("user_comms", { audience: { kind: "everyone" }, channels: {} })).body.error, "invalid_message");
    assert.equal((await draft("user_comms", { audience: { kind: "everyone" }, url: "https://evil.test/" })).body.error, "invalid_message");
  });

  /* ------------------------------------------------------------------ */
  console.log("preview and confirm");
  let s1 = "";
  await t("a draft shows each channel's exact message, safely formatted, and sends nothing", async () => {
    const before = mails.length;
    const r = await draft("user_comms", {
      title: "Maintenance <b>Saturday</b>",
      body: "Hello **all**\n\n<script>alert(1)</script>\n\nSee <img src=x onerror=alert(1)> *here*\n\n- one\n- [docs](javascript:alert(1))\n- [pricing](/pricing)",
      channels: { email: true, inApp: true },
      audience: { kind: "filter", plans: ["free"], statuses: ["active"] },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    s1 = r.body.send.id;
    const html = r.body.channels.email!.html;
    assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;") && !html.includes("<script"));
    assert.ok(html.includes("Maintenance &lt;b&gt;Saturday&lt;/b&gt;"));
    assert.ok(html.includes("<strong>all</strong>") && html.includes("<li>one</li>"));
    assert.ok(!/href="javascript/i.test(html), "javascript: links stay text");
    assert.ok(html.includes('href="https://www.neoconference.app/pricing"'));
    assert.equal(r.body.channels.email!.subject, "Maintenance <b>Saturday</b>");
    assert.match(r.body.channels.inApp!.body, /^Hello all /);
    assert.ok(!html.includes("<img") && html.includes("See &lt;img src=x onerror=alert(1)&gt; <em>here</em>"), "text before a formatting mark is escaped too");
    assert.equal(r.body.needsStepUp, false);
    assert.equal(mails.length, before, "a draft sends nothing");
    assert.equal((await notif.listNotifications("u_a")).items.length, 0);
  });

  await t("confirming needs the count the preview showed; then it goes out once, to the right people", async () => {
    const before = mails.length;
    assert.equal((await call("user_comms", R.confirm.POST, { method: "POST", params: { id: s1 }, body: {} })).body.error, "preview_required");
    assert.equal((await call("user_comms", R.confirm.POST, { method: "POST", params: { id: s1 }, body: { count: 7 } })).body.error, "preview_required");
    assert.equal(mails.length, before, "refused confirmations send nothing");
    const ok = await call("user_comms", R.confirm.POST, { method: "POST", params: { id: s1 }, body: { count: 2 } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const send = ok.body.send as SendBody["send"];
    assert.equal(send.status, "done");
    assert.deepEqual(send.counts.sent, { email: 1, inApp: 2, push: 0 });
    assert.equal(send.counts.skipped.email, 1, "Noel has no email address");
    const items = lastBatch();
    assert.equal(items.length, 1);
    assert.deepEqual(items[0].to, ["a@example.com"]);
    assert.match(items[0].headers!["List-Unsubscribe"], /^<https:\/\/www\.neoconference\.app\/api\/comms\/unsubscribe\?t=/);
    assert.equal(items[0].headers!["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
    assert.ok(batches().at(-1)!.headers["idempotency-key"]?.startsWith(`comms-${s1}-0-`));
    const bell = (await notif.listNotifications("u_a")).items;
    assert.equal(bell.length, 1);
    assert.equal(bell[0].type, "announcement");
    assert.equal(bell[0].title, "Maintenance <b>Saturday</b>", "the bell shows text, never HTML");
    assert.equal((await statusOf(s1, 0, "u_f")).ch.email.r, "no_email");
    assert.equal((await call("user_comms", R.confirm.POST, { method: "POST", params: { id: s1 }, body: { count: 2 } })).body.error, "already_confirmed");
    const [entry] = await auditOf("comms.send");
    assert.equal(entry.actorEmail, "comms@example.com");
    assert.equal(entry.targetId, s1);
    const after = entry.after as Record<string, unknown>;
    assert.equal(after.recipients, 2);
    assert.equal(after.audience, "plan free, status active");
    assert.deepEqual(after.channels, { email: true, inApp: true, push: false });
  });

  await t("everyone, or more than 500 people, needs a fresh authenticator code to confirm", async () => {
    assert.equal(sends.needsStepUp({ audience: { kind: "filter" }, preview: { count: 501, exact: true, withEmail: 0 } }), true);
    assert.equal(sends.needsStepUp({ audience: { kind: "filter" }, preview: { count: 500, exact: true, withEmail: 0 } }), false);
    assert.equal(sends.needsStepUp({ audience: { kind: "filter" }, preview: { count: 3, exact: false, withEmail: 0 } }), true);
    const r = await draft("user_comms", { audience: { kind: "everyone" }, title: "To all" });
    assert.equal(r.body.needsStepUp, true);
    tick(11 * 60_000);
    const stale = await call("user_comms", R.confirm.POST, { method: "POST", params: { id: r.body.send.id }, body: { count: r.body.preview.count } });
    assert.equal(stale.body.error, "step_up_required");
    assert.equal((await sends.getSend(r.body.send.id))!.status, "draft");
    await stepUp("user_comms");
    const ok = await call("user_comms", R.confirm.POST, { method: "POST", params: { id: r.body.send.id }, body: { count: r.body.preview.count } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal((ok.body.send as SendBody["send"]).counts.sent.inApp, 9);
  });

  /* ------------------------------------------------------------------ */
  console.log("send job");
  await t("running a finished send again sends nobody anything twice", async () => {
    const mailsBefore = mails.length;
    const bellBefore = (await notif.listNotifications("u_a")).items.length;
    const s = (await sends.getSend(s1))!;
    g.__kvStore.set(`neo:comms:send:${s1}`, JSON.stringify({ ...s, status: "sending", nextChunk: 0 }));
    await sends.processSend(s1);
    assert.equal(mails.length, mailsBefore);
    assert.equal((await notif.listNotifications("u_a")).items.length, bellBefore);
    assert.equal((await sends.getSend(s1))!.status, "done");
    assert.deepEqual((await sends.getSend(s1))!.counts.sent, s.counts.sent, "counts unchanged");
  });

  await t("a worker that died after claiming a recipient leaves them 'unknown', not sent again", async () => {
    const mailsBefore = mails.length;
    const st = g.__kvStore.get(`neo:comms:send:${s1}:st:0`) as Record<string, string>;
    delete st.u_a; // the claim stays, the outcome was never written
    const s = (await sends.getSend(s1))!;
    g.__kvStore.set(`neo:comms:send:${s1}`, JSON.stringify({ ...s, status: "sending", nextChunk: 0 }));
    await sends.processSend(s1);
    const ua = await statusOf(s1, 0, "u_a");
    assert.equal(ua.ch.email.s, "unknown");
    assert.equal(ua.ch.inApp.s, "unknown");
    assert.equal(mails.length, mailsBefore);
    assert.equal((await sends.getSend(s1))!.counts.unknown.email, 1);
  });

  await t("listing the recipients again after a crash puts nobody in a second block", async () => {
    const mailsBefore = mails.length;
    const s = (await sends.getSend(s1))!;
    // Died after writing the blocks but before saving how far the listing got.
    g.__kvStore.set(`neo:comms:send:${s1}`, JSON.stringify({ ...s, status: "sending", resolve: { cursor: 0, done: false, scanned: 0 } }));
    await sends.processSend(s1);
    const after = (await sends.getSend(s1))!;
    assert.equal(after.status, "done");
    assert.equal(after.chunks, s.chunks, "no new block");
    assert.equal(after.counts.recipients, s.counts.recipients);
    assert.equal(mails.length, mailsBefore);
  });

  await t("one worker at a time: a held lease makes a second worker step back", async () => {
    g.__kvStore.set(`neo:comms:send:${s1}:lease`, "someone-else");
    assert.equal((await sends.processSend(s1)).locked, true);
    g.__kvStore.delete(`neo:comms:send:${s1}:lease`);
  });

  await t("a refused batch marks each recipient failed with Resend's reason", async () => {
    mailFail = "The domain is not verified";
    const r = await draft("user_comms", { audience: { kind: "users", users: ["u_e"] }, channels: { email: true } });
    const ok = await call("user_comms", R.confirm.POST, { method: "POST", params: { id: r.body.send.id }, body: { count: 1 } });
    mailFail = null;
    const sent = ok.body.send as SendBody["send"];
    assert.equal(sent.counts.failed.email, 1);
    const detail = await call("user_comms", R.send.GET, { params: { id: r.body.send.id } });
    assert.deepEqual(
      (detail.body.failures as { email: string; reason: string }[]).map((f) => [f.email, f.reason]),
      [["e@example.com", "The domain is not verified"]],
    );
  });

  /* ------------------------------------------------------------------ */
  console.log("pause, resume, cancel");
  for (let i = 0; i < 230; i++) {
    g.__users[`bulk_${String(i).padStart(3, "0")}`] = { emails: [`bulk${i}@example.com`], plan: "starter", createdAt: D("2026-06-01") + i };
  }
  const bulkBell = async (from: number, to: number) => {
    let total = 0;
    for (let i = from; i < to; i++) total += (await notif.listNotifications(`bulk_${String(i).padStart(3, "0")}`)).items.length;
    return total;
  };
  await t("a scheduled send waits; paused it stops between blocks; resumed it finishes", async () => {
    const r = await draft("user_comms", { audience: { kind: "filter", plans: ["starter"] }, startsAt: Date.now() + 60_000, title: "Bulk one" });
    assert.equal(r.body.preview.count, 230);
    const id = r.body.send.id;
    const c = await call("user_comms", R.confirm.POST, { method: "POST", params: { id }, body: { count: 230 } });
    assert.equal((c.body.progress as { waiting?: string }).waiting, "scheduled");
    assert.equal(await bulkBell(0, 230), 0, "not before its start time");
    tick(61_000);
    await sends.processSend(id, 8_000, 2); // list the recipients, deliver the first block
    let s = (await sends.getSend(id))!;
    assert.equal(s.counts.recipients, 230);
    assert.equal(s.counts.sent.inApp, 100);
    const p = await call("user_comms", R.control.POST, { method: "POST", params: { id }, body: { action: "pause" } });
    assert.equal((p.body.send as { status: string }).status, "paused");
    await sends.processSend(id);
    await sends.runCommsDispatch();
    assert.equal((await sends.getSend(id))!.counts.sent.inApp, 100, "nothing more while paused");
    const rs = await call("user_comms", R.control.POST, { method: "POST", params: { id }, body: { action: "resume" } });
    assert.equal(rs.status, 200);
    s = (await sends.getSend(id))!;
    assert.equal(s.status, "done");
    assert.equal(s.counts.sent.inApp, 230);
    assert.equal(await bulkBell(0, 230), 230, "each exactly once");
    const page = await call("user_comms", R.recipients.GET, { params: { id }, query: "?chunk=2" });
    assert.equal((page.body.items as unknown[]).length, 30);
    assert.equal((await call("user_comms", R.control.POST, { method: "POST", params: { id }, body: { action: "cancel" } })).body.error, "not_now");
    const actions = (await audit.listAdminAudit({ target: id })).items.map((e) => e.action);
    assert.ok(actions.includes("comms.pause") && actions.includes("comms.resume") && actions.includes("comms.send"));
  });

  await t("a cancelled send delivers nothing more", async () => {
    const r = await draft("user_comms", { audience: { kind: "filter", plans: ["starter"] }, startsAt: Date.now() + 60_000, title: "Bulk two" });
    const id = r.body.send.id;
    await call("user_comms", R.confirm.POST, { method: "POST", params: { id }, body: { count: 230 } });
    tick(61_000);
    await sends.processSend(id, 8_000, 2);
    const c = await call("user_comms", R.control.POST, { method: "POST", params: { id }, body: { action: "cancel" } });
    assert.equal((c.body.send as { status: string }).status, "cancelled");
    await sends.processSend(id);
    await call("user_comms", R.process.POST, { method: "POST", params: { id } });
    await sends.runCommsDispatch();
    assert.equal((await sends.getSend(id))!.counts.sent.inApp, 100);
    assert.equal(await bulkBell(0, 230), 330);
  });

  /* ------------------------------------------------------------------ */
  console.log("preferences");
  await t("people turn optional categories off per channel; there is no switch for transactional mail", async () => {
    const mine = await call("u_d", R.myPrefs.GET as never);
    assert.deepEqual(Object.keys((mine.body.prefs as { categories: object }).categories), ["announcements", "product", "reminders"]);
    const off = { email: false, inApp: false, push: false };
    const put = await call("u_d", R.myPrefs.PUT, { method: "PUT", body: { announcements: off, product: off, reminders: off, transactional: off, security: off } });
    assert.equal(put.status, 200);
    const p = put.body.prefs as { categories: Record<string, unknown>; updatedVia: string };
    assert.deepEqual(Object.keys(p.categories), ["announcements", "product", "reminders"], "no transactional or security switch exists");
    assert.equal(p.updatedVia, "settings");
    assert.equal((await call(undefined, R.myPrefs.GET as never)).status, 401);
  });

  await t("an announcement skips someone who turned it off; a service notice and transactional mail still reach them", async () => {
    await saveDevice("u_c");
    await saveDevice("u_d");
    const pushed: string[] = [];
    push.__setPushSender(async (sub) => {
      pushed.push(sub.endpoint);
      return { statusCode: 201 };
    });
    const ann = await draft("user_comms", { audience: { kind: "users", users: ["u_c", "u_d"] }, channels: { email: true, inApp: true, push: true }, title: "News" });
    await call("user_comms", R.confirm.POST, { method: "POST", params: { id: ann.body.send.id }, body: { count: 2 } });
    assert.deepEqual(lastBatch().map((m) => m.to[0]), ["c@example.com"]);
    assert.deepEqual(pushed, ["https://push.example.com/u_c"]);
    const ud = await statusOf(ann.body.send.id, 0, "u_d");
    assert.deepEqual([ud.ch.email.r, ud.ch.inApp.r, ud.ch.push.r], ["opted_out", "opted_out", "opted_out"]);

    const svc = await draft("user_comms", { kind: "service", audience: { kind: "users", users: ["u_d"] }, channels: { email: true, inApp: true }, title: "Outage tonight" });
    assert.ok(!svc.body.channels.email!.html.includes("Unsubscribe"), "a service notice has no unsubscribe link");
    await call("user_comms", R.confirm.POST, { method: "POST", params: { id: svc.body.send.id }, body: { count: 1 } });
    assert.deepEqual(lastBatch().map((m) => m.to[0]), ["d@example.com"]);
    assert.equal(lastBatch()[0].headers?.["List-Unsubscribe"], undefined);
    assert.equal((await notif.listNotifications("u_d")).items[0].title, "Outage tonight");

    const before = singles().length;
    await groupNotify.notifyInvitees(ev(), [{ name: "Di", userId: "u_d", email: "d@example.com" }], "scheduled", nctx, { kingschat: false, inApp: false, push: false });
    assert.equal(singles().length, before + 1);
    assert.deepEqual((singles().at(-1)!.body as { bcc: string[] }).bcc, ["d@example.com"], "a meeting invitation ignores preferences");
    push.__setPushSender(null);
  });

  await t("an administrator can see a person's choices", async () => {
    const r = await call("user_help", R.prefs.GET, { query: "?user=d@example.com" });
    assert.equal((r.body.user as { id: string }).id, "u_d");
    const p = r.body.prefs as { categories: Record<string, Record<string, boolean>>; updatedVia: string };
    assert.equal(p.categories.announcements.email, false);
    assert.equal(p.updatedVia, "settings");
    assert.equal((await call("user_help", R.prefs.GET, { query: "?user=nobody@example.com" })).status, 404);
  });

  /* ------------------------------------------------------------------ */
  console.log("unsubscribe");
  const s1Mail = batches().find((b) => (b.body as BatchItem[]).some((i) => i.to[0] === "a@example.com"))!;
  const unsubUrl = (s1Mail.body as BatchItem[])[0].headers!["List-Unsubscribe"].slice(1, -1);
  const token = new URL(unsubUrl).searchParams.get("t")!;
  const raw = async (h: (req: Request) => Promise<Response>, url: string, init: RequestInit = {}) => {
    g.__who = undefined;
    return h(new Request(url, init));
  };
  const form = (o: Record<string, string>) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o).toString() });
  await t("the one-click link works signed out and turns off only that category's email", async () => {
    const r = await raw(R.unsub.POST, unsubUrl, form({ "List-Unsubscribe": "One-Click" }));
    assert.equal(r.status, 200);
    const p = await prefsLib.getPrefs("u_a");
    assert.equal(p.categories.announcements.email, false);
    assert.equal(p.categories.announcements.inApp, true);
    assert.equal(p.categories.product.email, true);
    assert.equal(p.updatedVia, "unsubscribe_link");
    const mw = readFileSync(join(process.cwd(), "src", "middleware.ts"), "utf8");
    for (const path of ["'/unsubscribe'", "'/api/comms/unsubscribe'", "'/api/comms/resend-webhook'"]) assert.ok(mw.includes(path), `${path} is public`);
  });

  await t("a tampered or re-aimed token is refused; opening the link changes nothing; the page can undo it", async () => {
    const bad = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    assert.equal((await raw(R.unsub.POST, `https://www.neoconference.app/api/comms/unsubscribe?t=${encodeURIComponent(bad)}`, { method: "POST" })).status, 400);
    const other = token.replace(".announcements.", ".product.");
    assert.equal((await raw(R.unsub.POST, `https://www.neoconference.app/api/comms/unsubscribe?t=${encodeURIComponent(other)}`, { method: "POST" })).status, 400);
    const forged = `${Buffer.from("u_c").toString("base64url")}.announcements.${token.split(".")[2]}`;
    assert.equal(prefsLib.readUnsubscribeToken(forged), null, "a signature is for one account only");
    assert.equal(prefsLib.readUnsubscribeToken(token)?.uid, "u_a");

    await prefsLib.updatePrefs("u_a", { announcements: { email: true } }, "settings");
    const get = await raw(R.unsub.GET, unsubUrl);
    assert.equal(get.status, 303);
    assert.match(get.headers.get("location")!, /\/unsubscribe\?t=/);
    assert.equal((await prefsLib.getPrefs("u_a")).categories.announcements.email, true, "a link scanner's GET unsubscribes nobody");

    const viaPage = await raw(R.unsub.POST, "https://www.neoconference.app/api/comms/unsubscribe", form({ t: token, from: "page", action: "unsubscribe" }));
    assert.equal(viaPage.status, 303);
    assert.match(viaPage.headers.get("location")!, /done=unsubscribed$/);
    assert.equal((await prefsLib.getPrefs("u_a")).categories.announcements.email, false);
    const undo = await raw(R.unsub.POST, "https://www.neoconference.app/api/comms/unsubscribe", form({ t: token, from: "page", action: "resubscribe" }));
    assert.match(undo.headers.get("location")!, /done=resubscribed$/);
    assert.equal((await prefsLib.getPrefs("u_a")).categories.announcements.email, true);
  });

  /* ------------------------------------------------------------------ */
  console.log("delivery reports");
  const secret = "whsec_" + randomBytes(24).toString("base64");
  const report = (type: string, emailId: string, extra: Record<string, unknown> = {}, opts: { id?: string; ts?: number; sign?: string } = {}) => {
    const body = JSON.stringify({ type: `email.${type}`, created_at: new Date().toISOString(), data: { email_id: emailId, to: ["x@example.com"], subject: "s", ...extra } });
    const id = opts.id ?? `msg_${randomBytes(6).toString("hex")}`;
    const ts = opts.ts ?? Math.floor(Date.now() / 1000);
    const sig = webhook.signWebhook(opts.sign ?? secret, id, ts, body);
    return { id, body, init: { method: "POST", headers: { "svix-id": id, "svix-timestamp": String(ts), "svix-signature": `v1,bogus ${sig}` }, body } };
  };
  const hook = (init: RequestInit) => raw(R.hook.POST, "https://www.neoconference.app/api/comms/resend-webhook", init);
  await t("without RESEND_WEBHOOK_SECRET reports are refused and the screens say so", async () => {
    const r = await hook(report("delivered", "re_1").init);
    assert.equal(r.status, 503);
    const d = await call("user_comms", R.delivery.GET);
    assert.equal(d.body.webhook, false);
    assert.equal(d.body.webhookUrl, "https://www.neoconference.app/api/comms/resend-webhook");
    process.env.RESEND_WEBHOOK_SECRET = secret;
  });

  await t("a signed report updates that recipient once; bad, stale or unsigned reports are refused", async () => {
    // The announcement to c@ (the "News" send) and its message id.
    const news = (await sends.listSends("News"))[0];
    const cEmail = (await statusOf(news.id, 0, "u_c")).ch.email;
    assert.equal(cEmail.s, "sent");
    const ok = report("delivered", cEmail.id);
    assert.equal((await hook(ok.init)).status, 200);
    assert.equal((await statusOf(news.id, 0, "u_c")).ch.email.s, "delivered");
    assert.equal((await sends.webhookCounts(news.id)).delivered, 1);
    const again = await hook(ok.init);
    assert.equal(((await again.json()) as { duplicate?: boolean }).duplicate, true);
    assert.equal((await sends.webhookCounts(news.id)).delivered, 1);

    assert.equal((await hook(report("delivered", cEmail.id, {}, { sign: "whsec_" + randomBytes(24).toString("base64") }).init)).status, 401);
    assert.equal((await hook(report("delivered", cEmail.id, {}, { ts: Math.floor(Date.now() / 1000) - 600 }).init)).status, 401);
    assert.equal((await hook({ method: "POST", body: ok.body })).status, 401);
    const tampered = report("delivered", cEmail.id);
    assert.equal((await hook({ ...tampered.init, body: tampered.body.replace("delivered", "bounced") })).status, 401);
  });

  await t("a bounce is listed with its reason and the address is skipped next time; a complaint turns email off", async () => {
    const news = (await sends.listSends("News"))[0];
    const cEmail = (await statusOf(news.id, 0, "u_c")).ch.email;
    const b = report("bounced", cEmail.id, { to: ["c@example.com"], bounce: { type: "Permanent", message: "Mailbox does not exist" } });
    assert.equal((await hook(b.init)).status, 200);
    assert.equal((await statusOf(news.id, 0, "u_c")).ch.email.s, "bounced");
    assert.ok((await sends.listFailures(news.id)).some((f) => f.reason === "bounced: Mailbox does not exist"));
    assert.equal(await logLib.isBounced("c@example.com"), true);
    const next = await draft("user_comms", { audience: { kind: "users", users: ["u_c"] }, channels: { email: true }, title: "Again" });
    await call("user_comms", R.confirm.POST, { method: "POST", params: { id: next.body.send.id }, body: { count: 1 } });
    assert.equal((await statusOf(next.body.send.id, 0, "u_c")).ch.email.r, "bounced_before");

    const cpl = report("complained", cEmail.id);
    assert.equal((await hook(cpl.init)).status, 200);
    const p = await prefsLib.getPrefs("u_c");
    assert.deepEqual([p.categories.announcements.email, p.categories.product.email, p.categories.reminders.email], [false, false, false]);
    assert.equal(p.updatedVia, "complaint");
    const d = await call("user_comms", R.delivery.GET, { query: "?event=bounced" });
    assert.deepEqual((d.body.events as { type: string; reason: string }[]).map((e) => [e.type, e.reason]), [["bounced", "Mailbox does not exist"]]);
  });

  /* ------------------------------------------------------------------ */
  console.log("email templates");
  await t("every default renders the wording the code sent before templates", async () => {
    for (const kind of ["scheduled", "updated", "cancelled", "started", "added"] as const) {
      for (const events of [[ev()], [ev(), ev({ id: "e2", slug: "choir-2", scheduledAt: "2026-11-05T09:00:00Z" })]]) {
        for (const description of ["", "Bring <notes> & \"music\" — it's Ann's turn"]) {
          const evs = events.map((e) => ({ ...e, description }));
          const r = await tpl.renderEmail(`group.${kind}`, groupNotify.emailVars(evs, kind, nctx));
          const legacy = legacyGroupEmail(groupNotify.wording, evs, kind, nctx);
          assert.equal(r.subject, legacy.subject, `${kind} subject`);
          assert.equal(r.html, legacy.html, `${kind} html (${events.length}, ${description ? "desc" : "none"})`);
          assert.equal(r.text, legacy.text, `${kind} text`);
        }
      }
    }
    for (const count of [1, 3]) {
      const lines = "Sunday\n  - Ann (2026-10-09T09:00:00Z)";
      const r = await tpl.renderEmail("digest.redemptions", { count, plural: count === 1 ? "" : "s", details: lines });
      assert.equal(r.subject, "NeoConference — " + count + " new redemption" + (count === 1 ? "" : "s") + " today");
      assert.equal(r.text, "NeoConference daily digest\n\n" + count + " redemption" + (count === 1 ? "" : "s") + " in the last 24h:\n\n" + lines);
      assert.equal(r.html, "");
    }
    // The appointment emails sent at the start of this file, through the real route.
    const appointed = singles().filter((m) => (m.body as { subject: string }).subject === "You are now a NeoConference administrator");
    assert.equal(appointed.length, 2);
    const body = appointed[0].body as { to: string[]; text: string; html: string };
    const origin = "https://www.neoconference.app";
    assert.deepEqual(body.to, ["comms@example.com"]);
    assert.equal(
      body.text,
      `Owner made you an administrator (Comms) on NeoConference.\n\nOpen ${origin}/admin and set up two-factor authentication with an authenticator app to start.\n\nIf you did not expect this, reply to this email.`,
    );
    assert.equal(
      body.html,
      `<p>Owner made you an administrator (<b>Comms</b>) on NeoConference.</p><p><a href="${origin}/admin">Open the admin area</a> and set up two-factor authentication with an authenticator app to start.</p><p>If you did not expect this, reply to this email.</p>`,
    );
  });

  await t("group notices go out through the template, byte for byte as before", async () => {
    const before = singles().length;
    const events = [ev({ description: "Bring <notes>" })];
    await groupNotify.notifyInvitees(events, [{ name: "Ann", userId: "u_a", email: "a@example.com" }], "scheduled", nctx, { kingschat: false, inApp: false, push: false });
    const sent = singles()[before].body as { to: string[]; bcc: string[]; subject: string; html: string; text: string; attachments: unknown[] };
    const legacy = legacyGroupEmail(groupNotify.wording, events, "scheduled", nctx);
    assert.deepEqual([sent.subject, sent.html, sent.text], [legacy.subject, legacy.html, legacy.text]);
    assert.deepEqual(sent.to, ["hello@neo.test"]);
    assert.deepEqual(sent.bcc, ["a@example.com"]);
    assert.equal(sent.attachments.length, 1, "the calendar file still goes with it");
    const log = await logLib.listLog({ q: "group.scheduled" });
    assert.equal(log[0].status, "sent");
    assert.equal(log[0].to, "1 recipient (bcc)");
  });

  await t("an edit is checked, versioned, audited with before and after, used at once, and can be reverted", async () => {
    const id = { id: "group.scheduled" };
    const put = (body: Record<string, unknown>) => call("user_comms", R.template.PUT, { method: "PUT", params: id, body });
    const cur = (await call("user_comms", R.template.GET, { params: id })).body.active as { subject: string; html: string; text: string };
    assert.match(String((await put({ ...cur, subject: "Invite {{nope}}" })).body.message), /\{\{nope\}\}/);
    assert.equal((await put({ ...cur, html: cur.html + "<script>x()</script>" })).body.error, "invalid_template");
    assert.equal((await put({ ...cur, html: '<a href="{{link}}" onclick="x()">x</a>' })).body.error, "invalid_template");
    assert.equal((await put({ ...cur, text: "{{#series}}open" })).body.error, "invalid_template");
    const ok = await put({ ...cur, subject: "You're invited: {{title}}", note: "Friendlier" });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal((ok.body.active as { version: number }).version, 1);

    const before = singles().length;
    await groupNotify.notifyInvitees(ev(), [{ name: "Ann", userId: "u_a", email: "a@example.com" }], "scheduled", nctx, { kingschat: false, inApp: false, push: false });
    assert.equal((singles()[before].body as { subject: string }).subject, "You're invited: Choir practice");
    const [e] = await auditOf("template.update");
    assert.equal((e.before as { subject: string }).subject, "Invitation: {{title}}{{many}}");
    assert.equal((e.after as { subject: string }).subject, "You're invited: {{title}}");
    assert.equal(e.note, "Friendlier");

    assert.equal((await call("user_comms", R.revert.POST, { method: "POST", params: id, body: { version: 0 } })).status, 200);
    await groupNotify.notifyInvitees(ev(), [{ name: "Ann", userId: "u_a", email: "a@example.com" }], "scheduled", nctx, { kingschat: false, inApp: false, push: false });
    assert.equal((singles().at(-1)!.body as { subject: string }).subject, legacyGroupEmail(groupNotify.wording, [ev()], "scheduled", nctx).subject);
    const back = await call("user_comms", R.revert.POST, { method: "POST", params: id, body: { version: 1 } });
    assert.equal((back.body.active as { version: number; revertedFrom: number }).version, 2);
    const detail = await call("user_comms", R.template.GET, { params: id });
    assert.deepEqual((detail.body.history as { version: number; revertedFrom?: number }[]).map((v) => [v.version, v.revertedFrom ?? null]), [[2, 1], [1, null]]);
    const reverts = await auditOf("template.revert");
    assert.equal(reverts.length, 2);
    assert.equal((reverts[1].after as { version: number }).version, 0);
  });

  await t("a test send goes only to the administrator, filled with sample data", async () => {
    const before = singles().length;
    const r = await call("user_comms", R.test.POST, { method: "POST", params: { id: "reminder.meetings" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(singles().length, before + 1);
    const m = singles().at(-1)!.body as { to: string[]; subject: string; bcc?: string[] };
    assert.deepEqual(m.to, ["comms@example.com"]);
    assert.equal(m.bcc, undefined);
    assert.equal(m.subject, "[Test] You've used 4 of your 5 meetings");
    const unsaved = await call("user_comms", R.test.POST, { method: "POST", params: { id: "admin.appointed" }, body: { subject: "Hi {{roleName}}", text: "x", html: "" } });
    assert.equal(unsaved.status, 200);
    assert.equal((singles().at(-1)!.body as { subject: string }).subject, "[Test] Hi Support");
  });

  /* ------------------------------------------------------------------ */
  console.log("usage reminders");
  await t("off until turned on; then each threshold of the meeting cap is sent once", async () => {
    await plan.incrementMeetingsCreated("u_a"); // 3 -> 4: 80 %, but reminders are off
    assert.ok(!(await notif.listNotifications("u_a")).items.some((i) => i.type === "reminder"));
    const on = await call("user_comms", R.reminders.PUT, { method: "PUT", body: { meetings: { enabled: true, thresholds: [80, 100] } } });
    assert.equal(on.status, 200);
    assert.equal((await auditOf("comms.reminders"))[0].targetId, "reminders");
    g.__users.u_a.metadata = { meetingsCreated: 3 };
    const before = singles().length;
    await plan.incrementMeetingsCreated("u_a"); // 4 of 5
    let bell = (await notif.listNotifications("u_a")).items.filter((i) => i.type === "reminder");
    assert.deepEqual(bell.map((i) => i.title), ["You've used 4 of your 5 meetings"]);
    const mail = singles()[before].body as { to: string[]; subject: string; headers: Record<string, string> };
    assert.deepEqual(mail.to, ["a@example.com"]);
    assert.match(mail.headers["List-Unsubscribe"], /unsubscribe\?t=/);
    await plan.incrementMeetingsCreated("u_a"); // 5 of 5
    bell = (await notif.listNotifications("u_a")).items.filter((i) => i.type === "reminder");
    assert.equal(bell[0].title, "You've used all 5 meetings on the Free plan");
    const { meetingCapReminder } = await import("../comms/reminders");
    assert.equal(await meetingCapReminder("u_a", 5, 5, "free"), "already_sent");
  });

  await t("recording hours: a reminder once the month passes a threshold, on the channels the person allows", async () => {
    const { recordingReminder } = await import("../comms/reminders");
    assert.equal(await recordingReminder("u_c"), "off");
    await call("user_comms", R.reminders.PUT, { method: "PUT", body: { recording: { enabled: true } } });
    await recUsage.addRecordedSeconds("egress_1", Math.round(8.5 * 3600), Date.now(), "u_c");
    const r = await recordingReminder("u_c");
    assert.equal(r, "sent:80:opted_out/sent", "u_c complained earlier, so no reminder email");
    const bell = (await notif.listNotifications("u_c")).items.filter((i) => i.type === "reminder");
    assert.equal(bell[0].title, "85% of this month's recording hours used");
    assert.equal(await recordingReminder("u_c"), "already_sent");
  });

  console.log(`\n${n} checks passed`);
  process.exit(0);

  async function saveDevice(uid: string) {
    await push.saveSubscription(uid, { endpoint: `https://push.example.com/${uid}`, keys: { p256dh: "p", auth: "a" } }, "UA");
  }
}

const nctx = { senderUserId: "user_host", senderName: "Ada O'Neil", origin: "https://neo.test" };
function ev(over: Partial<NeoEvent> = {}): NeoEvent {
  return {
    id: "e1",
    slug: "choir-practice",
    name: "Choir practice",
    ownerUserId: "user_owner",
    visibility: "private",
    state: "scheduled",
    createdAt: "2026-10-01T10:00:00Z",
    updatedAt: "2026-10-01T10:00:00Z",
    scheduledAt: "2026-10-12T09:00:00Z",
    groupId: "g1",
    groupMeeting: { kind: "scheduled", durationMin: 60, timezone: "Africa/Lagos", createdBy: "user_host", sequence: 0 },
    ...over,
  } as NeoEvent;
}

/**
 * The group-notice email exactly as src/lib/groupNotify.ts built it before
 * templates existed (copied from main at 94e248c), to hold the defaults to.
 */
function legacyGroupEmail(
  wording: (events: NeoEvent[], kind: "scheduled" | "updated" | "cancelled" | "started" | "added", ctx: typeof nctx) => { subject: string; line: string },
  events: NeoEvent[],
  kind: "scheduled" | "updated" | "cancelled" | "started" | "added",
  ctx: typeof nctx,
) {
  const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  const { subject, line } = wording(events, kind, ctx);
  const link = `${ctx.origin.replace(/\/+$/, "")}/${events[0].slug}`;
  const html = [
    `<p style="font-family:system-ui,sans-serif;font-size:15px;color:#0f172a">${escapeHtml(line)}</p>`,
    kind === "cancelled"
      ? ""
      : `<p style="font-family:system-ui,sans-serif"><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 18px;border-radius:999px;background:#06b6d4;color:#020617;text-decoration:none;font-weight:600">Open the meeting</a></p>`,
    events[0].description
      ? `<p style="font-family:system-ui,sans-serif;font-size:14px;color:#334155;white-space:pre-line">${escapeHtml(events[0].description)}</p>`
      : "",
  ].join("");
  const text = kind === "cancelled" ? line : `${line}\n\n${link}`;
  return { subject, html, text };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
