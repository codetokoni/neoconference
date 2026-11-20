// Run: npx tsx src/lib/__tests__/meetingFeedback.smoke.ts
//
// Feedback on a meeting (src/lib/meetingFeedback.ts, 2026-11-20): from the
// feedback link, inside the meeting and after leaving, to support (one
// ticket a meeting a day) and to the owner (bell, and on a paid plan their
// KingsChat handle and email). Through the real routes — /feedback and the
// event PATCH — with Clerk, KV and the senders stood in for (./apiV1-stubs).

import assert from "node:assert/strict";
import "./apiV1-stubs/install";

Object.assign(process.env, {
  CLERK_SECRET_KEY: "sk_test_feedback",
  KV_REST_API_URL: "https://kv.invalid",
  KV_REST_API_TOKEN: "stub",
  PLATFORM_OWNER_EMAILS: "platform@example.com",
  ADMIN_EMAILS: "",
});

type Stubbed = typeof globalThis & {
  __users: Record<string, { plan?: string; emails?: string[]; first?: string; metadata?: Record<string, unknown> }>;
  __who?: string;
};
const g = globalThis as Stubbed;
g.__users = {
  user_owner: { plan: "pro", emails: ["owner@example.com"], first: "Victor" },
  user_free: { emails: ["free@example.com"], first: "Fola" },
  user_ada: { emails: ["ada@example.com"], first: "Ada" },
  user_pastor: { emails: ["pastor@example.com"], first: "Matthew", metadata: { kingschat: { id: "kc_pastor" } } },
  user_super: { emails: ["platform@example.com"], first: "Super" },
};

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
  const { NextRequest } = await import("next/server");
  const { kv } = await import("../kv");
  const { eventStore } = await import("../eventStore");
  const fb = await import("../meetingFeedback");
  const { issueFormToken } = await import("../support/formToken");
  const { getTicket, listMessages, listTickets } = await import("../support/tickets");
  const { listNotifications } = await import("../notificationStore");
  const { ERASE_STEPS } = await import("../dataGov/erase");
  const R = {
    feedback: await import("../../app/api/events/[id]/feedback/route"),
    event: await import("../../app/api/events/[id]/route"),
  };

  const sent: Array<{ via: "kc" | "mail"; to: string; text: string }> = [];
  fb.__setFeedbackSenders({
    kc: async (_from, to, text) => (sent.push({ via: "kc", to, text }), { ok: true }),
    mail: async (to, _subject, text) => (sent.push({ via: "mail", to, text }), { ok: true }),
  });

  const now = new Date().toISOString();
  const meeting = (slug: string, owner = "user_owner") =>
    eventStore.create({
      id: "ev_" + slug, slug, name: slug === "sa" ? "SA Regional Meeting" : slug, ownerUserId: owner,
      ownerEmail: `${owner}@example.com`, state: "live", visibility: "unlisted", livekitRoom: slug,
      waitingRoomEnabled: false, createdAt: now, updatedAt: now, roles: [],
    } as unknown as Parameters<typeof eventStore.create>[0]);
  const sa = await meeting("sa");
  const freeMeeting = await meeting("fola", "user_free");

  const call = async (
    who: string | undefined,
    handler: (req: InstanceType<typeof NextRequest>, ctx: { params: Promise<{ id: string }> }) => Promise<Response>,
    id: string,
    init: { method?: string; body?: unknown; ua?: string; ip?: string } = {},
  ) => {
    g.__who = who;
    const req = new NextRequest(`https://neolinguameet.com/api/events/${id}/feedback`, {
      method: init.method ?? "GET",
      headers: {
        "content-type": "application/json",
        "user-agent": init.ua ?? "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36",
        "x-forwarded-for": init.ip ?? "203.0.113.7",
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    const res = await handler(req, { params: Promise.resolve({ id }) });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const oldToken = () => issueFormToken(Date.now() - 10_000);
  const notices = async (uid: string) => (await listNotifications(uid)).items.filter((x) => x.type === "feedback");

  await t("the form: the meeting's name and a token signed out; no feedback shown to anyone but the owner", async () => {
    const guest = await call(undefined, R.feedback.GET, "sa");
    assert.equal(guest.status, 200);
    assert.equal(guest.body.meeting.name, "SA Regional Meeting");
    assert.match(guest.body.token, /^\d+\./);
    assert.equal(guest.body.signedIn, false);
    assert.equal(guest.body.manage, undefined);
    const ada = await call("user_ada", R.feedback.GET, "sa");
    assert.equal(ada.body.token, null);
    assert.equal(ada.body.manage, undefined);
    assert.equal((await call(undefined, R.feedback.GET, "nope")).status, 404);
  });

  await t("signed out: refused without the form token, with the honeypot filled, empty, or with 7 stars", async () => {
    assert.equal((await call(undefined, R.feedback.POST, "sa", { method: "POST", body: { message: "No sound" } })).body.error, "form_check_failed");
    const fresh = issueFormToken();
    assert.equal((await call(undefined, R.feedback.POST, "sa", { method: "POST", body: { message: "No sound", token: fresh } })).body.error, "form_check_failed");
    assert.equal((await call(undefined, R.feedback.POST, "sa", { method: "POST", body: { message: "x", token: oldToken(), website: "spam.biz" } })).body.error, "rejected");
    assert.equal((await call(undefined, R.feedback.POST, "sa", { method: "POST", body: { token: oldToken() } })).body.error, "empty");
    assert.equal((await call(undefined, R.feedback.POST, "sa", { method: "POST", body: { rating: 7, token: oldToken() } })).body.error, "invalid_rating");
    assert.equal((await call(undefined, R.feedback.POST, "sa", { method: "POST", body: { message: "x", email: "nope", token: oldToken() } })).body.error, "invalid_email");
    assert.equal((await fb.listFeedback(sa.id)).length, 0, "nothing kept");
  });

  await t("one star tap straight after leaving counts, with no ticket and no notice", async () => {
    const r = await call(undefined, R.feedback.POST, "sa", { method: "POST", body: { rating: 4, where: "after", token: issueFormToken() } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ticket, null);
    const [e] = await fb.listFeedback(sa.id);
    assert.equal(e.rating, 4);
    assert.equal(e.where, "after");
    assert.equal((await notices("user_owner")).length, 0);
  });

  let ticketNumber = 0;
  await t("words from a guest: a support ticket for the meeting's day, nobody's, saying who, where and on what", async () => {
    const r = await call(undefined, R.feedback.POST, "sa", {
      method: "POST",
      body: { message: "Sound goes on and off", kind: "sound", where: "link", name: "Pastor M", email: "PM@Example.com", token: oldToken() },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    ticketNumber = r.body.ticket;
    assert.ok(ticketNumber >= 1000);
    const day = new Date().toISOString().slice(0, 10);
    const tk = (await listTickets()).find((x) => x.number === ticketNumber)!;
    assert.equal(tk.subject, `Feedback: SA Regional Meeting (${day})`);
    assert.equal(tk.category, "meetings");
    assert.equal(tk.userId, null, "not the sender's ticket");
    assert.equal(tk.email, "", "not the sender's email either");
    const [m] = await listMessages(tk.id);
    assert.equal(m.authorName, "Pastor M");
    assert.match(m.body, /^\[Sound\] Sound goes on and off/);
    assert.match(m.body, /Pastor M · pm@example\.com, the feedback link, Chrome on Android/);
    assert.match(m.body, /meeting SA Regional Meeting \(\/sa\)/);
  });

  await t("the owner is told: in their notifications, with what was said and where to read it all", async () => {
    const [x] = await notices("user_owner");
    assert.ok(x, "a notice");
    assert.equal(x.title, "Feedback on SA Regional Meeting");
    assert.equal(x.body, "Sound: Sound goes on and off");
    assert.equal(x.url, "/dashboard/e/sa#feedback");
    assert.equal(sent.length, 0, "no contact set yet");
  });

  await t("more words the same day: the same ticket; the owner not told again within 10 minutes", async () => {
    const r = await call("user_ada", R.feedback.POST, "sa", { method: "POST", body: { message: "I keep dropping out", kind: "dropping", where: "room" } });
    assert.equal(r.body.ticket, ticketNumber);
    const tk = (await listTickets()).find((x) => x.number === ticketNumber)!;
    const msgs = await listMessages(tk.id);
    assert.equal(msgs.length, 2);
    assert.match(msgs[1].body, /Ada · ada@example\.com, in the meeting/);
    assert.equal((await notices("user_owner")).length, 1);
    const e = (await fb.listFeedback(sa.id))[0];
    assert.equal(e.userId, "user_ada");
    assert.equal(e.name, "Ada");
  });

  await t("a contact: paid plans only; a bad email or handle is refused; the reply says whether KingsChat can reach it", async () => {
    const patch = (who: string, id: string, body: unknown) =>
      call(who, R.event.PATCH as never, id, { method: "PATCH", body });
    assert.equal((await patch("user_free", freeMeeting.id, { feedbackContact: { email: "f@example.com" } })).status, 402);
    assert.equal((await patch("user_owner", sa.id, { feedbackContact: { email: "not an email" } })).body.error, "invalid_feedback_contact");
    assert.equal((await patch("user_owner", sa.id, { feedbackContact: { kcHandle: "two words" } })).body.error, "invalid_feedback_contact");
    assert.equal((await patch("user_ada", sa.id, { feedbackContact: { email: "x@example.com" } })).status, 403);

    const unknown = await patch("user_owner", sa.id, { feedbackContact: { kcHandle: "@Nobody" } });
    assert.equal(unknown.status, 200);
    assert.deepEqual(unknown.body.event.feedbackContact, { kcHandle: "nobody" });
    assert.deepEqual(unknown.body.feedbackReach, { kcHandleKnown: false, ownerKcLinked: false });

    await kv.set("neo:kc:handle-to-clerk:pastormatt", "user_pastor");
    await kv.set("neo:kc:tokens:user_owner", { accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3_600_000 });
    const ok = await patch("user_owner", sa.id, { feedbackContact: { kcHandle: "@PastorMatt", email: "Help@Church.org" } });
    assert.deepEqual(ok.body.event.feedbackContact, { kcHandle: "pastormatt", email: "help@church.org" });
    assert.deepEqual(ok.body.feedbackReach, { kcHandleKnown: true, ownerKcLinked: true });
    // Clearing is always allowed.
    assert.equal((await patch("user_free", freeMeeting.id, { feedbackContact: null })).status, 200);
  });

  await t("with a contact, the next notice also goes to the KingsChat handle and the email, with how many came since", async () => {
    await call("user_ada", R.feedback.POST, "sa", { method: "POST", body: { message: "Video froze", kind: "video", where: "room" } });
    assert.equal(sent.length, 0, "still within the 10 minutes");
    await kv.del(`neo:event:${sa.id}:feedback:told`); // the 10 minutes are up
    await call("user_ada", R.feedback.POST, "sa", { method: "POST", body: { message: "Now it works", kind: "other", where: "room" } });
    const list = await notices("user_owner");
    assert.equal(list.length, 2);
    // Dropping out, Video froze, Now it works: three since the first notice.
    assert.equal(list[0].title, "Feedback on SA Regional Meeting (3 messages since the last notice)");
    assert.deepEqual(sent.map((s) => [s.via, s.to]), [["kc", "kc_pastor"], ["mail", "help@church.org"]]);
    assert.match(sent[0].text, /Now it works/);
    assert.match(sent[0].text, /All feedback: https?:\/\/[^\s]+\/dashboard\/e\/sa#feedback/);
  });

  await t("a contact on a meeting whose owner is no longer on a paid plan is not used", async () => {
    await eventStore.update(freeMeeting.id, (p) => ({ ...p, feedbackContact: { email: "free@church.org" } }));
    sent.length = 0;
    const r = await call("user_ada", R.feedback.POST, "fola", { method: "POST", body: { message: "Hello" } });
    assert.equal(r.status, 200);
    assert.equal((await notices("user_free")).length, 1, "the bell still");
    assert.equal(sent.length, 0);
  });

  await t("the owner (and an administrator) sees the feedback, the tally and the contact", async () => {
    const own = await call("user_owner", R.feedback.GET, "sa");
    const m = own.body.manage;
    assert.ok(m, JSON.stringify(own.body));
    assert.equal(m.feedback.length, 5);
    assert.equal(m.feedback[0].message, "Now it works", "newest first");
    assert.equal(m.tally.rated, 1);
    assert.equal(m.tally.average, 4);
    assert.equal(m.tally.written, 4);
    assert.equal(m.tally.kinds.sound, 1);
    assert.deepEqual(m.contact, { kcHandle: "pastormatt", email: "help@church.org" });
    assert.equal(m.contactAllowed, true);
    assert.ok((await call("user_super", R.feedback.GET, "sa")).body.manage);
    const free = await call("user_free", R.feedback.GET, "fola");
    assert.equal(free.body.manage.contactAllowed, false);
  });

  await t("a new day starts a new ticket", async () => {
    const tomorrow = Date.now() + 24 * 3600_000;
    const r = await fb.recordFeedback(sa, { where: "link", message: "Day two", name: "Ada" }, tomorrow);
    assert.ok(r.ticketNumber && r.ticketNumber !== ticketNumber);
    const tk = (await listTickets()).find((x) => x.number === r.ticketNumber)!;
    assert.match(tk.subject, new RegExp(new Date(tomorrow).toISOString().slice(0, 10)));
    assert.ok(await getTicket(tk.id));
  });

  await t("rate limits: ten an hour from one account on one meeting", async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) {
      last = (await call("user_pastor", R.feedback.POST, "sa", { method: "POST", body: { rating: 3 } })).status;
      if (last === 429) {
        assert.equal(i, 10);
        break;
      }
    }
    assert.equal(last, 429);
  });

  await t("deleting someone's account removes the feedback they sent on others' meetings", async () => {
    const step = ERASE_STEPS.find((s) => s.id === "meetingFeedback")!;
    const person = { uid: "user_ada", emails: ["ada@example.com"], names: ["Ada"], kcHandle: null, pseudonym: "erased_x" };
    const before = (await fb.listFeedback(sa.id, 1000)).filter((e) => e.userId === "user_ada").length;
    assert.ok(before >= 3);
    assert.equal(await step.run(person, true), before + 1, "a dry run counts (sa and fola)");
    assert.equal((await fb.listFeedback(sa.id, 1000)).filter((e) => e.userId === "user_ada").length, before, "and changes nothing");
    await step.run(person, false);
    assert.equal((await fb.listFeedback(sa.id, 1000)).filter((e) => e.userId === "user_ada").length, 0);
    assert.ok((await fb.listFeedback(sa.id, 1000)).some((e) => e.name === "Pastor M"), "others' stay");
  });

  await t("signed out, the feedback page and its API get through the middleware; the dashboard does not", async () => {
    const middleware = (await import("../../middleware")).default as unknown as (req: InstanceType<typeof NextRequest>, ev: unknown) => Promise<Response | undefined>;
    g.__who = undefined;
    const pass = async (path: string) => {
      try {
        const res = await middleware(new NextRequest(`https://neolinguameet.com${path}`, { headers: { host: "neolinguameet.com" } }), { waitUntil() {} });
        const to = res?.headers.get("location") ?? res?.headers.get("x-middleware-rewrite") ?? "";
        return { blocked: (res?.status ?? 200) >= 300 && (res?.status ?? 200) < 400 ? to || "redirect" : "", rewrite: to };
      } catch (e) {
        return { blocked: `threw: ${(e as Error).message}`, rewrite: "" };
      }
    };
    for (const path of ["/feedback/sa", "/feedback/sa?after=1", "/api/events/sa/feedback"]) {
      const r = await pass(path);
      assert.equal(r.blocked, "", `${path} blocked: ${r.blocked}`);
      assert.ok(!/\/room\//.test(r.rewrite), `${path} rewritten to a room: ${r.rewrite}`);
    }
    // The check can tell: a page that needs sign-in is stopped.
    assert.notEqual((await pass("/dashboard")).blocked, "");
  });

  await t("devices in words", async () => {
    assert.equal(fb.deviceFrom("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit Version/17.0 Mobile/15E148 Safari/604.1"), "Safari on iPhone");
    assert.equal(fb.deviceFrom("Mozilla/5.0 (Windows NT 10.0) AppleWebKit Chrome/131 Safari/537 Edg/131"), "Edge on Windows");
    assert.equal(fb.deviceFrom("NeoLinguaMeet/1.2.13 (Android)"), "NeoLinguaMeet app 1.2.13");
    assert.equal(fb.deviceFrom(null), "unknown device");
  });

  finished = true;
  console.log(`meetingFeedback: ${n} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
