// LiveKit server SDK: real classes, except the clients that call the server.
export * from "real:livekit";
globalThis.__egress ??= { started: [], stopped: [], active: [] };
let n = 0;
export class EgressClient {
  async startRoomCompositeEgress(room, output, opts) {
    if (globalThis.__egressFails) throw new Error("requested room does not exist");
    const egressId = `EG_${++n}`;
    const filepath = output?.filepath ?? output?.file?.filepath;
    globalThis.__egress.started.push({ room, filepath, opts });
    globalThis.__egress.active.push({ egressId, roomName: room });
    return { egressId };
  }
  async listEgress({ roomName, active } = {}) {
    return globalThis.__egress.active.filter((e) => (!roomName || e.roomName === roomName) && (active ? true : true));
  }
  async stopEgress(id) {
    globalThis.__egress.stopped.push(id);
    globalThis.__egress.active = globalThis.__egress.active.filter((e) => e.egressId !== id);
    return { egressId: id };
  }
}
export class RoomServiceClient {
  async createRoom(o) { return o; }
  async deleteRoom() {}
  async listRooms() {
    if (globalThis.__livekitDown) throw new Error("twirp error unavailable");
    return globalThis.__rooms ?? [];
  }
  // Who is in a room, only when a test sets globalThis.__lkParticipants
  // ({ room: [{ identity }] }); otherwise it throws, as it always did, so
  // routes that fail open on it behave as before.
  async listParticipants(room) {
    const all = globalThis.__lkParticipants;
    if (!all) throw new Error("listParticipants: not stubbed");
    return all[room] ?? [];
  }
  // One participant, from the same globalThis.__lkParticipants entries
  // ({ identity, sid, joinedAt (seconds) }); as LiveKit, a miss throws.
  async getParticipant(room, identity) {
    const all = globalThis.__lkParticipants;
    if (!all) throw new Error("getParticipant: not stubbed");
    const p = (all[room] ?? []).find((x) => x.identity === identity);
    if (!p) throw new Error("twirp error not_found: participant not found");
    return p;
  }
  // Recorded in globalThis.__lkRemoved ([{ room, identity }]) and taken out
  // of globalThis.__lkParticipants; as LiveKit, someone not there throws.
  async removeParticipant(room, identity) {
    const list = globalThis.__lkParticipants?.[room] ?? [];
    if (!list.some((x) => x.identity === identity)) throw new Error("twirp error not_found: participant not found");
    globalThis.__lkParticipants[room] = list.filter((x) => x.identity !== identity);
    (globalThis.__lkRemoved ??= []).push({ room, identity });
    return {};
  }
  // Recorded in globalThis.__lkMuted ([{ room, identity, trackSid, muted }]).
  async mutePublishedTrack(room, identity, trackSid, muted) {
    (globalThis.__lkMuted ??= []).push({ room, identity, trackSid, muted });
    return {};
  }
  // Both of LiveKit's forms: (room, identity, { metadata, permission }) and
  // (room, identity, metadata, permission). Applied to the participant in
  // globalThis.__lkParticipants and recorded in globalThis.__lkUpdated.
  async updateParticipant(room, identity, a, b) {
    const opts = typeof a === "object" && a !== null ? a : { metadata: a, permission: b };
    const p = (globalThis.__lkParticipants?.[room] ?? []).find((x) => x.identity === identity);
    if (!p) throw new Error("twirp error not_found: participant not found");
    if (opts.metadata !== undefined) p.metadata = opts.metadata;
    if (opts.permission !== undefined) p.permission = { ...opts.permission };
    (globalThis.__lkUpdated ??= []).push({ room, identity, ...opts });
    return p;
  }
  // Recorded in globalThis.__lkData ([{ room, data (parsed JSON), kind, options }]).
  async sendData(room, data, kind, options) {
    let parsed;
    try { parsed = JSON.parse(new TextDecoder().decode(data)); } catch { parsed = null; }
    (globalThis.__lkData ??= []).push({ room, data: parsed, kind, options });
    return {};
  }
}
