// The load test's phone (see README.md): a 3-column phone grid with a tile per
// person, as the room's phone layout. mode=all receives everything (the site
// before big-meeting receiving); mode=selective runs the site's own receiver
// (startReceiving), so the test measures the real code, not a copy of it.
//
// Bundled into big-meeting-phone.js by `npm run loadtest:build`.
import { Room, RoomEvent, Track } from "livekit-client";
import { startReceiving } from "../../src/components/conference/bigMeetingSubscriptions";
import { ROOM_OPTIONS } from "../../src/components/conference/roomOptions";

type Stats = {
  mode: "all" | "selective";
  connected: boolean;
  joinMs: number;
  reconnecting: number;
  reconnected: number;
  disconnected: number;
  remote: number;
  audioSubs: number;
  videoSubs: number;
  blockedMs: number;
  log: string[];
};

const q = new URLSearchParams(location.search);
const mode = q.get("mode") === "selective" ? "selective" : "all";
const grid = document.getElementById("grid")!;
const s: Stats = { mode, connected: false, joinMs: 0, reconnecting: 0, reconnected: 0, disconnected: 0, remote: 0, audioSubs: 0, videoSubs: 0, blockedMs: 0, log: [] };
(window as unknown as { __s: Stats }).__s = s;

// Time the main thread spent blocked (long tasks): what a slow phone feels.
new PerformanceObserver((l) => {
  for (const e of l.getEntries()) s.blockedMs += e.duration;
}).observe({ entryTypes: ["longtask"] });

const room = new Room(ROOM_OPTIONS);
const tiles = new Map<string, HTMLElement>();
const tile = (id: string) => {
  let t = tiles.get(id);
  if (!t) {
    t = document.createElement("div");
    t.className = "tile";
    t.setAttribute("data-lk-participant-identity", id);
    grid.appendChild(t);
    tiles.set(id, t);
  }
  return t;
};
const count = () => {
  let a = 0;
  let v = 0;
  for (const p of room.remoteParticipants.values())
    for (const pub of p.trackPublications.values()) {
      if (!pub.isSubscribed) continue;
      if (pub.kind === Track.Kind.Audio) a++;
      else v++;
    }
  s.audioSubs = a;
  s.videoSubs = v;
  s.remote = room.remoteParticipants.size;
};

room
  .on(RoomEvent.Connected, () => {
    for (const p of room.remoteParticipants.values()) tile(p.identity);
  })
  .on(RoomEvent.ParticipantConnected, (p) => tile(p.identity))
  .on(RoomEvent.ParticipantDisconnected, (p) => {
    tiles.get(p.identity)?.remove();
    tiles.delete(p.identity);
  })
  .on(RoomEvent.Reconnecting, () => {
    s.reconnecting++;
    s.log.push(Date.now() + " reconnecting");
  })
  .on(RoomEvent.Reconnected, () => {
    s.reconnected++;
    s.log.push(Date.now() + " reconnected");
  })
  .on(RoomEvent.Disconnected, (r) => {
    s.disconnected++;
    s.connected = false;
    s.log.push(Date.now() + " disconnected " + r);
  })
  .on(RoomEvent.TrackSubscribed, (t, _p, who) => {
    const el = t.attach();
    if (t.kind === Track.Kind.Video) {
      (el as HTMLVideoElement).muted = true;
      tile(who.identity).appendChild(el);
    } else document.body.appendChild(el);
    count();
  })
  .on(RoomEvent.TrackUnsubscribed, (t) => {
    t.detach().forEach((e) => e.remove());
    count();
  });
setInterval(count, 1000);

const t0 = performance.now();
room.connect(q.get("url")!, q.get("token")!, { autoSubscribe: mode === "all" }).then(
  () => {
    s.connected = true;
    s.joinMs = Math.round(performance.now() - t0);
    if (mode === "selective") startReceiving(room);
  },
  (e) => s.log.push("connect failed " + e),
);
