// Run: npx tsx src/lib/__tests__/adminRecordings.smoke.ts
//
// A super admin sees every recording on the Recordings page ("All
// recordings"), through the real /api/recordings and transcript routes with
// Clerk, KV and R2 stood in for (./apiV1-stubs). Each row says who recorded
// it and in which room; a recording kept under the room alone
// (recordings/<room>/<file>, 17 of them in production) is included and
// filed as a recording. Someone who is not an administrator, or one whose
// role cannot see files, still sees only their own; delete stays with the
// owner.

import assert from "node:assert/strict";
import "./apiV1-stubs/install";

process.env.CLERK_SECRET_KEY = "sk_test_admin_recordings";
process.env.PLATFORM_OWNER_EMAILS = "owner@example.com";
process.env.ADMIN_EMAILS = "";
// KV "configured": every store (share links among them) runs its KV code
// against the in-memory Redis.
process.env.KV_REST_API_URL = "https://kv.invalid";
process.env.KV_REST_API_TOKEN = "stub";
process.env.S3_ENDPOINT = "https://r2.test";
process.env.S3_BUCKET = "bucket";
process.env.S3_ACCESS_KEY = "ak";
process.env.S3_SECRET_KEY = "sk";

type Obj = { key: string; size: number; lastModified?: string };
type Stubbed = typeof globalThis & {
  __users: Record<string, { emails?: string[]; first?: string; last?: string }>;
  __who?: string;
  __objects: Obj[];
  __r2Writes?: { op: string; key: string }[];
};
const g = globalThis as Stubbed;
g.__users = {
  user_owner: { emails: ["owner@example.com"], first: "Owner" },
  user_billing: { emails: ["billing@example.com"], first: "Bill" },
  user_alice: { emails: ["alice@example.com"], first: "Alice" },
  user_bob: { emails: ["bob@example.com"], first: "Bob" },
};
const at = (d: number) => new Date(Date.UTC(2026, 9, d, 12)).toISOString();
g.__objects = [
  { key: "recordings/user_alice/sunday/2026-10-01-12-00-00.mp4", size: 1000, lastModified: at(1) },
  { key: "recordings/user_alice/sunday/2026-10-01-12-00-00.m4a.mp4", size: 300, lastModified: at(1) },
  { key: "recordings/user_alice/sunday/2026-10-01-12-00-00.json", size: 50, lastModified: at(1) },
  { key: "recordings/user_bob/standup/2026-10-05-12-00-00.mp4", size: 2000, lastModified: at(5) },
  { key: "recordings/lmm/2026-10-09-12-00-00.mp4", size: 3000, lastModified: at(9) },
  { key: "recordings/user_owner/hsmanagers/2026-10-12-12-00-00.mp4", size: 4000, lastModified: at(12) },
  { key: "chat/user_bob/abc-photo.png", size: 10, lastModified: at(3) },
];

const realNow = Date.now.bind(Date);
let skew = 0;
Date.now = () => realNow() + skew;
const tick = (ms = 30_000) => {
  skew += ms;
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

type Row = { key: string; room?: string | null; owner?: { userId: string; label: string } | null; mine?: boolean };

async function main() {
  const mfa = await import("../admin/mfa");
  const store = await import("../admin/store");
  const { classifyKey } = await import("../content/model");
  const { transcribeStore } = await import("../transcribeStore");
  const R = {
    enroll: await import("../../app/api/admin/mfa/enroll/route"),
    confirm: await import("../../app/api/admin/mfa/confirm/route"),
    recordings: await import("../../app/api/recordings/route"),
    transcript: await import("../../app/api/recordings/transcript/route"),
    share: await import("../../app/api/recordings/share/route"),
  };
  const { NextRequest } = await import("next/server");

  const jar: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  async function call(who: string | null, handler: (req: never) => Promise<Response>, opts: { method?: string; body?: unknown; query?: string } = {}) {
    g.__who = who ?? undefined;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (who && jar[who]) headers.cookie = `neo_admin_mfa=${jar[who]}`;
    const res = await handler(
      new NextRequest(`https://www.neoconference.app/api/x${opts.query ?? ""}`, {
        method: opts.method ?? "GET",
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      }) as never,
    );
    const m = res.headers.get("set-cookie")?.match(/neo_admin_mfa=([^;]*)/);
    if (m && who) jar[who] = decodeURIComponent(m[1]);
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text);
    } catch {
      body = { text };
    }
    return { status: res.status, body };
  }
  const code = (who: string) => mfa.totpAt(mfa.base32Decode(secrets[who]), mfa.currentStep());
  async function signInAdmin(who: string) {
    const e = await call(who, R.enroll.POST as never, { method: "POST" });
    assert.equal(e.status, 200, JSON.stringify(e.body));
    secrets[who] = e.body.secret as string;
    tick();
    const c = await call(who, R.confirm.POST as never, { method: "POST", body: { code: code(who) } });
    assert.equal(c.status, 200, JSON.stringify(c.body));
  }
  const now0 = Date.now();
  await store.saveMember({
    userId: "user_billing", email: "billing@example.com", name: "Bill", roleId: "billing",
    status: "active", appointedBy: "user_owner", appointedAt: now0, updatedAt: now0,
  });

  const keys = (body: Record<string, unknown>) => ((body.recordings as Row[]) ?? []).map((r) => r.key);

  console.log("admin recordings");

  await t("someone who is not an administrator: their own recordings, and no 'all'", async () => {
    const mine = await call("user_alice", R.recordings.GET as never);
    assert.deepEqual(keys(mine.body), ["recordings/user_alice/sunday/2026-10-01-12-00-00.mp4"]);
    const all = await call("user_alice", R.recordings.GET as never, { query: "?scope=all" });
    assert.ok(all.status === 401 || all.status === 403, String(all.status));
    assert.equal(all.body.recordings, undefined);
  });

  await t("an administrator who has not entered their code yet is asked for it", async () => {
    const r = await call("user_owner", R.recordings.GET as never, { query: "?scope=all" });
    assert.equal(r.status, 403);
    assert.match(String(r.body.error), /mfa/);
  });

  await signInAdmin("user_owner");
  await signInAdmin("user_billing");

  await t("an administrator whose role cannot see files (Billing) is refused", async () => {
    const r = await call("user_billing", R.recordings.GET as never, { query: "?scope=all" });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "forbidden");
  });

  await t("the super admin sees every recording, newest first, audio and manifests left out", async () => {
    const r = await call("user_owner", R.recordings.GET as never, { query: "?scope=all" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(keys(r.body), [
      "recordings/user_owner/hsmanagers/2026-10-12-12-00-00.mp4",
      "recordings/lmm/2026-10-09-12-00-00.mp4",
      "recordings/user_bob/standup/2026-10-05-12-00-00.mp4",
      "recordings/user_alice/sunday/2026-10-01-12-00-00.mp4",
    ]);
    // Alice's video still carries its audio.
    const alice = (r.body.recordings as Array<Row & { audio?: { key: string } | null }>).at(-1)!;
    assert.equal(alice.audio?.key, "recordings/user_alice/sunday/2026-10-01-12-00-00.m4a.mp4");
  });

  await t("each row says the room and who recorded it, and which are yours", async () => {
    const r = await call("user_owner", R.recordings.GET as never, { query: "?scope=all" });
    const rows = r.body.recordings as Row[];
    const by = (k: string) => rows.find((x) => x.key.includes(k))!;
    assert.deepEqual([by("standup").room, by("standup").owner?.label, by("standup").mine], ["standup", "Bob · bob@example.com", false]);
    assert.deepEqual([by("hsmanagers").room, by("hsmanagers").mine], ["hsmanagers", true]);
    // Kept under the room alone: the room, and no account behind it.
    assert.deepEqual([by("lmm").room, by("lmm").owner, by("lmm").mine], ["lmm", null, false]);
  });

  await t("their own page is unchanged: the super admin's 'Mine' is theirs only", async () => {
    const r = await call("user_owner", R.recordings.GET as never);
    assert.deepEqual(keys(r.body), ["recordings/user_owner/hsmanagers/2026-10-12-12-00-00.mp4"]);
  });

  await t("delete stays with the owner: the super admin cannot delete Bob's from here", async () => {
    const writes = g.__r2Writes?.length ?? 0;
    const r = await call("user_owner", R.recordings.DELETE as never, {
      method: "DELETE",
      query: "?key=" + encodeURIComponent("recordings/user_bob/standup/2026-10-05-12-00-00.mp4"),
    });
    assert.equal(r.status, 403);
    assert.equal(g.__r2Writes?.length ?? 0, writes);
  });

  await t("a transcript of someone else's recording: the super admin may download it, others may not", async () => {
    const key = "recordings/user_bob/standup/2026-10-05-12-00-00.mp4";
    await transcribeStore.put({ id: "job_bob", recordingKey: key, provider: "stub", status: "done", text: "Standup notes." } as never);
    const admin = await call("user_owner", R.transcript.GET as never, { query: "?key=" + encodeURIComponent(key) });
    assert.equal(admin.status, 200, JSON.stringify(admin.body));
    assert.match(String(admin.body.text), /Standup notes\./);
    const alice = await call("user_alice", R.transcript.GET as never, { query: "?key=" + encodeURIComponent(key) });
    assert.equal(alice.status, 403);
    const billing = await call("user_billing", R.transcript.GET as never, { query: "?key=" + encodeURIComponent(key) });
    assert.equal(billing.status, 403);
  });

  console.log("copy link");
  const shareLink = (who: string | null, key: string) =>
    call(who, R.share.POST as never, { method: "POST", body: { key, ttlSeconds: 30 * 24 * 3600 } });

  await t("Copy link on your own recording: a link that lasts 30 days", async () => {
    const r = await shareLink("user_alice", "recordings/user_alice/sunday/2026-10-01-12-00-00.mp4");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const share = r.body.share as { token: string; expiresAt: number };
    assert.ok(share.token);
    const days = (share.expiresAt - Date.now()) / (24 * 3600 * 1000);
    assert.ok(days > 29.9 && days <= 30, String(days));
  });

  await t("the super admin can copy a link to anyone's recording, and to a room's — each one audited", async () => {
    const { listAdminAudit } = await import("../admin/audit");
    const audited = async () => (await listAdminAudit({ action: "content.share_link" })).items;
    const before = (await audited()).length;
    for (const key of ["recordings/user_bob/standup/2026-10-05-12-00-00.mp4", "recordings/lmm/2026-10-09-12-00-00.mp4"]) {
      const r = await shareLink("user_owner", key);
      assert.equal(r.status, 200, `${key}: ${JSON.stringify(r.body)}`);
    }
    const items = await audited();
    assert.equal(items.length, before + 2);
    assert.deepEqual(
      items.slice(0, 2).map((e) => `${e.actorEmail} ${e.targetId}`).sort(),
      [
        "owner@example.com recordings/lmm/2026-10-09-12-00-00.mp4",
        "owner@example.com recordings/user_bob/standup/2026-10-05-12-00-00.mp4",
      ],
    );
    // A link to their own recording is theirs to make: not an admin action.
    await shareLink("user_owner", "recordings/user_owner/hsmanagers/2026-10-12-12-00-00.mp4");
    assert.equal((await audited()).length, before + 2);
  });

  await t("someone else's recording: not for another user, nor an admin who doesn't moderate content", async () => {
    const key = "recordings/user_bob/standup/2026-10-05-12-00-00.mp4";
    assert.equal((await shareLink("user_alice", key)).status, 403);
    assert.equal((await shareLink("user_billing", key)).status, 403);
  });

  await t("the link opens for anyone, signed in or not, with a video address good for watching (4 h)", async () => {
    const made = await shareLink("user_owner", "recordings/lmm/2026-10-09-12-00-00.mp4");
    const token = (made.body.share as { token: string }).token;
    const open = await call(null, R.share.GET as never, { query: `?token=${token}` });
    assert.equal(open.status, 200, JSON.stringify(open.body));
    assert.equal(open.body.downloadUrl, "https://signed.test/recordings/lmm/2026-10-09-12-00-00.mp4?expires=14400");
  });

  await t("a room's recording with no recorder in its path is filed as a recording", async () => {
    assert.deepEqual(
      [classifyKey("recordings/lmm/2026-10-09-12-00-00.mp4").type, classifyKey("recordings/lmm/2026-10-09-12-00-00.mp4").eventSlug],
      ["recording", "lmm"],
    );
    assert.equal(classifyKey("recordings/lmm/2026-10-09-12-00-00.m4a.mp4").type, "recording_audio");
    assert.equal(classifyKey("recordings/lmm/2026-10-09-12-00-00.json").type, "other");
    assert.equal(classifyKey("recordings/user_alice/sunday/x.mp4").ownerId, "user_alice");
  });

  finished = true;
  console.log(`\n${n} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
