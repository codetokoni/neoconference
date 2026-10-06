import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * Groups, end to end, against a deployed site.
 *
 * Tagged @postdeploy: these describe what the live site serves, so on the PR
 * that adds them they fail for the one reason the branch can't fix — it is
 * not deployed yet. Run after promoting:  npm run test:postdeploy
 *
 * The lifecycle test signs in real test accounts and creates (then deletes)
 * a group and two meetings. It needs, in the environment running the test:
 *
 *   CLERK_SECRET_KEY        to mint one-time sign-in tickets for the accounts
 *   DISPATCH_SECRET         to run a scheduler tick (/api/internal/dispatch)
 *   E2E_OWNER_USER_ID       Clerk id of the account that owns the group
 *   E2E_MEMBER_USER_ID      a member who answers the ring
 *   E2E_ABSENT_USER_ID      a member who never comes
 *
 * Without them it is skipped, saying why.
 */

test.describe("groups: public posture", () => {
  test("@postdeploy the scheduler tick refuses a missing or wrong secret", async ({ request }) => {
    expect((await request.post("/api/internal/dispatch")).status()).toBe(401);
    const wrong = await request.post("/api/internal/dispatch", { headers: { authorization: "Bearer not-the-secret" } });
    expect(wrong.status()).toBe(401);
  });

  test("@postdeploy group APIs are not open to anonymous callers", async ({ request }) => {
    for (const path of ["/api/groups", "/api/me/notifications", "/api/me/meetings", "/api/push/status"]) {
      const r = await request.get(path, { maxRedirects: 0 });
      // Clerk answers a signed-out API call with 404 (x-clerk-auth-status:
      // signed-out); a route's own check answers 401.
      expect([401, 404], path).toContain(r.status());
    }
  });

  test("@postdeploy an invite link that doesn't exist says so, to anyone", async ({ page, request }) => {
    expect((await request.get("/api/groups/invite/does-not-exist")).status()).toBe(410);
    await page.goto("/groups/join/does-not-exist");
    await expect(page.getByText("Invite unavailable")).toBeVisible();
  });

  test("@postdeploy the service worker and the manifest are served without sign-in", async ({ request }) => {
    const sw = await request.get("/sw.js");
    expect(sw.status()).toBe(200);
    expect(await sw.text()).toContain("notificationclick");
    const manifest = await request.get("/manifest.webmanifest");
    expect(manifest.status()).toBe(200);
    expect((await manifest.json()).name).toBe("NeoConference");
  });
});

/* -------------------------------------------------------------------------- */
/*  The whole lifecycle                                                        */
/* -------------------------------------------------------------------------- */

const env = {
  clerk: process.env.CLERK_SECRET_KEY,
  dispatch: process.env.DISPATCH_SECRET,
  owner: process.env.E2E_OWNER_USER_ID,
  member: process.env.E2E_MEMBER_USER_ID,
  absent: process.env.E2E_ABSENT_USER_ID,
};
const missing = Object.entries(env).filter(([, v]) => !v).map(([k]) => k);

/** A browser signed in as `userId`, through a one-time Clerk sign-in ticket. */
async function signedIn(browser: Browser, userId: string, baseURL: string): Promise<Page> {
  const res = await fetch("https://api.clerk.com/v1/sign_in_tokens", {
    method: "POST",
    headers: { authorization: `Bearer ${env.clerk}`, "content-type": "application/json" },
    body: JSON.stringify({ user_id: userId, expires_in_seconds: 300 }),
  });
  expect(res.ok, `sign-in ticket for ${userId}: HTTP ${res.status}`).toBe(true);
  const { token } = (await res.json()) as { token: string };
  const context = await browser.newContext({ baseURL, permissions: ["microphone", "camera"] });
  const page = await context.newPage();
  await page.goto(`/sign-in?__clerk_ticket=${encodeURIComponent(token)}&redirect_url=${encodeURIComponent("/dashboard")}`);
  await page.waitForURL(/\/dashboard/, { timeout: 30_000 });
  return page;
}

/** An API call made by the page itself, so Clerk keeps its session fresh. */
async function api<T = Record<string, unknown>>(page: Page, method: string, url: string, body?: unknown): Promise<{ status: number; json: T }> {
  return page.evaluate(
    async ({ method, url, body }) => {
      const r = await fetch(url, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: r.status, json: await r.json().catch(() => ({})) };
    },
    { method, url, body }
  ) as Promise<{ status: number; json: T }>;
}

/** Ask until `check` passes or time runs out. */
async function eventually<T>(what: string, fn: () => Promise<T>, check: (v: T) => boolean, ms = 90_000): Promise<T> {
  const until = Date.now() + ms;
  let last: T = await fn();
  while (!check(last)) {
    if (Date.now() > until) throw new Error(`${what}: still not true after ${ms / 1000}s — last answer ${JSON.stringify(last).slice(0, 400)}`);
    await new Promise((r) => setTimeout(r, 3000));
    last = await fn();
  }
  return last;
}

test.describe("groups: the whole lifecycle", () => {
  test.skip(missing.length > 0, `needs ${missing.join(", ")} in the environment`);
  test.setTimeout(8 * 60_000);

  test("@postdeploy attendees → group → scheduled meeting → ring → answer → report → my report", async ({ browser, request, baseURL }) => {
    const run = `e2e-${Date.now().toString(36)}`;
    const owner = await signedIn(browser, env.owner!, baseURL!);
    const member = await signedIn(browser, env.member!, baseURL!);
    const absent = await signedIn(browser, env.absent!, baseURL!);
    const cleanup: Array<() => Promise<unknown>> = [];

    try {
      // A first meeting everyone attends, so there are attendees to make a group from.
      const first = await api<{ slug: string }>(owner, "POST", "/api/events/instant", { name: `${run} kickoff` });
      expect(first.status).toBe(201);
      const kickoff = first.json.slug;
      cleanup.push(() => api(owner, "POST", "/api/events/delete", { slug: kickoff, confirm: kickoff }));
      for (const p of [owner, member, absent]) {
        expect((await api(p, "POST", "/api/attendance/beacon", { slug: kickoff, action: "join" })).status).toBe(200);
      }
      expect((await api(owner, "POST", `/api/events/${kickoff}/end`)).status).toBe(200);

      // The group, made from those attendees.
      const created = await api<{ group: { id: string; name: string } }>(owner, "POST", "/api/groups", {
        name: `${run} group`,
        fromEventId: kickoff,
        memberUserIds: [env.member, env.absent],
      });
      expect(created.status).toBe(201);
      const gid = created.json.group.id;
      cleanup.push(() => api(owner, "DELETE", `/api/groups/${gid}`, { confirmName: `${run} group` }));

      // A meeting a minute and a bit from now.
      const startsAt = Date.now() + 75_000;
      const scheduled = await api<{ slug: string; events: Array<{ id: string }> }>(owner, "POST", `/api/groups/${gid}/meetings`, {
        mode: "scheduled",
        title: `${run} rehearsal`,
        scheduledAt: new Date(startsAt).toISOString(),
        durationMin: 15,
        timezone: "UTC",
      });
      expect(scheduled.status).toBe(201);
      const slug = scheduled.json.slug;
      const eid = scheduled.json.events[0].id;
      cleanup.push(() => api(owner, "POST", "/api/events/delete", { slug, confirm: slug }));

      // At its time the owner starts it and goes in, so there is a host.
      await new Promise((r) => setTimeout(r, Math.max(0, startsAt - Date.now() + 2000)));
      expect((await api(owner, "POST", `/api/events/${eid}/start`)).status).toBe(200);
      await owner.goto(`/room/${slug}?event=${slug}&join=1`);
      await expect(owner.locator(".lk-room-container")).toBeVisible({ timeout: 60_000 });

      // A scheduler tick rings everyone due (the droplet's scheduler may beat us to it).
      const tick = await request.post("/api/internal/dispatch", { headers: { authorization: `Bearer ${env.dispatch}` } });
      expect(tick.status()).toBe(200);

      // The member is being rung, in the app.
      type Notes = { items: Array<{ type: string; eventSlug?: string; expiresAt?: number }> };
      await eventually(
        "a ring in the member's notifications",
        async () => (await api<Notes>(member, "GET", "/api/me/notifications")).json,
        (n) => n.items.some((i) => i.type === "ring" && i.eventSlug === slug)
      );

      // They answer from the call overlay and land in the room.
      await member.goto("/dashboard");
      const answer = member.getByRole("alertdialog").getByRole("button", { name: "Answer" });
      await expect(answer).toBeVisible({ timeout: 30_000 });
      await answer.click();
      await member.waitForURL(new RegExp(`/room/${slug}\\?.*join=1`), { timeout: 30_000 });
      await expect(member.locator(".lk-room-container")).toBeVisible({ timeout: 60_000 });
      await member.waitForTimeout(10_000);

      // The meeting ends.
      expect((await api(owner, "POST", `/api/events/${eid}/end`)).status).toBe(200);

      // Its report: the member was there, the other member wasn't and was rung.
      type Report = { report: { participants: Array<{ userId?: string; status: string; callAttempts: number }> } };
      const report = await eventually(
        "the member present in the report",
        async () => (await api<Report>(owner, "GET", `/api/groups/${gid}/reports/${eid}`)).json,
        (r) => r.report?.participants?.some((p) => p.userId === env.member && p.status === "present") ?? false
      );
      const away = report.report.participants.find((p) => p.userId === env.absent);
      expect(away?.status).toBe("absent");
      expect(away?.callAttempts ?? 0).toBeGreaterThanOrEqual(1);

      // And the member sees it among their own meeting reports.
      type Mine = { items: Array<{ eventId: string; status: string }> };
      const mine = await api<Mine>(member, "GET", "/api/me/meetings");
      expect(mine.json.items.find((i) => i.eventId === eid)?.status).toBe("present");
    } finally {
      for (const undo of cleanup.reverse()) await undo().catch(() => undefined);
      for (const p of [owner, member, absent]) await p.context().close();
    }
  });
});
