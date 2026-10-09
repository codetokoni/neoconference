// Run: npx tsx src/lib/__tests__/adminContent.smoke.ts
//
// Admin phase 12 — content, files and storage — through the real routes
// with Clerk, KV, R2 and the LiveKit server stood in for (./apiV1-stubs).
// KV is "configured", so every store runs its KV code against the
// in-memory Redis.
//
// What it proves: each upload and egress point writes the file index; the
// backfill lists storage read-only, a slice at a time, and resumes; the
// Problems view finds failed, stuck, missing, orphaned and duplicated
// files on fixed data; upload limits and plan storage quotas are enforced
// by the server; a private file's contents need an open support session on
// its owner (and that is audited) while metadata does not; anyone can
// report public content, rate limited, without the owner learning who;
// moderation hides, trashes and restores, warns and escalates; and every
// action needs its permission (and a fresh code where it should).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import "./apiV1-stubs/install";

process.env.CLERK_SECRET_KEY = "sk_test_admin_content";
process.env.PLATFORM_OWNER_EMAILS = "owner@example.com";
process.env.ADMIN_EMAILS = "";
delete process.env.RESEND_API_KEY;
delete process.env.TRANSCRIBE_PROVIDER;
process.env.KV_REST_API_URL = "https://kv.invalid";
process.env.KV_REST_API_TOKEN = "stub";
process.env.NEXT_PUBLIC_LIVEKIT_URL = "wss://lk.test";
process.env.LIVEKIT_API_KEY = "lk_key";
process.env.LIVEKIT_API_SECRET = "lk_secret_that_is_long_enough_for_hs256";
process.env.S3_ENDPOINT = "https://r2.test";
process.env.S3_BUCKET = "bucket";
process.env.S3_ACCESS_KEY = "ak";
process.env.S3_SECRET_KEY = "sk";

type StubUser = { plan?: string; emails?: string[]; first?: string; banned?: boolean; metadata?: Record<string, unknown> };
type Obj = { key: string; size: number; lastModified?: string; etag?: string; contentType?: string };
type Stubbed = typeof globalThis & {
  __users: Record<string, StubUser>;
  __clerkSessions: Record<string, { id: string; status: string }[]>;
  __who?: string;
  __objects: Obj[];
  __r2Writes?: { op: string; key: string }[];
  __r2PutFails?: boolean;
  __md5?: (b: Uint8Array) => string;
};
const g = globalThis as Stubbed;
const day = 24 * 60 * 60 * 1000;
g.__users = {
  user_owner: { emails: ["owner@example.com"], first: "Owner" },
  user_super: { emails: ["super@example.com"], first: "Sue" },
  user_mod: { emails: ["mod@example.com"], first: "Mo" },
  user_analyst: { emails: ["analyst@example.com"], first: "Ana" },
  user_alice: { emails: ["alice@example.com"], first: "Alice", plan: "pro" },
  user_bob: { emails: ["bob@example.com"], first: "Bob" },
  user_plain: { emails: ["plain@example.com"], first: "Pat" },
};
g.__clerkSessions = {};
g.__objects = [];
g.__md5 = (b) => createHash("md5").update(b).digest("hex");

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
  const groups = await import("../groupStore");
  const { eventStore } = await import("../eventStore");
  const { transcribeStore } = await import("../transcribeStore");
  const files = await import("../content/files");
  const replay = await import("../replayRecordings");
  const notif = await import("../notificationStore");
  const { AccessToken } = await import("livekit-server-sdk");
  const R = {
    enroll: await import("../../app/api/admin/mfa/enroll/route"),
    confirm: await import("../../app/api/admin/mfa/confirm/route"),
    verify: await import("../../app/api/admin/mfa/verify/route"),
    support: await import("../../app/api/admin/users/[id]/support/route"),
    suspend: await import("../../app/api/admin/users/[id]/suspend/route"),
    chatUpload: await import("../../app/api/chat/upload/route"),
    groupUpload: await import("../../app/api/groups/[id]/upload/route"),
    egressStart: await import("../../app/api/livekit/egress/start/route"),
    webhook: await import("../../app/api/livekit/webhook/route"),
    share: await import("../../app/api/recordings/share/route"),
    recordings: await import("../../app/api/recordings/route"),
    list: await import("../../app/api/admin/content/route"),
    usage: await import("../../app/api/admin/content/usage/route"),
    file: await import("../../app/api/admin/content/files/[id]/route"),
    open: await import("../../app/api/admin/content/files/[id]/open/route"),
    action: await import("../../app/api/admin/content/files/[id]/action/route"),
    problems: await import("../../app/api/admin/content/problems/route"),
    backfill: await import("../../app/api/admin/content/backfill/route"),
    limits: await import("../../app/api/admin/content/limits/route"),
    trash: await import("../../app/api/admin/content/trash/route"),
    cases: await import("../../app/api/admin/content/reports/route"),
    case: await import("../../app/api/admin/content/reports/[id]/route"),
    report: await import("../../app/api/content/reports/route"),
  };

  const jar: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  type Body = Record<string, unknown> & { error?: string; message?: string };
  type Handler<P> = (req: Request, ctx: { params: P }) => Promise<Response>;

  async function call<P = Record<string, string>>(
    who: string | null,
    handler: Handler<P>,
    opts: { method?: string; body?: unknown; form?: FormData; params?: P; query?: string; headers?: Record<string, string> } = {},
  ) {
    g.__who = who ?? undefined;
    const headers: Record<string, string> = { ...(opts.form ? {} : { "content-type": "application/json" }), ...(opts.headers ?? {}) };
    if (who && jar[who]) headers.cookie = `neo_admin_mfa=${jar[who]}`;
    const res = await handler(
      new Request(`https://www.neoconference.app/api/x${opts.query ?? ""}`, {
        method: opts.method ?? "GET",
        headers,
        body: opts.form ?? (opts.body === undefined ? undefined : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body)),
      }),
      { params: (opts.params ?? {}) as P },
    );
    const m = res.headers.get("set-cookie")?.match(/neo_admin_mfa=([^;]*)/);
    if (m && who) jar[who] = decodeURIComponent(m[1]);
    const body = (await res.json().catch(() => ({}))) as Body;
    return { status: res.status, body };
  }
  const code = (who: string) => mfa.totpAt(mfa.base32Decode(secrets[who]), mfa.currentStep());
  async function enrollAndVerify(who: string) {
    const e = await call(who, R.enroll.POST as unknown as Handler<unknown>, { method: "POST" });
    assert.equal(e.status, 200, JSON.stringify(e.body));
    secrets[who] = e.body.secret as string;
    tick();
    const c = await call(who, R.confirm.POST as unknown as Handler<unknown>, { method: "POST", body: { code: code(who) } });
    assert.equal(c.status, 200, JSON.stringify(c.body));
  }
  async function stepUp(who: string) {
    tick();
    const v = await call(who, R.verify.POST as unknown as Handler<unknown>, { method: "POST", body: { code: code(who) } });
    assert.equal(v.status, 200, JSON.stringify(v.body));
  }
  const fileForm = (name: string, type: string, bytes: number | Uint8Array) => {
    const f = new FormData();
    const body = typeof bytes === "number" ? new Uint8Array(bytes).fill(7) : bytes;
    f.append("file", new File([body as BlobPart], name, { type }));
    return f;
  };
  const audits = async (action: string) => (await audit.listAdminAudit({ action })).items;
  const rec = async (key: string, storage: "r2" | "kv" = "r2") => {
    const r = await files.getFileByKey(storage, key);
    assert.ok(r, `index has ${key}`);
    return r!;
  };
  const fid = (key: string, storage: "r2" | "kv" = "r2") => ({ id: files.fileId(storage, key) });
  const ip = (n: number) => ({ "x-forwarded-for": `198.51.100.${n}` });

  const now0 = Date.now();
  const appoint = (userId: string, email: string, roleId: string) =>
    store.saveMember({ userId, email, name: email, roleId, status: "active", appointedBy: "user_owner", appointedAt: now0, updatedAt: now0 });
  await appoint("user_super", "super@example.com", "super_admin");
  await appoint("user_mod", "mod@example.com", "moderator");
  await appoint("user_analyst", "analyst@example.com", "analyst");
  for (const who of ["user_super", "user_mod", "user_analyst"]) await enrollAndVerify(who);

  const mkEvent = (id: string, slug: string, owner: string, extra: Record<string, unknown> = {}) =>
    eventStore.create({
      id,
      slug,
      name: slug.replace(/-/g, " "),
      ownerUserId: owner,
      visibility: "public",
      createdAt: new Date(Date.now() - day).toISOString(),
      updatedAt: new Date().toISOString(),
      livekitRoom: slug,
      qrSeed: "x",
      roles: [],
      ...extra,
    } as unknown as Parameters<typeof eventStore.create>[0]);
  await mkEvent("ev_alice", "alice-weekly", "user_alice");
  await mkEvent("ev_secret", "secret-board", "user_alice", { visibility: "private", replayEnabled: false });
  const aliceGroup = await groups.createGroup({ name: "Alice's team" }, { userId: "user_alice", name: "Alice", email: "alice@example.com" }, []);

  /* ------------------------------ upload points ----------------------------- */

  console.log("index written at each upload point");
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
  let chatKey = "";
  await t("a meeting-chat upload is indexed with owner, size, type, checksum and status", async () => {
    const r = await call("user_alice", R.chatUpload.POST as unknown as Handler<unknown>, { method: "POST", form: fileForm("slide.png", "image/png", png) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    chatKey = g.__r2Writes!.at(-1)!.key;
    const f = await rec(chatKey);
    assert.equal(f.type, "chat_upload");
    assert.equal(f.ownerId, "user_alice");
    assert.equal(f.size, png.length);
    assert.equal(f.contentType, "image/png");
    assert.equal(f.status, "ready");
    assert.equal(f.visibility, "private");
    assert.equal(f.source, "upload");
    assert.equal(f.checksum, "md5:" + createHash("md5").update(png).digest("hex"));
  });

  let groupKey = "";
  await t("a group-chat upload is indexed under its group, owned by the member who sent it", async () => {
    const r = await call("user_alice", R.groupUpload.POST as unknown as Handler<unknown>, { method: "POST", form: fileForm("notes.pdf", "application/pdf", 2048), params: Promise.resolve({ id: aliceGroup.id }) as unknown });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    groupKey = (r.body.attachment as { key: string }).key;
    const f = await rec(groupKey);
    assert.equal(f.type, "group_upload");
    assert.equal(f.groupId, aliceGroup.id);
    assert.equal(f.ownerId, "user_alice");
  });

  let failedKey = "";
  await t("a storage write that fails is indexed as a failed upload", async () => {
    g.__r2PutFails = true;
    const r = await call("user_alice", R.chatUpload.POST as unknown as Handler<unknown>, { method: "POST", form: fileForm("lost.pdf", "application/pdf", 900) });
    g.__r2PutFails = false;
    assert.equal(r.status, 502);
    failedKey = g.__r2Writes!.at(-1)!.key;
    const f = await rec(failedKey);
    assert.equal(f.status, "failed");
    assert.match(f.statusDetail ?? "", /stub put failed/);
  });

  console.log("upload limits, server-side");
  await t("a renamed executable and an oversize file are refused with a sentence that says what is allowed", async () => {
    const writes = g.__r2Writes!.length;
    const exe = await call("user_alice", R.chatUpload.POST as unknown as Handler<unknown>, { method: "POST", form: fileForm("setup.exe", "image/png", 100) });
    assert.equal(exe.status, 415);
    assert.equal(exe.body.error, "unsupported_type");
    assert.match(exe.body.message!, /\.exe files can't be uploaded here\. Allowed: JPG, PNG/);
    const big = await call("user_alice", R.chatUpload.POST as unknown as Handler<unknown>, { method: "POST", form: fileForm("huge.pdf", "application/pdf", 10 * 1024 * 1024 + 1) });
    assert.equal(big.status, 413);
    assert.match(big.body.message!, /Files here can be up to 10\.0 MB/);
    const html = await call("user_alice", R.groupUpload.POST as unknown as Handler<unknown>, { method: "POST", form: fileForm("page.html", "text/html", 100), params: Promise.resolve({ id: aliceGroup.id }) as unknown });
    assert.equal(html.status, 415);
    assert.equal(g.__r2Writes!.length, writes, "nothing refused reached storage");
  });

  await t("changing a limit needs content:moderate and a fresh code; the next upload is checked against it", async () => {
    const rules = { chat: { maxBytes: 1024, mimes: ["application/pdf"] } };
    assert.equal((await call("user_analyst", R.limits.PUT as unknown as Handler<unknown>, { method: "PUT", body: { rules } })).body.error, "forbidden");
    tick(11 * 60_000);
    assert.equal((await call("user_mod", R.limits.PUT as unknown as Handler<unknown>, { method: "PUT", body: { rules } })).body.error, "step_up_required");
    await stepUp("user_mod");
    const bad = await call("user_mod", R.limits.PUT as unknown as Handler<unknown>, { method: "PUT", body: { rules: { chat: { maxBytes: 1024, mimes: ["application/x-msdownload"] } } } });
    assert.equal(bad.body.error, "bad_rule", "only known, non-executable types can be allowed");
    const ok = await call("user_mod", R.limits.PUT as unknown as Handler<unknown>, { method: "PUT", body: { rules } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const pngNow = await call("user_alice", R.chatUpload.POST as unknown as Handler<unknown>, { method: "POST", form: fileForm("a.png", "image/png", 100) });
    assert.equal(pngNow.status, 415, "png no longer allowed in meeting chat");
    const big = await call("user_alice", R.chatUpload.POST as unknown as Handler<unknown>, { method: "POST", form: fileForm("b.pdf", "application/pdf", 2000) });
    assert.equal(big.status, 413);
    assert.match(big.body.message!, /up to 1\.0 KB/);
    const groupStill = await call("user_alice", R.groupUpload.POST as unknown as Handler<unknown>, { method: "POST", form: fileForm("ok.png", "image/png", 3000), params: Promise.resolve({ id: aliceGroup.id }) as unknown });
    assert.equal(groupStill.status, 200, "group chat keeps its own rule");
    const e = (await audits("content.limits.update"))[0];
    assert.equal(e.actorEmail, "mod@example.com");
    assert.deepEqual((e.after as { chat: { maxBytes: number } }).chat.maxBytes, 1024);
    await stepUp("user_mod");
    await call("user_mod", R.limits.PUT as unknown as Handler<unknown>, { method: "PUT", body: { rules: { chat: { maxBytes: 10 * 1024 * 1024, mimes: ["image/png", "application/pdf"] } } } });
  });

  await t("a plan's storage quota (phase 3's storageGb) refuses the upload that would pass it", async () => {
    g.__users.user_alice.metadata = { planLimits: { storageGb: 1 } };
    await files.putFile(files.recordFromKey("r2", "recordings/user_alice/alice-weekly/2026-01-01-00-00-00.mp4", { source: "egress", ownerId: "user_alice", size: 1024 ** 3 - 50 }));
    const r = await call("user_alice", R.chatUpload.POST as unknown as Handler<unknown>, { method: "POST", form: fileForm("c.pdf", "application/pdf", 100) });
    assert.equal(r.status, 413);
    assert.equal(r.body.error, "storage_full");
    assert.match(r.body.message!, /Your plan's storage \(1 GB\) is full/);
    await files.forgetFile(files.fileId("r2", "recordings/user_alice/alice-weekly/2026-01-01-00-00-00.mp4"));
    assert.equal((await call("user_alice", R.chatUpload.POST as unknown as Handler<unknown>, { method: "POST", form: fileForm("c.pdf", "application/pdf", 100) })).status, 200);
    delete g.__users.user_alice.metadata;
  });

  console.log("index written at recording start and end");
  let videoKey = "";
  let audioKey = "";
  const signWebhook = async (event: unknown) => {
    const body = JSON.stringify(event);
    const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
    at.sha256 = createHash("sha256").update(body).digest("base64");
    return { body, headers: { authorization: await at.toJwt(), "content-type": "application/webhook+json" } };
  };
  await t("pressing Record indexes the video and its audio sidecar as processing", async () => {
    const r = await call("user_alice", R.egressStart.POST as unknown as Handler<unknown>, { method: "POST", body: { room: "alice-weekly" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    videoKey = r.body.filepath as string;
    audioKey = r.body.audioFilepath as string;
    const v = await rec(videoKey);
    assert.equal(v.type, "recording");
    assert.equal(v.status, "processing");
    assert.equal(v.egressId, r.body.egressId);
    assert.equal(v.eventSlug, "alice-weekly");
    assert.equal((await rec(audioKey)).type, "recording_audio");
  });

  await t("egress_ended marks the video ready with its size and the failed sidecar failed", async () => {
    const v = await rec(videoKey);
    const a = await rec(audioKey);
    const ok = await signWebhook({ event: "egress_ended", egressInfo: { egressId: v.egressId, roomName: "alice-weekly", status: "EGRESS_COMPLETE", fileResults: [{ filename: videoKey, size: "52428800" }] } });
    const r1 = await call(null, R.webhook.POST as unknown as Handler<unknown>, { method: "POST", body: ok.body, headers: ok.headers });
    assert.equal(r1.status, 200);
    assert.notEqual(r1.body.ok, false, JSON.stringify(r1.body));
    const bad = await signWebhook({ event: "egress_ended", egressInfo: { egressId: a.egressId, roomName: "alice-weekly", status: "EGRESS_FAILED", error: "uploader crashed" } });
    await call(null, R.webhook.POST as unknown as Handler<unknown>, { method: "POST", body: bad.body, headers: bad.headers });
    const v2 = await rec(videoKey);
    assert.equal(v2.status, "ready");
    assert.equal(v2.size, 52428800);
    assert.ok(v2.endedAt);
    const a2 = await rec(audioKey);
    assert.equal(a2.status, "failed");
    assert.equal(a2.statusDetail, "uploader crashed");
  });

  await t("a transcription job is indexed as it moves: queued, then failed", async () => {
    const job = { id: "tj_1", recordingKey: videoKey, eventSlug: "alice-weekly", provider: "deepgram" as const, status: "queued" as const, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await transcribeStore.put(job);
    const k = `transcript:${videoKey}`;
    assert.equal((await rec(k, "kv")).status, "pending");
    await transcribeStore.put({ ...job, status: "error", error: "Deepgram 401" });
    const f = await rec(k, "kv");
    assert.equal(f.status, "failed");
    assert.equal(f.type, "transcript");
    assert.equal(f.ownerId, "user_alice");
    assert.equal(f.statusDetail, "Deepgram 401");
  });

  /* --------------------------------- backfill ------------------------------- */

  console.log("backfill: read-only, capped, resumable");
  const lm = new Date(Date.now() - 3 * day).toISOString();
  const etag = '"0123456789abcdef0123456789abcdef"';
  g.__objects.push(
    { key: videoKey, size: 52428800, lastModified: lm, etag: '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"' },
    { key: "recordings/user_bob/bob-room/2026-09-01-10-00-00.mp4", size: 7000, lastModified: lm, etag: '"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"' },
    { key: "recordings/user_bob/bob-room/2026-09-01-10-05-00.mp4", size: 7100, lastModified: lm, etag: '"cccccccccccccccccccccccccccccccc"' },
    { key: "misc/stray.bin", size: 300, lastModified: lm, etag: '"dddddddddddddddddddddddddddddddd"' },
    { key: "recordings/user_gone/old-room/2025-01-01-00-00-00.mp4", size: 900, lastModified: lm, etag: '"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"' },
    { key: "chat/user_bob/11111111-1111-1111-1111-111111111111-copy1.pdf", size: 4444, lastModified: lm, etag },
    { key: "chat/user_bob/22222222-2222-2222-2222-222222222222-copy2.pdf", size: 4444, lastModified: lm, etag },
    { key: "chat/user_bob/33333333-3333-3333-3333-333333333333-empty.txt", size: 0, lastModified: lm },
  );
  // Bob's recordings are 5 minutes apart and each ran 10 minutes: overlapping.
  // In the index before any scan, and not in storage: "missing" after a complete pass.
  const missingKey = "chat/user_alice/99999999-9999-9999-9999-999999999999-vanished.png";
  await files.putFile({ ...files.recordFromKey("r2", missingKey, { source: "upload", ownerId: "user_alice", size: 77 }, Date.now() - day) });
  // What storage holds: the listed objects and the uploads the stub stored.
  const stored = ((await import("../r2")) as unknown as { allStoredObjects: () => Obj[] }).allStoredObjects();
  const objectCount = stored.length;
  // Uploads the stub stored, and the finished recording, are indexed already.
  const preIndexed = (await Promise.all(stored.map((o) => files.getFileByKey("r2", o.key)))).filter(Boolean).length;

  await t("analyst may read the backfill state but not run it", async () => {
    assert.equal((await call("user_analyst", R.backfill.GET as unknown as Handler<unknown>)).status, 200);
    assert.equal((await call("user_analyst", R.backfill.POST as unknown as Handler<unknown>, { method: "POST", body: {} })).body.error, "forbidden");
  });

  await t("a run stops at its object cap with a cursor; the next run carries on to the end", async () => {
    const writes = g.__r2Writes!.length;
    const r1 = await call("user_mod", R.backfill.POST as unknown as Handler<unknown>, { method: "POST", body: { maxObjects: 3 } });
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    const run1 = r1.body.run as { scanned: number; stoppedBy: string; state: { token: string | null } };
    assert.equal(run1.scanned, 3);
    assert.equal(run1.stoppedBy, "max_objects");
    assert.ok(run1.state.token, "cursor kept");
    const r2 = await call("user_mod", R.backfill.POST as unknown as Handler<unknown>, { method: "POST", body: { maxObjects: 3 } });
    assert.equal((r2.body.run as { scanned: number }).scanned, 3);
    const r3 = await call("user_mod", R.backfill.POST as unknown as Handler<unknown>, { method: "POST", body: { maxObjects: 100 } });
    const run3 = r3.body.run as { scanned: number; stoppedBy: string; state: { token: string | null; lastCompletePass: { objects: number; added: number } } };
    assert.equal(run3.stoppedBy, "complete");
    assert.equal(run3.scanned, objectCount - 6);
    assert.equal(run3.state.token, null);
    assert.equal(run3.state.lastCompletePass.objects, objectCount, "the pass covers every object exactly once");
    assert.ok(preIndexed >= 5, "uploads and the recording were indexed at their upload points");
    assert.equal(run3.state.lastCompletePass.added, objectCount - preIndexed);
    assert.equal(g.__r2Writes!.length, writes, "the backfill wrote nothing to storage");
    const bob = await rec("recordings/user_bob/bob-room/2026-09-01-10-00-00.mp4");
    assert.equal(bob.ownerId, "user_bob");
    assert.equal(bob.source, "backfill");
    assert.equal(bob.checksum, "md5:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    assert.equal((await rec("chat/user_bob/33333333-3333-3333-3333-333333333333-empty.txt")).status, "failed", "an empty object is a failed file");
    assert.equal((await audits("content.backfill.run")).length, 3);
  });

  await t("a second complete pass adds nothing and is still read-only", async () => {
    const r = await call("user_mod", R.backfill.POST as unknown as Handler<unknown>, { method: "POST", body: { restart: true } });
    const run = r.body.run as { added: number; stoppedBy: string };
    assert.equal(run.stoppedBy, "complete");
    assert.equal(run.added, 0);
  });

  // The two overlapping recordings: ten minutes each.
  for (const [k, s] of [
    ["recordings/user_bob/bob-room/2026-09-01-10-00-00.mp4", Date.UTC(2026, 8, 1, 10, 0, 0)],
    ["recordings/user_bob/bob-room/2026-09-01-10-05-00.mp4", Date.UTC(2026, 8, 1, 10, 5, 0)],
  ] as const) {
    await files.putFile({ ...(await rec(k)), endedAt: s + 10 * 60_000 });
  }

  /* --------------------------------- problems ------------------------------- */

  console.log("problems on fixed data");
  type P = { kind: string; id: string; fileIds: string[]; detail: string; actions: string[] };
  const problems = async (who = "user_analyst", q = "") => (await call(who, R.problems.GET as unknown as Handler<unknown>, { query: q })).body as { problems: P[]; counts: Record<string, number> };
  await t("failed, missing, orphans (no owner; owner gone) and both kinds of duplicate are found", async () => {
    const { problems: ps } = await problems();
    const has = (kind: string, key: string) => ps.some((p) => p.kind === kind && p.fileIds.includes(files.fileId("r2", key)));
    assert.ok(has("failed", failedKey), "failed upload");
    assert.ok(has("failed", audioKey), "failed recording sidecar");
    assert.ok(ps.some((p) => p.kind === "failed" && p.fileIds.includes(files.fileId("kv", `transcript:${videoKey}`)) && p.actions.includes("retry")), "failed transcript, retryable");
    assert.ok(has("missing", missingKey), "in the index, not in storage");
    assert.ok(!has("missing", chatKey), "a file the scan saw is not missing");
    assert.ok(has("orphan", "misc/stray.bin"));
    const gone = ps.find((p) => p.kind === "orphan" && p.fileIds.includes(files.fileId("r2", "recordings/user_gone/old-room/2025-01-01-00-00-00.mp4")));
    assert.match(gone!.detail, /no longer exists/);
    const sum = ps.find((p) => p.id.startsWith("duplicate:sum:"));
    assert.equal(sum!.fileIds.length, 2);
    assert.ok(sum!.fileIds.includes(files.fileId("r2", "chat/user_bob/11111111-1111-1111-1111-111111111111-copy1.pdf")));
    const meet = ps.find((p) => p.id.startsWith("duplicate:meeting:bob-room"));
    assert.equal(meet!.fileIds.length, 2, "same meeting, overlapping times");
    assert.ok(!ps.some((p) => p.kind === "orphan" && p.fileIds.includes(files.fileId("r2", groupKey))), "a group file is not an orphan");
  });

  await t("stuck: a transcription queued for over an hour; a recording that never reported finishing", async () => {
    const k = "recordings/user_alice/alice-weekly/2026-10-01-09-00-00.mp4";
    await files.putFile(files.recordFromKey("r2", k, { source: "egress", ownerId: "user_alice", status: "processing", statusAt: Date.now() - 13 * 60 * 60_000 }));
    await transcribeStore.put({ id: "tj_2", recordingKey: chatKey, provider: "deepgram", status: "queued", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    assert.ok(!(await problems()).problems.some((p) => p.kind === "stuck" && p.fileIds.includes(files.fileId("kv", `transcript:${chatKey}`))));
    tick(61 * 60_000);
    const ps = (await problems()).problems;
    assert.ok(ps.some((p) => p.kind === "stuck" && p.fileIds.includes(files.fileId("kv", `transcript:${chatKey}`)) && p.actions[0] === "retry"));
    const rp = ps.find((p) => p.kind === "stuck" && p.fileIds.includes(files.fileId("r2", k)));
    assert.equal(rp!.actions[0], "relink");
    // The file did arrive: re-link finds it and marks it ready.
    g.__objects.push({ key: k, size: 8000, etag: '"ffffffffffffffffffffffffffffffff"' });
    const r = await call("user_mod", R.action.POST as unknown as Handler<unknown>, { method: "POST", params: fid(k), body: { action: "relink" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.inStorage, true);
    const f = await rec(k);
    assert.equal(f.status, "ready");
    assert.equal(f.size, 8000);
    assert.ok(!(await problems()).problems.some((p) => p.fileIds.includes(f.id) && p.kind === "stuck"));
  });

  await t("safe actions: retry needs transcription set up, ignore sticks, forget only what storage no longer has, re-link gives an owner", async () => {
    const tr = await call("user_mod", R.action.POST as unknown as Handler<unknown>, { method: "POST", params: fid(`transcript:${videoKey}`, "kv"), body: { action: "retry" } });
    assert.equal(tr.body.error, "transcription_not_configured");
    const dupId = files.fileId("r2", "chat/user_bob/11111111-1111-1111-1111-111111111111-copy1.pdf");
    for (const id of [dupId, files.fileId("r2", "chat/user_bob/22222222-2222-2222-2222-222222222222-copy2.pdf")]) {
      const r = await call("user_mod", R.action.POST as unknown as Handler<unknown>, { method: "POST", params: { id }, body: { action: "ignore", problem: "duplicate" } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
    assert.ok(!(await problems()).problems.some((p) => p.id.startsWith("duplicate:sum:")), "ignored duplicates stay quiet");
    tick(11 * 60_000);
    assert.equal((await call("user_mod", R.action.POST as unknown as Handler<unknown>, { method: "POST", params: fid(missingKey), body: { action: "forget" } })).body.error, "step_up_required");
    await stepUp("user_mod");
    const still = await call("user_mod", R.action.POST as unknown as Handler<unknown>, { method: "POST", params: fid(chatKey), body: { action: "forget" } });
    assert.equal(still.body.error, "still_in_storage");
    const gone = await call("user_mod", R.action.POST as unknown as Handler<unknown>, { method: "POST", params: fid(missingKey), body: { action: "forget", reason: "vanished" } });
    assert.equal(gone.status, 200, JSON.stringify(gone.body));
    assert.equal(await files.getFileByKey("r2", missingKey), null);
    assert.equal((await audits("content.file.forget"))[0].targetId, files.fileId("r2", missingKey));
    const nobody = await call("user_mod", R.action.POST as unknown as Handler<unknown>, { method: "POST", params: fid("misc/stray.bin"), body: { action: "relink", ownerId: "user_nobody" } });
    assert.equal(nobody.body.error, "no_such_user");
    const own = await call("user_mod", R.action.POST as unknown as Handler<unknown>, { method: "POST", params: fid("misc/stray.bin"), body: { action: "relink", ownerId: "user_bob" } });
    assert.equal(own.status, 200, JSON.stringify(own.body));
    assert.equal((await rec("misc/stray.bin")).ownerId, "user_bob");
    const e = (await audits("content.file.relink"))[0];
    assert.deepEqual([(e.before as { ownerId: string | null }).ownerId, (e.after as { ownerId: string }).ownerId], [null, "user_bob"]);
    assert.ok(!(await problems()).problems.some((p) => p.kind === "orphan" && p.fileIds.includes(files.fileId("r2", "misc/stray.bin"))));
  });

  /* ------------------------------ search and totals ------------------------- */

  console.log("search, filters and storage totals");
  await t("filters by owner, type, status, size and date; totals per type; per account sorted with the plan quota", async () => {
    const ids = async (q: string) => ((await call("user_analyst", R.list.GET as unknown as Handler<unknown>, { query: q })).body.items as { key: string }[]).map((x) => x.key);
    assert.deepEqual(await ids("?owner=user_bob&type=recording&sort=name&dir=asc"), ["recordings/user_bob/bob-room/2026-09-01-10-00-00.mp4", "recordings/user_bob/bob-room/2026-09-01-10-05-00.mp4"]);
    assert.ok((await ids("?status=failed")).includes(failedKey));
    assert.deepEqual(await ids("?minSize=50000000"), [videoKey]);
    assert.deepEqual(await ids("?q=stray"), ["misc/stray.bin"]);
    assert.ok((await ids(`?from=${new Date(Date.now() - 2 * day).toISOString().slice(0, 10)}`)).includes(chatKey));
    assert.ok(!(await ids(`?to=${new Date(Date.now() - 2 * day).toISOString().slice(0, 10)}`)).includes(chatKey));
    const list = await call("user_analyst", R.list.GET as unknown as Handler<unknown>);
    const byType = (list.body.totals as { byType: { type: string; bytes: number }[] }).byType;
    assert.equal(byType[0].type, "recording", "largest type first");
    g.__users.user_bob.metadata = { planLimits: { storageGb: 2 } };
    g.__users.user_bob.plan = "pro";
    const u = await call("user_analyst", R.usage.GET as unknown as Handler<unknown>, { query: "?sort=bytes" });
    const accounts = u.body.accounts as { ownerId: string | null; bytes: number; email: string | null; known: boolean; quotaBytes: number | null }[];
    assert.equal(accounts[0].ownerId, "user_alice");
    assert.equal(accounts[0].email, "alice@example.com");
    assert.equal(accounts.find((a) => a.ownerId === "user_bob")!.quotaBytes, 2 * 1024 ** 3);
    assert.equal(accounts.find((a) => a.ownerId === "user_gone")!.known, false);
    const byFiles = (await call("user_analyst", R.usage.GET as unknown as Handler<unknown>, { query: "?sort=files&dir=asc" })).body.accounts as { files: number }[];
    assert.ok(byFiles[0].files <= byFiles[byFiles.length - 1].files);
    delete g.__users.user_bob.metadata;
    delete g.__users.user_bob.plan;
  });

  /* ---------------------------- private contents ---------------------------- */

  console.log("private contents need an audited support session");
  await t("metadata of a private file is open to content:read; its contents are not", async () => {
    const meta = await call("user_analyst", R.file.GET as unknown as Handler<unknown>, { params: fid(chatKey) });
    assert.equal(meta.status, 200, JSON.stringify(meta.body));
    assert.equal((meta.body.file as { effectiveVisibility: string }).effectiveVisibility, "private");
    assert.equal((meta.body.access as { private: boolean }).private, true);
    assert.equal(JSON.stringify(meta.body).includes("signed.test"), false, "no link to the contents in the metadata");
    const open = await call("user_analyst", R.open.POST as unknown as Handler<unknown>, { method: "POST", params: fid(chatKey) });
    assert.equal(open.status, 403);
    assert.equal(open.body.permission, "users:support_access");
    const denied = (await audits("content.file.open"))[0];
    assert.equal(denied.outcome, "denied");
    assert.equal(denied.actorEmail, "analyst@example.com");
  });

  await t("with support access but no session on the owner: refused (after a fresh code)", async () => {
    tick(11 * 60_000);
    assert.equal((await call("user_super", R.open.POST as unknown as Handler<unknown>, { method: "POST", params: fid(chatKey) })).body.error, "step_up_required");
    await stepUp("user_super");
    const r = await call("user_super", R.open.POST as unknown as Handler<unknown>, { method: "POST", params: fid(chatKey) });
    assert.equal(r.body.error, "support_session_required");
    assert.match(r.body.message!, /Open a support session on its owner's account first/);
    // A session on someone else does not count.
    const s = await call("user_super", R.support.POST as unknown as Handler<unknown>, { method: "POST", params: { id: "user_bob" }, body: { reason: "ticket 12" } });
    assert.equal(s.status, 201, JSON.stringify(s.body));
    assert.equal((await call("user_super", R.open.POST as unknown as Handler<unknown>, { method: "POST", params: fid(chatKey) })).body.error, "support_session_required");
  });

  await t("with a session on the owner it opens, and the open is audited with the session (never the contents)", async () => {
    await stepUp("user_super");
    const s = await call("user_super", R.support.POST as unknown as Handler<unknown>, { method: "POST", params: { id: "user_alice" }, body: { reason: "ticket 13: broken slide" } });
    assert.equal(s.status, 201, JSON.stringify(s.body));
    const r = await call("user_super", R.open.POST as unknown as Handler<unknown>, { method: "POST", params: fid(chatKey) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.url as string, /^https:\/\/signed\.test\/chat\/user_alice\/.*expires=300$/);
    const e = (await audits("content.file.open"))[0];
    assert.equal(e.outcome, "ok");
    assert.equal((e.after as { supportSession: string }).supportSession, (s.body.session as { id: string }).id);
    assert.equal(JSON.stringify(e).includes("signed.test"), false);
    // A private transcript's text, the same way.
    await transcribeStore.put({ id: "tj_3", recordingKey: chatKey, provider: "deepgram", status: "done", text: "hello world", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const txt = await call("user_super", R.open.POST as unknown as Handler<unknown>, { method: "POST", params: fid(`transcript:${chatKey}`, "kv") });
    assert.equal(txt.body.text, "hello world");
  });

  await t("a shared file opens with content:read alone; a share link marks it shared", async () => {
    const sh = await call("user_alice", R.share.POST as unknown as Handler<unknown>, { method: "POST", body: { key: videoKey } });
    assert.equal(sh.status, 200, JSON.stringify(sh.body));
    assert.equal((await rec(videoKey)).visibility, "shared");
    const r = await call("user_analyst", R.open.POST as unknown as Handler<unknown>, { method: "POST", params: fid(videoKey) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });

  /* --------------------------------- reports -------------------------------- */

  console.log("reports: public intake, rate limit, reporter hidden");
  const report = (who: string | null, body: unknown, n = 1) => call(who, R.report.POST as unknown as Handler<unknown>, { method: "POST", body, headers: ip(n) });
  let eventCase = "";
  await t("anyone can report a public replay (signed out too); private content cannot be reported", async () => {
    const out = await report(null, { targetType: "event", target: "alice-weekly", reason: "harassment", details: "Rude slides at 10:00" }, 1);
    assert.equal(out.status, 201, JSON.stringify(out.body));
    assert.match(out.body.message!, /administrator will look at it/);
    const signedIn = await report("user_bob", { targetType: "event", target: "alice-weekly", reason: "spam" }, 2);
    assert.equal(signedIn.status, 201);
    const again = await report("user_bob", { targetType: "event", target: "alice-weekly", reason: "spam" }, 3);
    assert.equal(again.status, 200, "the same person again counts once");
    assert.equal((await report(null, { targetType: "event", target: "secret-board", reason: "spam" }, 4)).status, 404);
    assert.equal((await report(null, { targetType: "file", target: files.fileId("r2", chatKey), reason: "spam" }, 4)).status, 404, "a private file");
    assert.equal((await report(null, { targetType: "event", target: "alice-weekly", reason: "nonsense" }, 4)).body.error, "bad_reason");
    const q = await call("user_analyst", R.cases.GET as unknown as Handler<unknown>);
    const c = (q.body.items as { id: string; reportCount: number; ownerId: string; reports: { reporter: { hidden?: boolean } }[] }[])[0];
    eventCase = c.id;
    assert.equal(c.reportCount, 2);
    assert.equal(c.ownerId, "user_alice");
    assert.ok(c.reports.every((r) => r.reporter.hidden), "content:read alone does not see reporters");
    const m = await call("user_mod", R.case.GET as unknown as Handler<unknown>, { params: { id: eventCase } });
    const reps = (m.body.case as { reports: { reporter: { userId?: string; anonymous?: boolean } }[] }).reports;
    assert.deepEqual(reps.map((r) => r.reporter.userId ?? "anon").sort(), ["anon", "user_bob"]);
    assert.equal(JSON.stringify(m.body).includes("198.51.100"), false, "addresses are never shown, only hashed");
  });

  await t("five reports per address in ten minutes, then a clear refusal", async () => {
    for (let i = 0; i < 4; i++) await report(null, { targetType: "event", target: "alice-weekly", reason: "other" }, 9);
    const fifth = await report(null, { targetType: "event", target: "alice-weekly", reason: "other" }, 9);
    const sixth = await report(null, { targetType: "event", target: "alice-weekly", reason: "other" }, 9);
    assert.notEqual(fifth.status, 429, "the fifth is still taken (as a repeat of the same report)");
    assert.equal(sixth.status, 429);
    assert.match(sixth.body.message!, /try again in a few minutes/);
    tick(21 * 60_000);
    assert.notEqual((await report(null, { targetType: "event", target: "alice-weekly", reason: "other" }, 9)).status, 429, "a new window");
  });

  console.log("moderation");
  await t("hiding a replay needs content:moderate and a reason; it leaves the explore page and the replay", async () => {
    assert.equal((await call("user_analyst", R.case.POST as unknown as Handler<unknown>, { method: "POST", params: { id: eventCase }, body: { action: "hide", note: "x" } })).body.error, "forbidden");
    assert.equal((await call("user_mod", R.case.POST as unknown as Handler<unknown>, { method: "POST", params: { id: eventCase }, body: { action: "hide" } })).body.error, "reason_required");
    const r = await call("user_mod", R.case.POST as unknown as Handler<unknown>, { method: "POST", params: { id: eventCase }, body: { action: "hide", note: "Abusive slides" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((r.body.case as { status: string }).status, "actioned");
    assert.ok((await files.hiddenEventSlugs()).has("alice-weekly"));
    const e = (await audits("content.report.hide"))[0];
    assert.deepEqual([e.before, e.after], [{ eventHidden: false }, { eventHidden: true, slug: "alice-weekly" }]);
    const back = await call("user_mod", R.case.POST as unknown as Handler<unknown>, { method: "POST", params: { id: eventCase }, body: { action: "unhide", note: "Reviewed again" } });
    assert.equal(back.status, 200);
    assert.ok(!(await files.hiddenEventSlugs()).has("alice-weekly"));
  });

  let fileCase = "";
  await t("a shared recording reported by its link: hidden, it leaves the replay and the link answers 'removed'", async () => {
    const token = ((await call("user_alice", R.share.POST as unknown as Handler<unknown>, { method: "POST", body: { key: videoKey } })).body.share as { token: string }).token;
    const r = await report(null, { targetType: "share", target: token, reason: "copyright" }, 20);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    fileCase = ((await call("user_mod", R.cases.GET as unknown as Handler<unknown>)).body.items as { id: string; fileId?: string }[]).find((c) => c.fileId === files.fileId("r2", videoKey))!.id;
    const ev = (await eventStore.bySlug("alice-weekly"))!;
    const onReplay = async () => (await replay.eventReplayVideos(ev)).some((v) => v.url.includes(videoKey));
    assert.ok(await onReplay(), "on the replay before");
    const h = await call("user_mod", R.case.POST as unknown as Handler<unknown>, { method: "POST", params: { id: fileCase }, body: { action: "hide", note: "Pirated film" } });
    assert.equal(h.status, 200, JSON.stringify(h.body));
    assert.equal((await rec(videoKey)).state, "hidden");
    assert.equal(await onReplay(), false, "gone from the replay");
    assert.equal((await replay.eventReplayVideos(ev)).length, 1, "the meeting's other recording stays");
    const link = await call(null, R.share.GET as unknown as Handler<unknown>, { query: `?token=${token}` });
    assert.equal(link.status, 410);
    assert.equal(link.body.error, "removed");
    const own = await call("user_alice", R.recordings.GET as unknown as Handler<unknown>);
    assert.ok((own.body.recordings as { key: string }[]).some((x) => x.key === videoKey), "the owner still sees a hidden file");
    const e = (await audits("content.file.hide"))[0];
    assert.deepEqual([e.before, e.after].map((x) => (x as { state: string }).state), ["active", "hidden"]);
    assert.match(e.note!, new RegExp(`case ${fileCase}`));
  });

  await t("trash needs a fresh code, hides it from the owner too, and restores within the window", async () => {
    tick(11 * 60_000);
    assert.equal((await call("user_mod", R.case.POST as unknown as Handler<unknown>, { method: "POST", params: { id: fileCase }, body: { action: "trash", note: "x" } })).body.error, "step_up_required");
    await stepUp("user_mod");
    const tr = await call("user_mod", R.case.POST as unknown as Handler<unknown>, { method: "POST", params: { id: fileCase }, body: { action: "trash", note: "Confirmed infringing" } });
    assert.equal(tr.status, 200, JSON.stringify(tr.body));
    assert.equal((await rec(videoKey)).state, "trashed");
    assert.ok(g.__objects.some((o) => o.key === videoKey), "trash moves nothing in storage");
    assert.ok(!((await call("user_alice", R.recordings.GET as unknown as Handler<unknown>)).body.recordings as { key: string }[]).some((x) => x.key === videoKey), "not in the owner's list");
    const trash = await call("user_analyst", R.trash.GET as unknown as Handler<unknown>);
    assert.equal(trash.body.days, 30);
    const item = (trash.body.items as { id: string; restoreUntil: number }[])[0];
    assert.equal(item.id, files.fileId("r2", videoKey));
    const back = await call("user_mod", R.action.POST as unknown as Handler<unknown>, { method: "POST", params: fid(videoKey), body: { action: "restore" } });
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.equal((await rec(videoKey)).state, "hidden", "back to how it was before the trash");
    // Past the window it cannot be restored.
    await stepUp("user_mod");
    await call("user_mod", R.action.POST as unknown as Handler<unknown>, { method: "POST", params: fid(videoKey), body: { action: "trash", reason: "again" } });
    tick(31 * day);
    // A month on, the admin sessions (12 hours) have ended too.
    for (const who of ["user_mod", "user_analyst"]) await stepUp(who);
    const late = await call("user_mod", R.action.POST as unknown as Handler<unknown>, { method: "POST", params: fid(videoKey), body: { action: "restore" } });
    assert.equal(late.status, 410);
    assert.equal(late.body.error, "restore_window_passed");
  });

  await t("warning the owner sends an in-app notice that never names the reporter", async () => {
    assert.equal((await call("user_mod", R.case.POST as unknown as Handler<unknown>, { method: "POST", params: { id: eventCase }, body: { action: "warn" } })).body.error, "message_required");
    const r = await call("user_mod", R.case.POST as unknown as Handler<unknown>, { method: "POST", params: { id: eventCase }, body: { action: "warn", message: "Please keep slides respectful." } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const { items } = await notif.listNotifications("user_alice");
    assert.equal(items[0].title, "A message from NeoConference about your content");
    assert.match(items[0].body, /Please keep slides respectful/);
    const seen = JSON.stringify(items);
    for (const secret of ["user_bob", "bob@example.com", "Rude slides", "198.51.100"]) assert.equal(seen.includes(secret), false, `owner never sees ${secret}`);
  });

  await t("escalating records a suspension made through Users > Suspend, and needs users:suspend", async () => {
    assert.equal((await call("user_analyst", R.case.POST as unknown as Handler<unknown>, { method: "POST", params: { id: eventCase }, body: { action: "escalate" } })).body.error, "forbidden");
    // Moderating content is not enough: recording a suspension needs users:suspend too.
    await store.saveRole({ id: "custom_content", name: "Content only", description: "", permissions: ["content:read", "content:moderate"], builtIn: false });
    await appoint("user_plain", "plain@example.com", "custom_content");
    await enrollAndVerify("user_plain");
    const noSuspend = await call("user_plain", R.case.POST as unknown as Handler<unknown>, { method: "POST", params: { id: eventCase }, body: { action: "escalate" } });
    assert.equal(noSuspend.body.permission, "users:suspend");
    await store.saveMember({ ...(await store.getMember("user_plain"))!, status: "removed" });
    const early = await call("user_mod", R.case.POST as unknown as Handler<unknown>, { method: "POST", params: { id: eventCase }, body: { action: "escalate", note: "Repeat offender" } });
    assert.equal(early.body.error, "suspend_first");
    const s = await call("user_mod", R.suspend.POST as Handler<{ id: string }>, { method: "POST", params: { id: "user_alice" }, body: { reason: `Content report ${eventCase}` } });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    const ok = await call("user_mod", R.case.POST as unknown as Handler<unknown>, { method: "POST", params: { id: eventCase }, body: { action: "escalate", note: "Repeat offender" } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const c = ok.body.case as { history: { action: string; byEmail: string }[] };
    assert.deepEqual(
      c.history.map((h) => h.action),
      ["escalate", "warn", "unhide", "hide"],
    );
    assert.equal((await audits("user.suspend"))[0].targetId, "user_alice");
    const notes = await call("user_mod", R.case.POST as unknown as Handler<unknown>, { method: "POST", params: { id: eventCase }, body: { action: "note", note: "Spoke to the host" } });
    assert.equal((notes.body.case as { notes: { text: string }[] }).notes[0].text, "Spoke to the host");
    const dis = await call("user_mod", R.case.POST as unknown as Handler<unknown>, { method: "POST", params: { id: eventCase }, body: { action: "dismiss" } });
    assert.equal((dis.body.case as { status: string }).status, "dismissed");
    // A new report on a closed case is counted, not lost.
    await report(null, { targetType: "event", target: "alice-weekly", reason: "violence" }, 30);
    const after = await call("user_mod", R.case.GET as unknown as Handler<unknown>, { params: { id: eventCase } });
    assert.equal((after.body.case as { newSinceClosed: number }).newSinceClosed, 1);
  });

  console.log("permissions");
  await t("every content route refuses non-administrators and roles without content permissions", async () => {
    const reads: [string, Handler<unknown>, Record<string, string>?][] = [
      ["list", R.list.GET as unknown as Handler<unknown>],
      ["usage", R.usage.GET as unknown as Handler<unknown>],
      ["problems", R.problems.GET as unknown as Handler<unknown>],
      ["trash", R.trash.GET as unknown as Handler<unknown>],
      ["limits", R.limits.GET as unknown as Handler<unknown>],
      ["cases", R.cases.GET as unknown as Handler<unknown>],
      ["file", R.file.GET as unknown as Handler<unknown>, fid(chatKey)],
      ["case", R.case.GET as unknown as Handler<unknown>, { id: eventCase }],
    ];
    for (const [name, h, params] of reads) {
      assert.equal((await call("user_plain", h, { params })).body.error, "not_admin", name);
      assert.equal((await call(null, h, { params })).status, 401, name);
    }
    await store.saveRole({ id: "custom_people", name: "People", description: "", permissions: ["users:read"], builtIn: false });
    await appoint("user_bob", "bob@example.com", "custom_people");
    await enrollAndVerify("user_bob");
    for (const [name, h, params] of reads) {
      const r = await call("user_bob", h, { params });
      assert.equal(r.body.error, "forbidden", name);
      assert.equal(r.body.permission, "content:read", name);
    }
    const writes: [string, Handler<unknown>, unknown, Record<string, string>?][] = [
      ["backfill", R.backfill.POST as unknown as Handler<unknown>, {}],
      ["action", R.action.POST as unknown as Handler<unknown>, { action: "hide", reason: "x" }, fid(chatKey)],
      ["case", R.case.POST as unknown as Handler<unknown>, { action: "note", note: "x" }, { id: eventCase }],
    ];
    for (const [name, h, body, params] of writes) {
      assert.equal((await call("user_analyst", h, { method: "POST", body, params })).body.permission, "content:moderate", name);
    }
  });

  console.log(`\n${n} checks passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
