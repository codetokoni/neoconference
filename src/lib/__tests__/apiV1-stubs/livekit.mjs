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
  // Rooms open now: globalThis.__rooms = [{ name, numParticipants }].
  async listRooms() { return (globalThis.__rooms ?? []).map((r) => ({ ...r })); }
}
