// Run: npx tsx src/lib/__tests__/videoBroadcast.smoke.ts
//
// Viewers of a room see only its broadcaster. Drives the real
// /api/video/status and /api/video/room/broadcaster routes against a
// stand-in AMS (global fetch) shaped like production on 9 Oct 2026, when
// global-men-crusade had its programme AND a participant camera (slot 16)
// broadcasting in the same group, and the status route reported the
// default room's channels (neoconf-*) instead of the room's own.

import assert from "node:assert/strict";
import "./apiV1-stubs/install";

process.env.VIDEO_ROOM_ADMIN_EMAILS = "host@example.com";
process.env.ADMIN_EMAILS = "host@example.com";

type Stubbed = typeof globalThis & {
  __users: Record<string, { emails?: string[]; role?: string }>;
  __who?: string;
};
const g = globalThis as Stubbed;
g.__users = {
  user_host: { emails: ["host@example.com"] },
  user_staff: { emails: ["staff@example.com"], role: "staff" },
};

// Stand-in AMS: streamId -> status, and which streams sit in which group.
const ams: Record<string, string> = {};
const groups: Record<string, string[]> = {};
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const u = String(input);
  const sub = /\/broadcasts\/([^/]+)\/subtracks/.exec(u);
  if (sub) {
    const main = decodeURIComponent(sub[1]);
    const list = (groups[main] ?? []).map((id) => ({ streamId: id, status: ams[id] ?? "finished", mainTrackStreamId: main }));
    return new Response(JSON.stringify(list), { status: 200 });
  }
  if (/\/broadcasts\/list\//.test(u)) return new Response("[]", { status: 200 });
  const one = /\/broadcasts\/([^/?]+)$/.exec(u);
  if (one) {
    const id = decodeURIComponent(one[1]);
    if (!(id in ams)) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify({ streamId: id, status: ams[id] }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;
void realFetch;

let n = 0;
const t = async (name: string, fn: () => Promise<void> | void) => {
  await fn();
  n++;
  console.log("  ok  " + name);
};

async function main() {
  const phase = await import("../viewerPhase");
  const vb = await import("../videoBroadcaster");
  const { kv } = await import("../kv");
  const status = await import("../../app/api/video/status/route");
  const route = await import("../../app/api/video/room/broadcaster/route");

  const ROOM = "global-men-crusade";
  const getStatus = async (room = ROOM) =>
    (await (await status.GET(new Request(`https://x/api/video/status?room=${room}`))).json()) as {
      ok: boolean;
      channels: { id: string; live: boolean }[];
      broadcaster: { streamId: string; live: boolean; source: string } | null;
      featured: { streamId: string } | null;
      unknown: string[];
    };

  console.log("what a viewer is shown");
  const base = {
    statusKnown: true,
    broadcasterLive: true,
    conn: "playing" as const,
    hasPicture: false,
    everPlayed: false,
    stalled: false,
    playBlocked: false,
  };
  await t("off air: 'Waiting for the host's live broadcast.', never a bare black box", () => {
    assert.equal(phase.viewerPhase({ ...base, broadcasterLive: false, conn: "waiting" }), "waiting");
    assert.equal(phase.viewerPhase({ ...base, statusKnown: false, broadcasterLive: false, conn: "waiting" }), "waiting");
    assert.equal(phase.PHASE_TEXT.waiting, "Waiting for the host’s live broadcast.");
  });
  await t("live: connecting first; frames mean playing; losing them after playing means reconnecting", () => {
    assert.equal(phase.viewerPhase({ ...base, conn: "connecting" }), "connecting");
    assert.equal(phase.viewerPhase({ ...base, hasPicture: true }), "playing");
    assert.equal(phase.viewerPhase({ ...base, everPlayed: true }), "reconnecting");
    assert.equal(phase.viewerPhase({ ...base, conn: "reconnecting" }), "reconnecting");
    assert.equal(phase.viewerPhase({ ...base, hasPicture: true, stalled: true }), "reconnecting");
    assert.equal(phase.PHASE_TEXT.reconnecting, "Reconnecting to the live broadcast.");
  });
  await t("the browser refusing playback asks for a tap ('Watch live') instead of showing black", () => {
    assert.equal(phase.viewerPhase({ ...base, playBlocked: true }), "blocked");
    assert.equal(phase.viewerPhase({ ...base, hasPicture: true, playBlocked: true }), "blocked");
    assert.equal(phase.viewerPhase({ ...base, broadcasterLive: false, conn: "waiting", playBlocked: true }), "waiting");
  });
  await t("a connected, live, frameless subscription restarts after 10 s — and not more than every 15 s", () => {
    const now = 1_000_000;
    assert.equal(phase.shouldRestart({ now, lastFrameAt: now - 9_000, lastRestartAt: 0, live: true, connected: true }), false);
    assert.equal(phase.shouldRestart({ now, lastFrameAt: now - 10_000, lastRestartAt: 0, live: true, connected: true }), true);
    assert.equal(phase.shouldRestart({ now, lastFrameAt: now - 60_000, lastRestartAt: now - 5_000, live: true, connected: true }), false);
    assert.equal(phase.shouldRestart({ now, lastFrameAt: now - 60_000, lastRestartAt: 0, live: false, connected: true }), false);
  });

  console.log("which streams a room may show");
  await t("only the room's programme or its own participant slots; never another room's", () => {
    assert.equal(vb.isRoomBroadcastStream(ROOM, "global-men-crusade-video"), true);
    assert.equal(vb.isRoomBroadcastStream(ROOM, "global-men-crusade-p16"), true);
    assert.equal(vb.isRoomBroadcastStream(ROOM, "neoconf-video"), false);
    assert.equal(vb.isRoomBroadcastStream(ROOM, "global-men-crusade-video2"), false);
    assert.equal(vb.isRoomBroadcastStream(ROOM, "global-men-crusade-a-fr"), false);
    assert.equal(vb.isRoomBroadcastStream("a.b", "aXb-video"), false, "a dot in a room name is literal");
    assert.equal(vb.belongsToRoom(ROOM, "neoconf-p16"), false);
  });

  console.log("/api/video/status for global-men-crusade (production's shape on 9 Oct)");
  ams["global-men-crusade-video"] = "broadcasting";
  ams["global-men-crusade-p16"] = "broadcasting";
  ams["neoconf-video"] = "broadcasting";
  groups["global-men-crusade-room"] = ["global-men-crusade-video", "global-men-crusade-p16"];
  await t("reports this room's channels (not neoconf-*), the programme live, and the programme as broadcaster", async () => {
    const j = await getStatus();
    assert.equal(j.ok, true);
    assert.ok(j.channels.every((c) => c.id.startsWith(`${ROOM}-`)), JSON.stringify(j.channels));
    assert.equal(j.channels.find((c) => c.id === `${ROOM}-video`)?.live, true);
    assert.deepEqual(j.broadcaster, { streamId: `${ROOM}-video`, label: "Programme", source: "default", live: true });
    assert.deepEqual(j.unknown, [`${ROOM}-p16`], "the participant camera is not a channel");
  });
  await t("off air: broadcaster reported not live (viewers see the waiting message)", async () => {
    ams["global-men-crusade-video"] = "finished";
    const j = await getStatus();
    assert.equal(j.broadcaster?.live, false);
    ams["global-men-crusade-video"] = "broadcasting";
  });
  await t("programme live outside the group (8 Oct shape) still reads live for its viewers", async () => {
    groups["global-men-crusade-room"] = ["global-men-crusade-p16"];
    const j = await getStatus();
    assert.equal(j.broadcaster?.live, true);
    groups["global-men-crusade-room"] = ["global-men-crusade-video", "global-men-crusade-p16"];
  });
  await t("a featured stream from another room is never sent to this room's viewers", async () => {
    // Live in AMS, so only the room check can keep it off this room's screens.
    ams["neoconf-p03"] = "broadcasting";
    await kv.set(`neo:video:featured:${ROOM}`, { streamId: "neoconf-p03", label: "Elsewhere", at: 1 });
    assert.equal((await getStatus()).featured, null);
    // This room's own live participant is still featured.
    await kv.set(`neo:video:featured:${ROOM}`, { streamId: `${ROOM}-p16`, label: "MC Abuja", at: 1 });
    assert.equal((await getStatus()).featured?.streamId, `${ROOM}-p16`);
    await kv.del(`neo:video:featured:${ROOM}`);
  });
  await t("a stored broadcaster that is not this room's stream is ignored, not shown", async () => {
    await kv.set(vb.broadcasterKey(ROOM), JSON.stringify({ streamId: "neoconf-video", label: "x", setBy: "?", at: 1 }));
    assert.equal((await getStatus()).broadcaster?.streamId, `${ROOM}-video`);
    await kv.del(vb.broadcasterKey(ROOM));
  });

  console.log("/api/video/room/broadcaster");
  const call = async (method: string, body?: unknown) => {
    const req = new Request(`https://x/api/video/room/broadcaster?room=${ROOM}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const h = (route as unknown as Record<string, (r: Request) => Promise<Response>>)[method];
    const res = await h(req);
    return { status: res.status, body: (await res.json()) as { ok: boolean; broadcaster?: { streamId: string; live: boolean; source: string } } };
  };
  await t("only a room admin can change it", async () => {
    g.__who = "user_staff";
    assert.equal((await call("POST", { streamId: `${ROOM}-p16` })).status, 403);
    g.__who = undefined;
    assert.equal((await call("GET")).status, 403);
  });
  await t("another room's stream or a booth is refused; a slot of this room is accepted and reaches viewers", async () => {
    g.__who = "user_host";
    assert.equal((await call("POST", { streamId: "neoconf-video" })).status, 400);
    assert.equal((await call("POST", { streamId: `${ROOM}-a-fr` })).status, 400);
    const ok = await call("POST", { streamId: `${ROOM}-p16`, label: "MC Abuja" });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.broadcaster?.streamId, `${ROOM}-p16`);
    const j = await getStatus();
    assert.deepEqual(j.broadcaster, { streamId: `${ROOM}-p16`, label: "MC Abuja", source: "assigned", live: true });
  });
  await t("DELETE goes back to the programme feed", async () => {
    const r = await call("DELETE");
    assert.equal(r.body.broadcaster?.streamId, `${ROOM}-video`);
    assert.equal(r.body.broadcaster?.source, "default");
  });

  console.log(`\n${n} checks passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
