// Run: npx tsx src/lib/__tests__/apiV1.smoke.ts
//
// The developer API's events and recordings routes, driven for real: their
// handlers, apiAuth, eventStore, eventRecordings and roomRecording run as
// written, with stand-ins (./apiV1-stubs) only for what reaches outside —
// KV, R2, the LiveKit server and Clerk. Also the website's Record route,
// which now starts recordings through the same helper.
//
// Until 8 Oct 2026 the events calls read keys nothing wrote (always empty
// or 404) and the recordings list looked in a folder nothing wrote to.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import nodeModule from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

// ---- stand-ins, installed before any app module loads ----
type Resolved = { url: string; format?: string | null; shortCircuit?: boolean };
type Ctx = { parentURL?: string };
const registerHooks = (nodeModule as unknown as {
  registerHooks?: (h: { resolve: (s: string, c: Ctx, next: (s: string, c?: Ctx) => Resolved) => Resolved }) => void;
}).registerHooks;
if (!registerHooks) throw new Error("apiV1.smoke needs Node 22.15+ (module.registerHooks)");

const LIB = pathToFileURL(path.resolve(__dirname, "..") + path.sep).href;
const STUBS = pathToFileURL(path.resolve(__dirname, "apiV1-stubs") + path.sep).href;
const stub = (name: string): Resolved => ({ url: STUBS + name, shortCircuit: true, format: "module" });
const fromStub = (ctx: Ctx) => (ctx.parentURL || "").startsWith(STUBS);

registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "real:livekit") return next("livekit-server-sdk", ctx);
    if (spec === "real:clerk") return next("@clerk/nextjs/server", ctx);
    if (spec === "real:r2") return next(LIB + "r2.ts", ctx);
    if (!fromStub(ctx)) {
      if (spec === "livekit-server-sdk") return stub("livekit.mjs");
      if (spec === "@clerk/nextjs/server") return stub("clerk.mjs");
    }
    const r = next(spec, ctx);
    if (!fromStub(ctx) && r.url.endsWith("/src/lib/kv.ts")) return stub("kv.mjs");
    if (!fromStub(ctx) && r.url.endsWith("/src/lib/r2.ts")) return stub("r2.mjs");
    return r;
  },
});

delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;
Object.assign(process.env, {
  LIVEKIT_API_KEY: "lk",
  LIVEKIT_API_SECRET: "lk-secret-lk-secret-lk-secret-123",
  NEXT_PUBLIC_LIVEKIT_URL: "wss://lk.test",
  S3_ACCESS_KEY: "a",
  S3_SECRET_KEY: "b",
  S3_ENDPOINT: "https://r2.test",
  S3_BUCKET: "bkt",
});

type Stubbed = typeof globalThis & {
  __users: Record<string, { plan?: string; emails?: string[] }>;
  __objects: Array<{ key: string; size: number }>;
  __egress: { started: Array<{ room: string; filepath: string }>; stopped: string[]; active: Array<{ egressId: string; roomName: string }> };
  __egressFails?: boolean;
  __who?: string;
};
const g = globalThis as Stubbed;

let n = 0;
const t = async (name: string, fn: () => Promise<void>) => {
  await fn();
  n++;
  console.log("  ok  " + name);
};

async function main() {
  const { kv } = await import("../kv");
  const { eventStore } = await import("../eventStore");
  const events = await import("../../app/api/v1/events/route");
  const eventOne = await import("../../app/api/v1/events/[slug]/route");
  const eventRecs = await import("../../app/api/v1/events/[slug]/recordings/route");
  const meetingRecs = await import("../../app/api/v1/meetings/[id]/recordings/route");
  const egressStart = await import("../../app/api/livekit/egress/start/route");

  g.__users = {
    user_A: { plan: "pro", emails: ["a@example.com"] },
    user_B: { plan: "pro", emails: ["b@example.com"] },
    user_F: { emails: ["f@example.com"] }, // Free
  };

  async function key(owner: string): Promise<string> {
    const raw = `nc_live_${owner}_0123456789abcdef`;
    const hash = createHash("sha256").update(raw).digest("hex");
    await kv.set(`apikey:${hash}`, { id: `k_${owner}`, ownerUserId: owner, name: "t", plan: "free", createdAt: 0, lastUsedAt: null, revoked: false });
    return raw;
  }
  // The handlers' typed signatures (NextRequest, params) don't matter to
  // the test; they're called as Next calls them.
  type Handler = (req: unknown, ctx: { params: Record<string, string> }) => Promise<Response>;
  async function call(handler: unknown, method: string, p: string, k: string, params: Record<string, string> = {}) {
    const req = new Request(`https://www.neoconference.app/api/v1${p}`, { method, headers: { authorization: `Bearer ${k}` } });
    const res = await (handler as Handler)(req, { params });
    return { status: res.status, body: await res.json() };
  }

  const A = await key("user_A");
  const B = await key("user_B");
  const F = await key("user_F");
  const at = (d: string) => new Date(d).toISOString();
  const ev = (e: Record<string, unknown>) => eventStore.create({ roles: [], ...e } as never);
  await ev({ id: "ev_a1", slug: "sunday-service", name: "Sunday Service", ownerUserId: "user_A", state: "ended", visibility: "public", createdAt: at("2026-10-01T09:00:00Z") });
  await ev({ id: "ev_a2", slug: "prayer-night", name: "Prayer Night", ownerUserId: "user_A", state: "live", visibility: "unlisted", createdAt: at("2026-10-05T19:00:00Z"), replayEnabled: false });
  await ev({ id: "ev_b1", slug: "b-secret", name: "B's meeting", ownerUserId: "user_B", state: "live", visibility: "private", createdAt: at("2026-10-06T10:00:00Z") });

  console.log("api v1: events");
  await t("GET /events: the key owner's website events, newest first, nobody else's", async () => {
    const r = await call(events.GET, "GET", "/events", A);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.data.map((e: { slug: string }) => e.slug), ["prayer-night", "sunday-service"]);
    const s = r.body.data[1];
    assert.equal(s.title, "Sunday Service");
    assert.equal(s.url, "https://www.neoconference.app/e/sunday-service");
    assert.equal(s.replayUrl, "https://www.neoconference.app/e/sunday-service/replay");
    assert.equal(r.body.data[0].replayUrl, null, "replay switched off");
  });
  await t("GET /events/{slug}: own event 200, another owner's 404", async () => {
    assert.equal((await call(eventOne.GET, "GET", "/events/sunday-service", A, { slug: "sunday-service" })).body.data.title, "Sunday Service");
    const other = await call(eventOne.GET, "GET", "/events/b-secret", A, { slug: "b-secret" });
    assert.equal(other.status, 404);
    assert.equal(other.body.error.code, "not_found");
  });

  g.__objects = [
    { key: "recordings/user_A/sunday-service/2026-10-01-09-10-00.mp4", size: 5000 },
    { key: "recordings/user_A/sunday-service/2026-10-01-09-10-00.m4a", size: 800 },
    { key: "recordings/user_A/sunday-service/2026-10-01-08-00-00.mp4", size: 0 },
    { key: "recordings/user_A/prayer-night/2026-10-05-19-05-00.mp4", size: 7000 },
    { key: "recordings/user_B/b-secret/2026-10-06-10-05-00.mp4", size: 9000 },
  ];
  await t("GET /events/{slug}/recordings: that event's video + audio, signed links, empties dropped", async () => {
    const r = await call(eventRecs.GET, "GET", "/events/sunday-service/recordings", A, { slug: "sunday-service" });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.data.map((x: { kind: string; key: string }) => [x.kind, x.key]), [
      ["audio", "recordings/user_A/sunday-service/2026-10-01-09-10-00.m4a"],
      ["video", "recordings/user_A/sunday-service/2026-10-01-09-10-00.mp4"],
    ]);
    assert.equal(r.body.data[1].recordedAt, "2026-10-01T09:10:00.000Z");
    assert.match(r.body.data[1].downloadUrl, /^https:\/\/signed\.test\/recordings\/user_A\/sunday-service\//);
    assert.equal(r.body.data[1].downloadUrlExpiresIn, 3600);
    assert.equal((await call(eventRecs.GET, "GET", "/events/b-secret/recordings", A, { slug: "b-secret" })).status, 404);
  });

  console.log("api v1: meeting recordings");
  const meeting = (id: string, owner: string, status = "open") =>
    kv.set(`meeting:${id}`, { id, name: "Sync", slug: `sync-${id}`, ownerUserId: owner, createdAt: 0, maxParticipants: 30, status });
  await meeting("m1", "user_A");
  await meeting("mF", "user_F");
  await meeting("mEnded", "user_A", "ended");
  await t("POST starts recording into the owner's folder under the meeting's room", async () => {
    const r = await call(meetingRecs.POST, "POST", "/meetings/m1/recordings", A, { id: "m1" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.match(r.body.data.recordingId, /^EG_/);
    const started = g.__egress.started.filter((s) => s.room === "sync-m1");
    assert.equal(started.length, 2, "video + audio sidecar");
    assert.match(started[0].filepath, /^recordings\/user_A\/sync-m1\/\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.mp4$/);
  });
  await t("GET lists that same folder", async () => {
    g.__objects.push({ key: "recordings/user_A/sync-m1/2026-10-08-10-00-00.mp4", size: 1234 });
    const r = await call(meetingRecs.GET, "GET", "/meetings/m1/recordings", A, { id: "m1" });
    assert.deepEqual(r.body.data.map((x: { key: string }) => x.key), ["recordings/user_A/sync-m1/2026-10-08-10-00-00.mp4"]);
  });
  await t("DELETE stops what is running in that meeting only", async () => {
    g.__egress.active.push({ egressId: "EG_other", roomName: "someone-else" });
    const r = await call(meetingRecs.DELETE, "DELETE", "/meetings/m1/recordings", A, { id: "m1" });
    assert.equal(r.body.data.stopped, 2);
    assert.ok(!g.__egress.stopped.includes("EG_other"));
  });
  await t("refusals: Free plan 402, ended 409, someone else's 404, nobody joined 409", async () => {
    const free = await call(meetingRecs.POST, "POST", "/meetings/mF/recordings", F, { id: "mF" });
    assert.equal(free.status, 402);
    assert.equal(free.body.error.code, "plan_upgrade_required");
    const ended = await call(meetingRecs.POST, "POST", "/meetings/mEnded/recordings", A, { id: "mEnded" });
    assert.equal(ended.status, 409);
    assert.equal(ended.body.error.code, "meeting_ended");
    assert.equal((await call(meetingRecs.POST, "POST", "/meetings/m1/recordings", B, { id: "m1" })).status, 404);
    g.__egressFails = true;
    const empty = await call(meetingRecs.POST, "POST", "/meetings/m1/recordings", A, { id: "m1" });
    g.__egressFails = false;
    assert.equal(empty.status, 409);
    assert.equal(empty.body.error.code, "recording_not_started");
  });

  console.log("website Record, through the shared helper");
  const record = (room: string) =>
    egressStart.POST(new Request("https://www.neoconference.app/api/livekit/egress/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ room }),
    }));
  await t("the owner's Record writes to their folder under the event's slug", async () => {
    g.__who = "user_A";
    const before = g.__egress.started.length;
    const res = await record("sunday-service");
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.match(body.filepath, /^recordings\/user_A\/sunday-service\/[\d-]+\.mp4$/);
    assert.match(body.audioFilepath, /\.m4a$/);
    assert.equal(g.__egress.started.length - before, 2);
  });
  await t("a Free owner's meeting is refused with the same 402 body as before", async () => {
    await ev({ id: "ev_f", slug: "free-one", name: "Free", ownerUserId: "user_F", state: "live", visibility: "public", createdAt: at("2026-10-07T10:00:00Z") });
    g.__who = "user_F";
    const res = await record("free-one");
    const body = await res.json();
    assert.equal(res.status, 402);
    assert.deepEqual(Object.keys(body).sort(), ["error", "feature", "message", "plan"]);
    assert.equal(body.error, "plan_upgrade_required");
  });

  console.log(`\n${n} checks passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
