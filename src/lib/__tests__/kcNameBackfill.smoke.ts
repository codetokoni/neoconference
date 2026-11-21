// Run: npx tsx src/lib/__tests__/kcNameBackfill.smoke.ts
//
// Filling in the KingsChat names of accounts that signed in before names
// were kept (src/lib/kcNameBackfill.ts). First the rules with every outside
// call faked (who is named, who is left alone, runs that stop and continue,
// retries and giving up, finishing); then the real job through its cron
// route with Clerk and KV stood in for and KingsChat's token and profile
// endpoints faked: expired tokens refreshed, names saved without touching
// the rest of the account.

import assert from "node:assert/strict";
import "./apiV1-stubs/install";

process.env.CLERK_SECRET_KEY = "sk_test_kc_backfill";
process.env.KV_REST_API_URL = "https://kv.invalid";
process.env.KV_REST_API_TOKEN = "stub";
process.env.KINGSCHAT_CLIENT_ID = "kc-client";
process.env.CRON_SECRET = "cron-secret-test";

type StubUser = { emails?: string[]; plan?: string; role?: string; first?: string | null; last?: string | null; externalId?: string; metadata?: Record<string, unknown> };
const g = globalThis as typeof globalThis & { __users: Record<string, StubUser> };

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
  const B = await import("../kcNameBackfill");
  type Deps = import("../kcNameBackfill").BackfillDeps;
  type Tried = import("../kcNameBackfill").Tried;

  console.log("the rules");

  const kc = (id: string, extra: Record<string, unknown> = {}) => ({ id, publicMetadata: { kingschat: { id: id.slice(5), username: id } }, ...extra });
  function fakes(accounts: Array<{ id: string; firstName?: string | null; lastName?: string | null; publicMetadata?: unknown }>, opts: {
    tokens?: Record<string, string | null>;
    profiles?: Record<string, unknown>;
    ids?: string[];
  }) {
    const saved: Array<[string, string, { firstName: string; lastName: string } | null]> = [];
    const tried = new Map<string, Tried>();
    let done = false;
    const d: Deps = {
      tokenUserIds: async () => opts.ids ?? accounts.map((a) => a.id),
      accounts: async (ids) => new Map(accounts.filter((a) => ids.includes(a.id)).map((a) => [a.id, a])),
      accessToken: async (uid) => (opts.tokens && uid in opts.tokens ? opts.tokens[uid] : "tok-" + uid),
      profile: async (tok) => (opts.profiles && tok in opts.profiles ? opts.profiles[tok] : null),
      save: async (uid, name, names) => {
        saved.push([uid, name, names]);
        const a = accounts.find((x) => x.id === uid)!;
        a.publicMetadata = { kingschat: { ...((a.publicMetadata as { kingschat: object }).kingschat), name } };
        if (names) Object.assign(a, names);
      },
      tried: async (uid) => tried.get(uid) ?? null,
      markTried: async (uid, x) => void tried.set(uid, x),
      isDone: async () => done,
      setDone: async () => void (done = true),
    };
    return { d, saved, tried, isDone: () => done };
  }
  const profile = (name: string) => ({ profile: { user: { user_id: "x", username: "x", name } } });

  await t("names whoever is unnamed; leaves the named, the gone and the non-KingsChat alone; never replaces an account's own name", async () => {
    const accounts: Array<{ id: string; firstName?: string | null; lastName?: string | null; publicMetadata?: unknown }> = [
      kc("user_new1"),
      kc("user_own1", { firstName: "Pastor", lastName: "Ma" }),
      kc("user_had1", { publicMetadata: { kingschat: { id: "1", name: "Already Named" } } }),
      { id: "user_mail", publicMetadata: {} },
    ];
    const f = fakes(accounts, {
      ids: ["user_new1", "user_own1", "user_had1", "user_mail", "user_gone"],
      profiles: { "tok-user_new1": profile("Grace Adebayo Okon"), "tok-user_own1": profile("Mary Adewale") },
    });
    const r = await B.backfillKcNames({}, f.d);
    assert.deepEqual(f.saved, [
      ["user_new1", "Grace Adebayo Okon", { firstName: "Grace Adebayo", lastName: "Okon" }],
      ["user_own1", "Mary Adewale", null],
    ]);
    assert.equal(accounts[1].firstName, "Pastor", "their own name stays");
    assert.deepEqual(
      [r.named, r.filledAccountName, r.alreadyNamed, r.gone, r.notKingsChat, r.done],
      [2, 1, 1, 1, 1, true],
    );
    assert.match(r.summary, /2 named \(1 also got an account name\)/);
    const again = await B.backfillKcNames({}, f.d);
    assert.equal(again.skipped, true, "finished: later runs only check");
    assert.equal(f.saved.length, 2);
  });

  await t("no name at KingsChat: not asked again for a month, and does not keep the job open", async () => {
    const f = fakes([kc("user_blank")], { profiles: { "tok-user_blank": profile("   ") } });
    const r = await B.backfillKcNames({}, f.d);
    assert.equal(r.noNameAtKingsChat, 1);
    assert.equal(f.tried.get("user_blank")?.reason, "no_name");
    assert.equal(r.done, true);
    assert.deepEqual(f.saved, []);
  });

  await t("a token that fails is retried after 6 hours, and given up after three failures", async () => {
    let clock = Date.UTC(2026, 10, 21, 12);
    const now = () => clock;
    const f = fakes([kc("user_tok")], { tokens: { user_tok: null } });
    let r = await B.backfillKcNames({ now }, f.d);
    assert.deepEqual([r.noToken, r.done], [1, false]);
    assert.deepEqual(f.tried.get("user_tok"), { reason: "failed", failures: 1, retryAt: clock + 6 * 3_600_000 });
    clock += 60 * 60_000;
    r = await B.backfillKcNames({ now }, f.d);
    assert.deepEqual([r.waiting, r.noToken, r.done], [1, 0, false], "an hour later: still waiting");
    clock += 6 * 3_600_000;
    r = await B.backfillKcNames({ now }, f.d);
    assert.equal(f.tried.get("user_tok")?.failures, 2);
    clock += 7 * 3_600_000;
    r = await B.backfillKcNames({ now }, f.d);
    assert.deepEqual(f.tried.get("user_tok"), { reason: "gave_up", failures: 3 });
    assert.equal(r.done, true, "given up: the job can finish");
  });

  await t("a run stops starting people when its time is up; the next run carries on", async () => {
    const accounts = Array.from({ length: 10 }, (_, i) => kc(`user_p${i}`));
    const profiles = Object.fromEntries(accounts.map((a, i) => [`tok-${a.id}`, profile(`Person Number${i}`)]));
    const f = fakes(accounts, { profiles });
    let clock = 0;
    const slow = { ...f.d, save: async (...a: Parameters<Deps["save"]>) => { clock += 100; await f.d.save(...a); } };
    const first = await B.backfillKcNames({ budgetMs: 250, concurrency: 1, now: () => clock }, slow);
    assert.deepEqual([first.named, first.leftForNextRun, first.done], [3, 7, false]);
    const second = await B.backfillKcNames({ budgetMs: 10_000, concurrency: 2, now: () => clock }, slow);
    assert.deepEqual([second.alreadyNamed, second.named, second.leftForNextRun, second.done], [3, 7, 0, true]);
    assert.equal(new Set(f.saved.map((s) => s[0])).size, 10, "everyone once");
  });

  console.log("the real job, through its cron route");

  const { saveKcTokens, loadKcTokens } = await import("../kc-tokens");
  const { NextRequest } = await import("next/server");
  const route = await import("../../app/api/cron/kc-name-backfill/route");
  const { listRuns } = await import("../ops/jobs");

  g.__users = {
    user_paid: { emails: ["kc-701@kc.neoconference.app"], externalId: "kc:701", plan: "business", role: "admin", metadata: { kingschat: { id: "701", username: "paidkc" }, meetingsCreated: 4 } },
    user_mine: { emails: ["kc-702@kc.neoconference.app"], externalId: "kc:702", first: "Pastor", last: "Ma", metadata: { kingschat: { id: "702", username: "pastorma" } } },
  };
  const past = Date.now() - 3_600_000;
  await saveKcTokens("user_paid", { accessToken: "old-701", refreshToken: "refresh-701", expiresAt: past });
  await saveKcTokens("user_mine", { accessToken: "old-702", refreshToken: "refresh-702", expiresAt: past });

  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/oauth2/token")) {
      const body = JSON.parse(String(init?.body)) as { client_id: string; refresh_token: string };
      calls.push(`refresh ${body.refresh_token} as ${body.client_id}`);
      const id = body.refresh_token.slice("refresh-".length);
      return new Response(JSON.stringify({ access_token: `new-${id}`, refresh_token: `refresh2-${id}`, expires_in_millis: 3_600_000 }), { status: 200 });
    }
    if (url.includes("kingsch.at/developer/api/profile")) {
      const auth = new Headers(init?.headers).get("authorization");
      calls.push(`profile ${auth}`);
      const who = { "Bearer new-701": { user_id: "701", username: "paidkc", name: "Ngozi  Eze" }, "Bearer new-702": { user_id: "702", username: "pastorma", name: "Mary Adewale" } }[auth ?? ""];
      return who ? new Response(JSON.stringify({ profile: { user: who } }), { status: 200 }) : new Response("no", { status: 401 });
    }
    return realFetch(input, init);
  }) as typeof fetch;

  const run = (auth = "Bearer cron-secret-test") =>
    route.GET(new NextRequest("https://www.neoconference.app/api/cron/kc-name-backfill", { headers: { authorization: auth } }));

  await t("only the schedule (or an administrator, in-process) may run it", async () => {
    const res = await run("Bearer wrong");
    assert.equal(res.status, 401);
  });

  await t("expired tokens are refreshed, the name is read with the new one and saved; nothing else on the account changes", async () => {
    const res = await run();
    assert.equal(res.status, 200);
    const body = (await res.json()) as { named: number; filledAccountName: number; done: boolean; summary: string };
    assert.deepEqual([body.named, body.filledAccountName, body.done], [2, 1, true], body.summary);
    assert.deepEqual(calls.filter((c) => c.startsWith("refresh")).sort(), ["refresh refresh-701 as kc-client", "refresh refresh-702 as kc-client"]);
    assert.deepEqual(calls.filter((c) => c.startsWith("profile")).sort(), ["profile Bearer new-701", "profile Bearer new-702"]);
    const paid = g.__users.user_paid;
    assert.deepEqual(paid.metadata?.kingschat, { id: "701", username: "paidkc", name: "Ngozi Eze" });
    assert.equal(paid.metadata?.meetingsCreated, 4);
    assert.equal(paid.plan, "business");
    assert.equal(paid.role, "admin");
    assert.deepEqual([paid.first, paid.last], ["Ngozi", "Eze"]);
    assert.deepEqual([g.__users.user_mine.first, g.__users.user_mine.last], ["Pastor", "Ma"], "a saved name stays");
    assert.equal((g.__users.user_mine.metadata?.kingschat as { name?: string }).name, "Mary Adewale");
    // The refreshed tokens are kept, so sending KingsChat messages still works.
    assert.equal((await loadKcTokens("user_paid"))?.refreshToken, "refresh2-701");
  });

  await t("the run is on the Jobs page, and a later run only checks that it is done", async () => {
    const before = calls.length;
    const res = await run();
    const body = (await res.json()) as { skipped?: boolean };
    assert.equal(body.skipped, true);
    assert.equal(calls.length, before, "no KingsChat calls once done");
    const runs = await listRuns("kc-name-backfill", 10);
    assert.equal(runs.length, 2);
    assert.match(runs[1].summary ?? "", /2 named \(1 also got an account name\)/);
  });

  finished = true;
  console.log(`kcNameBackfill: ${n} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
