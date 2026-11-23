import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * Big-meeting receiving in the room (components/conference/
 * bigMeetingSubscriptions.ts): in a real browser, with the room's own tiles
 * on a phone-sized page that scrolls, real IntersectionObserver and
 * MutationObserver, and the real livekit-client's event names — the room
 * itself stood in for, since there is no meeting. It must receive only the
 * cameras on screen and at most 10 unmuted microphones, follow the page as
 * it scrolls, hear someone the moment they unmute, and stop when told.
 */

const root = path.resolve(__dirname, "../..");

function moduleScript(file: string, name: string): string {
  const source = readFileSync(path.join(root, file), "utf8");
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, esModuleInterop: true },
  }).outputText;
  return `(function () {
    var module = { exports: {} };
    var exports = module.exports;
    var require = function (n) {
      if (n === "livekit-client") return window.LivekitClient;
      if (n === "@/lib/bigMeeting") return window.__mods.bigMeeting;
      if (n === "./roomLayout") return window.__mods.roomLayout;
      throw new Error("not stubbed: " + n);
    };
    ${code}
    window.__mods = window.__mods || {};
    window.__mods[${JSON.stringify(name)}] = module.exports;
  })();`;
}

const PEOPLE = 30;
const UNMUTED = 15;

async function open(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent(`<!doctype html><html><body style="margin:0">
    <div id=scroller style="position:absolute;inset:0;overflow-y:auto">
      <div id=grid style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:8px"></div>
    </div></body></html>`);
  await page.addScriptTag({ path: path.join(root, "node_modules/livekit-client/dist/livekit-client.umd.js") });
  await page.addScriptTag({ content: moduleScript("src/lib/bigMeeting.ts", "bigMeeting") });
  await page.addScriptTag({ content: moduleScript("src/components/conference/roomLayout.ts", "roomLayout") });
  await page.addScriptTag({ content: moduleScript("src/components/conference/bigMeetingSubscriptions.ts", "subs") });
  await page.evaluate(
    ({ PEOPLE, UNMUTED }) => {
      const LK = (window as unknown as { LivekitClient: { RoomEvent: Record<string, string>; Track: { Kind: Record<string, string>; Source: Record<string, string> } } }).LivekitClient;
      type Pub = { trackSid: string; kind: string; source: string; isMuted: boolean; isSubscribed: boolean; setSubscribed: (v: boolean) => void };
      const handlers = new Map<string, Set<(...a: unknown[]) => void>>();
      const room = {
        remoteParticipants: new Map<string, { identity: string; metadata: string; isLocal: boolean; trackPublications: Map<string, Pub> }>(),
        on(e: string, f: (...a: unknown[]) => void) { (handlers.get(e) ?? handlers.set(e, new Set()).get(e)!).add(f); return room; },
        off(e: string, f: (...a: unknown[]) => void) { handlers.get(e)?.delete(f); return room; },
        emit(e: string, ...a: unknown[]) { for (const f of handlers.get(e) ?? []) f(...a); },
      };
      const pub = (sid: string, kind: string, source: string, muted: boolean): Pub => ({
        trackSid: sid, kind, source, isMuted: muted, isSubscribed: false,
        setSubscribed(v: boolean) { this.isSubscribed = v; },
      });
      const grid = document.getElementById("grid")!;
      const add = (i: number, role = "attendee") => {
        const id = "p" + i;
        const pubs = new Map<string, Pub>([
          ["mic" + i, pub("mic" + i, LK.Track.Kind.Audio, LK.Track.Source.Microphone, i >= UNMUTED)],
          ["cam" + i, pub("cam" + i, LK.Track.Kind.Video, LK.Track.Source.Camera, false)],
        ]);
        room.remoteParticipants.set(id, { identity: id, metadata: JSON.stringify({ role }), isLocal: false, trackPublications: pubs });
        const tile = document.createElement("div");
        tile.setAttribute("data-lk-participant-identity", id);
        tile.style.cssText = "height:150px;background:#333";
        grid.appendChild(tile);
      };
      for (let i = 0; i < PEOPLE; i++) add(i);
      const w = window as unknown as Record<string, unknown>;
      w.__room = room;
      w.__add = add;
      w.__LK = LK;
      w.__subs = () => {
        const out = { mics: [] as string[], cams: [] as string[] };
        for (const p of room.remoteParticipants.values()) for (const x of p.trackPublications.values()) if (x.isSubscribed) (x.kind === LK.Track.Kind.Audio ? out.mics : out.cams).push(p.identity);
        return out;
      };
      w.__onScreen = () =>
        Array.from(document.querySelectorAll("[data-lk-participant-identity]"))
          .filter((el) => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; })
          .map((el) => el.getAttribute("data-lk-participant-identity"));
      w.__stop = (w.__mods as { subs: { startReceiving: (r: unknown) => () => void } }).subs.startReceiving(room);
    },
    { PEOPLE, UNMUTED },
  );
}

const subs = (page: Page) => page.evaluate(() => (window as unknown as { __subs: () => { mics: string[]; cams: string[] } }).__subs());
const onScreen = (page: Page) => page.evaluate(() => (window as unknown as { __onScreen: () => string[] }).__onScreen());
const sorted = (a: string[]) => [...a].sort();

test("receives only the cameras on screen, and at most 10 unmuted microphones", async ({ page }) => {
  await open(page);
  await expect.poll(async () => (await subs(page)).cams.length).toBeGreaterThan(0);
  const s = await subs(page);
  expect(sorted(s.cams)).toEqual(sorted(await onScreen(page)));
  expect(s.cams.length).toBeLessThan(PEOPLE);
  expect(s.mics.length).toBe(10);
  for (const id of s.mics) expect(Number(id.slice(1)), "only unmuted microphones").toBeLessThan(UNMUTED);
});

test("scrolling: the cameras that come on screen are received, those scrolled away let go", async ({ page }) => {
  await open(page);
  await expect.poll(async () => (await subs(page)).cams.length).toBeGreaterThan(0);
  const before = (await subs(page)).cams;
  await page.evaluate(() => { const s = document.getElementById("scroller")!; s.scrollTop = s.scrollHeight; });
  await expect.poll(async () => sorted((await subs(page)).cams)).toEqual(sorted(await onScreen(page)));
  const after = (await subs(page)).cams;
  expect(after).toContain("p" + (PEOPLE - 1));
  expect(after).not.toContain(before[0]);
});

test("someone who unmutes is heard at once, even past the 10", async ({ page }) => {
  await open(page);
  await expect.poll(async () => (await subs(page)).mics.length).toBe(10);
  await page.evaluate(() => {
    const w = window as unknown as { __room: { remoteParticipants: Map<string, { trackPublications: Map<string, { isMuted: boolean }> }>; emit: (e: string, ...a: unknown[]) => void }; __LK: { RoomEvent: Record<string, string> } };
    const p = w.__room.remoteParticipants.get("p25")!;
    const mic = p.trackPublications.get("mic25")!;
    mic.isMuted = false;
    w.__room.emit(w.__LK.RoomEvent.TrackUnmuted, mic, p);
  });
  await expect.poll(async () => (await subs(page)).mics).toContain("p25");
  expect((await subs(page)).mics.length).toBe(10);
});

test("a Host's unmuted microphone is always among those heard", async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const w = window as unknown as { __add: (i: number, role: string) => void; __room: { remoteParticipants: Map<string, { trackPublications: Map<string, { isMuted: boolean }> }>; emit: (e: string, ...a: unknown[]) => void }; __LK: { RoomEvent: Record<string, string> } };
    w.__add(99, "host");
    const p = w.__room.remoteParticipants.get("p99")!;
    p.trackPublications.get("mic99")!.isMuted = false;
    w.__room.emit(w.__LK.RoomEvent.ParticipantConnected, p);
  });
  await expect.poll(async () => (await subs(page)).mics).toContain("p99");
});

test("someone who mutes is let go; stopped, it changes nothing more", async ({ page }) => {
  await open(page);
  await expect.poll(async () => (await subs(page)).mics.length).toBe(10);
  const heard = (await subs(page)).mics[0];
  await page.evaluate((id) => {
    const w = window as unknown as { __room: { remoteParticipants: Map<string, { trackPublications: Map<string, { isMuted: boolean }> }>; emit: (e: string, ...a: unknown[]) => void }; __LK: { RoomEvent: Record<string, string> } };
    const p = w.__room.remoteParticipants.get(id)!;
    const mic = p.trackPublications.get("mic" + id.slice(1))!;
    mic.isMuted = true;
    w.__room.emit(w.__LK.RoomEvent.TrackMuted, mic, p);
  }, heard);
  await expect.poll(async () => (await subs(page)).mics).not.toContain(heard);
  await page.evaluate(() => (window as unknown as { __stop: () => void }).__stop());
  const frozen = await subs(page);
  await page.evaluate(() => { const s = document.getElementById("scroller")!; s.scrollTop = s.scrollHeight; });
  await page.waitForTimeout(800);
  expect(await subs(page)).toEqual(frozen);
});

test("the room is wired to it: the token's answer decides how it connects, what it publishes and whether it receives selectively", () => {
  const src = readFileSync(path.join(root, "src/app/room/[name]/page.tsx"), "utf8");
  expect(src).toContain("setReceiveMode(receiveModeOf(data))");
  expect(src).toContain('connectOptions={{ autoSubscribe: receiveMode.receive !== "selective" }}');
  expect(src).toContain("audio={joinMedia(receiveMode.joinMuted ? false : choices.audioEnabled, choices.audioDeviceId)}");
  expect(src).toMatch(/receiveMode\.receive === "selective" && <BigMeetingReceiver /);
});
