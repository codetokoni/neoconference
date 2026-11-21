import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { enlargedTileGone } from "../../src/components/conference/roomLayout";

/**
 * The meeting room's layout on a computer: the toolbar's own band, tile
 * menus on the right tiles, and a menu that stays with its tile.
 *
 * Each test is a bug the room shipped with:
 * - the top toolbar floated over the first row of tiles, covering their
 *   names, menus and enlarge buttons;
 * - tile menus were put on the first tile with the person's display name,
 *   so two people of one name (or one person on two devices, or a person
 *   and their own screen share) shared one menu, sometimes the other's;
 * - viewers who were not hosts got no tile menu at all on a computer,
 *   although "Hide on my screen" is for everyone;
 * - an open menu stayed where it opened when the tiles moved, over
 *   whoever slid into that place;
 * - an enlarged tile stayed enlarged after that person left or was hidden,
 *   on an empty stage, until a refresh;
 * - spotlight and breakout rooms found tiles only by an attribute LiveKit's
 *   computer tiles never had, so on a computer the spotlight highlighted
 *   nobody and a breakout hid nobody; spotlight also shared the double-click
 *   with "enlarge on my screen", and people who joined later never heard of
 *   a spotlight already on;
 * - hiding a video, and the role badges, went by display name: hiding one
 *   Grace hid every Grace, and the host's badge went on every tile of the
 *   host's name;
 * - on a phone, the meeting timer floated over the first row's right-hand
 *   tile and took the taps meant for its menu button, and the host's
 *   spotlight hint sat over the bottom row for the whole meeting.
 *
 * The components run as they are, with real React in a browser; LiveKit's
 * hooks are stood in for, since there is no meeting.
 */

const root = path.resolve(__dirname, "../..");

function umd(pkg: string, file: string): string {
  return path.join(path.dirname(require.resolve(pkg + "/package.json")), "umd", file);
}

/** A source file as a script that puts its exports at window.__mods[name]. */
function moduleScript(file: string, name: string): string {
  const source = readFileSync(path.join(root, file), "utf8");
  const code = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2019,
      jsx: ts.JsxEmit.React,
      esModuleInterop: true,
    },
  }).outputText;
  return `(function () {
    var module = { exports: {} };
    var exports = module.exports;
    var require = function (name) {
      if (name === "react") return window.React;
      if (name === "react-dom") return window.ReactDOM;
      if (name === "@livekit/components-react") return window.__lk;
      if (name === "@/components/HiddenVideosProvider") return window.__hidden;
      if (name === "@/hooks/useIsMobile") return { useIsMobile: function () { return false; } };
      if (name === "./HostTileMenu") return window.__mods.HostTileMenu;
      if (name === "./MobileParticipantTile") return window.__mods.MobileParticipantTile;
      if (name === "./keptPlace") return window.__mods.keptPlace;
      if (name === "./micLockClient" || name === "@/components/conference/micLockClient") return window.__mods.micLockClient;
      if (name === "./MuteEveryone") return window.__mods.MuteEveryone;
      // The room page's /room/<room>?event=<slug>; none here, so the room's name.
      if (name === "next/navigation") return { useParams: function () { return null; }, useSearchParams: function () { return null; } };
      if (name === "livekit-client") return {
        RoomEvent: { DataReceived: "dataReceived", ParticipantConnected: "participantConnected", ParticipantDisconnected: "participantDisconnected", ParticipantPermissionsChanged: "participantPermissionsChanged", Connected: "connected", Reconnected: "reconnected" },
        ParticipantEvent: new Proxy({}, { get: function (_t, k) { return String(k); } }),
        Track: { Source: { Camera: "camera", Microphone: "microphone", ScreenShare: "screen_share" } },
      };
      if (name === "framer-motion") return {
        motion: new Proxy({}, { get: function (_t, tag) {
          return window.React.forwardRef(function (props, ref) {
            var rest = Object.assign({}, props);
            ["initial", "animate", "exit", "transition", "layout", "layoutId", "whileTap", "whileHover", "variants"].forEach(function (k) { delete rest[k]; });
            rest.ref = ref;
            return window.React.createElement(tag, rest);
          });
        } }),
        AnimatePresence: function (p) { return p.children; },
        LayoutGroup: function (p) { return p.children; },
      };
      if (name === "@/lib/avatarColor") return {
        getAvatarColor: function () { return "#334455"; },
        getAvatarColorRGB: function () { return "51,68,85"; },
        getInitials: function (s) { return String(s).slice(0, 2).toUpperCase(); },
      };
      if (name === "@/components/SpotlightOverlay") return window.__mods.SpotlightOverlay;
      if (name === "@/components/conference/roomLayout") return window.__mods.roomLayout;
      if (name === "@/components/conference/phoneStatusSlot") return window.__mods.phoneStatusSlot;
      if (name === "@/lib/timer") return window.__mods.timer;
      if (name === "@/lib/kv") return { kv: {} };
      if (name === "lucide-react") return new Proxy({}, { get: function () { return function () { return null; }; } });
      throw new Error("unexpected import " + name);
    };
    ${code}
    window.__mods = window.__mods || {};
    window.__mods[${JSON.stringify(name)}] = module.exports;
  })();`;
}

type Person = { identity: string; name: string; metadata?: string };
type Sent = { msg: { identity: string | null; ts: number }; opts: { topic?: string; destinationIdentities?: string[] } };
type Win = {
  React: typeof import("react");
  ReactDOM: { createRoot: typeof import("react-dom/client").createRoot };
  __mods: Record<string, Record<string, unknown>>;
  __participants: Person[];
  __sent: Sent[];
  __room: { emit: (event: string, ...args: unknown[]) => void; remoteParticipants: Map<string, Person> };
};

async function load(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setContent("<!doctype html><html><head><style>body{margin:0}</style></head><body><div id=app></div></body></html>");
  await page.addScriptTag({ path: umd("react", "react.production.min.js") });
  await page.addScriptTag({ path: umd("react-dom", "react-dom.production.min.js") });
  await page.addScriptTag({
    content: `
      window.__participants = [];
      window.__sent = [];
      // A LiveKit room that records what is broadcast and lets a test send
      // it events (someone joins, a spotlight message arrives).
      window.__room = {
        handlers: {},
        on: function (e, f) { (this.handlers[e] = this.handlers[e] || []).push(f); return this; },
        off: function (e, f) { this.handlers[e] = (this.handlers[e] || []).filter(function (g) { return g !== f; }); return this; },
        emit: function (e) { var args = Array.prototype.slice.call(arguments, 1); (this.handlers[e] || []).forEach(function (f) { f.apply(null, args); }); },
        localParticipant: {
          identity: "me#1",
          publishData: function (payload, opts) {
            window.__sent.push({ msg: JSON.parse(new TextDecoder().decode(payload)), opts: opts });
            return Promise.resolve();
          },
        },
        remoteParticipants: new Map(),
      };
      window.__lk = {
        useParticipants: function () { return window.__participants; },
        useLocalParticipant: function () { return { localParticipant: window.__room.localParticipant, isMicrophoneEnabled: !!window.__micOn, isCameraEnabled: false }; },
        ControlBar: function (props) { return window.React.createElement("div", { "data-lk-stock-bar": "", style: props && props.style }); },
        useRoomContext: function () { return window.__room; },
        useRoomInfo: function () { return { name: window.__room.name || "", metadata: undefined }; },
        useIsSpeaking: function () { return false; },
        useTracks: function () { return []; },
        VideoTrack: function () { return null; },
      };
      window.__hidden = { useHiddenVideos: function () { return {
        isHiddenLocally: function () { return false; },
        isHiddenGlobally: function () { return false; },
        isHidden: function () { return false; },
        hiddenSet: window.__hiddenSet || new Set(),
        toggleLocal: function () {},
        toggleGlobal: function () { return Promise.resolve(); },
      }; } };`,
  });
  await page.addScriptTag({ content: moduleScript("src/components/conference/roomLayout.ts", "roomLayout") });
  await page.addScriptTag({ content: moduleScript("src/components/conference/phoneStatusSlot.ts", "phoneStatusSlot") });
  await page.addScriptTag({ content: moduleScript("src/lib/timer.ts", "timer") });
  await page.addScriptTag({ content: moduleScript("src/components/MeetingTimer.tsx", "MeetingTimer") });
  await page.addScriptTag({ content: moduleScript("src/components/SpotlightOverlay.tsx", "SpotlightOverlay") });
  await page.addScriptTag({ content: moduleScript("src/components/conference/micLockClient.ts", "micLockClient") });
  await page.addScriptTag({ content: moduleScript("src/components/HostTileMenu.tsx", "HostTileMenu") });
  await page.addScriptTag({ content: moduleScript("src/components/conference/MobileParticipantTile.tsx", "MobileParticipantTile") });
  await page.addScriptTag({ content: moduleScript("src/components/HostMenuOverlay.tsx", "HostMenuOverlay") });
  await page.addScriptTag({ content: moduleScript("src/components/HiddenVideoOverlay.tsx", "HiddenVideoOverlay") });
  await page.addScriptTag({ content: moduleScript("src/components/TileRoleBadges.tsx", "TileRoleBadges") });
  return errors;
}

/**
 * LiveKit's grid as it is in the DOM: a tile per camera (and per screen
 * share), named by display name; NeoVideoConference adds who it is.
 */
async function tiles(page: Page, list: { id: string; name: string; source: "camera" | "screen_share"; local?: boolean }[]) {
  await page.evaluate((list) => {
    const grid = document.createElement("div");
    grid.id = "grid";
    grid.style.cssText = "display:grid;grid-template-columns:repeat(3,240px);gap:12px;padding:12px";
    for (const t of list) {
      const el = document.createElement("div");
      el.className = "lk-participant-tile";
      el.style.cssText = "position:relative;height:160px;background:#222;overflow:hidden";
      el.setAttribute("data-neo-identity", t.id);
      el.setAttribute("data-neo-source", t.source);
      if (t.local) el.setAttribute("data-lk-local-participant", "true");
      const name = document.createElement("span");
      name.setAttribute("data-lk-participant-name", t.name);
      name.textContent = t.source === "screen_share" ? `${t.name}'s screen` : t.name;
      el.appendChild(name);
      el.id = `${t.id}:${t.source}`;
      grid.appendChild(el);
    }
    document.body.insertBefore(grid, document.getElementById("app"));
  }, list);
}

async function renderOverlay(page: Page, people: Person[], isHost: boolean) {
  await page.evaluate(
    ({ people, isHost }) => {
      const w = window as unknown as Win;
      w.__participants = people;
      for (const p of people) if (p.identity !== "me#1") w.__room.remoteParticipants.set(p.identity, p);
      const Overlay = w.__mods.HostMenuOverlay.default as (p: { isHost: boolean; roomRole: string; slug: string }) => null;
      const Spotlight = w.__mods.SpotlightOverlay.default as (p: { isHost: boolean }) => null;
      const h = w.React.createElement;
      w.ReactDOM.createRoot(document.getElementById("app")!).render(
        h(
          w.React.Fragment,
          null,
          h(Overlay, { isHost, roomRole: isHost ? "host" : "attendee", slug: "weekly" }),
          h(Spotlight, { isHost }),
        ),
      );
    },
    { people, isHost },
  );
}

/** Whose menus each tile holds, by tile id. */
const menusByTile = (page: Page) =>
  page.evaluate(() =>
    Object.fromEntries(
      Array.from(document.querySelectorAll(".lk-participant-tile")).map((t) => [
        t.id,
        Array.from(t.querySelectorAll("[data-neo-menu-for]")).map((m) => m.getAttribute("data-neo-menu-for")),
      ]),
    ),
  );

const grace1 = { identity: "user_g#1", name: "Grace" };
const grace2 = { identity: "user_g#2", name: "Grace" }; // the same Grace on her phone
const ada = { identity: "user_a#1", name: "Ada" };
const me = { identity: "me#1", name: "Victor" };

test("each person's menu goes on their own camera tile, whatever the names", async ({ page }) => {
  const errors = await load(page);
  // Grace's screen share comes first in the grid, as an enlarged share does.
  await tiles(page, [
    { id: grace1.identity, name: "Grace", source: "screen_share" },
    { id: grace2.identity, name: "Grace", source: "camera" },
    { id: grace1.identity, name: "Grace", source: "camera" },
    { id: ada.identity, name: "Ada", source: "camera" },
    { id: me.identity, name: "Victor", source: "camera", local: true },
  ]);
  await renderOverlay(page, [me, grace1, grace2, ada], false);
  await expect(page.locator("[data-neo-menu-for]")).toHaveCount(3);
  expect(await menusByTile(page)).toEqual({
    "user_g#1:screen_share": [],
    "user_g#2:camera": ["user_g#2"],
    "user_g#1:camera": ["user_g#1"],
    "user_a#1:camera": ["user_a#1"],
    "me#1:camera": [],
  });

  // A new speaker reorders the grid: the menus go with their people.
  await page.evaluate(() => {
    const grid = document.getElementById("grid")!;
    grid.insertBefore(document.getElementById("user_a#1:camera")!, grid.firstChild);
    grid.appendChild(document.getElementById("user_g#2:camera")!);
  });
  await expect
    .poll(() => menusByTile(page))
    .toEqual({
      "user_a#1:camera": ["user_a#1"],
      "user_g#1:screen_share": [],
      "user_g#1:camera": ["user_g#1"],
      "me#1:camera": [],
      "user_g#2:camera": ["user_g#2"],
    });
  expect(errors).toEqual([]);
});

test("a viewer who is not a host gets the menu with what they may do; a host gets the rest", async ({ page }) => {
  await load(page);
  await tiles(page, [{ id: ada.identity, name: "Ada", source: "camera" }]);
  await renderOverlay(page, [me, ada], false);
  await page.getByRole("button", { name: "Options for Ada" }).click();
  await expect(page.getByText("Hide on my screen")).toBeVisible();
  await expect(page.getByText("Hide video for everyone")).toHaveCount(0);
  await expect(page.getByText("Remove")).toHaveCount(0);

  await page.reload();
  await load(page);
  await tiles(page, [{ id: ada.identity, name: "Ada", source: "camera" }]);
  await renderOverlay(page, [me, ada], true);
  await page.getByRole("button", { name: "Options for Ada" }).click();
  await expect(page.getByText("Hide video for everyone")).toBeVisible();
});

test("an open menu follows its tile, and closes when the person leaves", async ({ page }) => {
  const errors = await load(page);
  await page.setViewportSize({ width: 1000, height: 700 });
  await tiles(page, [
    { id: ada.identity, name: "Ada", source: "camera" },
    { id: grace1.identity, name: "Grace", source: "camera" },
  ]);
  await renderOverlay(page, [me, ada, grace1], true);
  await page.getByRole("button", { name: "Options for Grace" }).click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  const before = await menu.boundingBox();
  const button = await page.getByRole("button", { name: "Options for Grace" }).boundingBox();
  expect(Math.abs(before!.y - (button!.y + button!.height + 4))).toBeLessThan(2);

  // The grid reflows (a panel opened): Grace's tile drops to the next row.
  await page.evaluate(() => {
    (document.getElementById("grid") as HTMLElement).style.gridTemplateColumns = "240px";
  });
  await expect.poll(async () => (await menu.boundingBox())!.y).toBeGreaterThan(before!.y + 100);
  const moved = await page.getByRole("button", { name: "Options for Grace" }).boundingBox();
  const after = await menu.boundingBox();
  expect(Math.abs(after!.y - (moved!.y + moved!.height + 4)) < 2 || after!.y + after!.height <= moved!.y).toBe(true);
  // Inside the window, whichever way it opened.
  expect(after!.y).toBeGreaterThanOrEqual(0);
  expect(after!.y + after!.height).toBeLessThanOrEqual(700);

  // Grace leaves: her tile goes, and so does the menu.
  await page.evaluate(() => {
    (window as unknown as Win).__participants = (window as unknown as Win).__participants.filter((p) => p.identity !== "user_g#1");
    document.getElementById("user_g#1:camera")!.remove();
  });
  await expect(menu).toHaveCount(0);
  expect(errors).toEqual([]);
});

/**
 * What the page asks /api/livekit/moderate to do. The test page has no
 * address of its own, so its relative fetches are answered here.
 */
async function recordModeration(page: Page): Promise<() => Promise<unknown[]>> {
  await page.evaluate(() => {
    const w = window as unknown as { __moderated: unknown[] };
    w.__moderated = [];
    window.fetch = (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/api/livekit/moderate")) w.__moderated.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
  });
  return () => page.evaluate(() => (window as unknown as { __moderated: unknown[] }).__moderated);
}

/** Replace a tile with a new element, as LiveKit does when it rebuilds one. */
const rebuild = (page: Page, id: string) =>
  page.evaluate((id) => {
    const old = document.getElementById(id)!;
    const fresh = document.createElement("div");
    fresh.className = old.className;
    fresh.style.cssText = old.style.cssText;
    for (const a of ["data-neo-identity", "data-neo-source", "id"]) fresh.setAttribute(a, old.getAttribute(a)!);
    fresh.appendChild(old.querySelector("[data-lk-participant-name]")!.cloneNode(true));
    old.replaceWith(fresh);
  }, id);

test("a host's menu stays open while the person's tile is rebuilt or off the page, and Mute microphone still mutes them", async ({ page }) => {
  const errors = await load(page);
  const sent = await recordModeration(page);
  await page.setViewportSize({ width: 1000, height: 700 });
  await tiles(page, [
    { id: ada.identity, name: "Ada", source: "camera" },
    { id: grace1.identity, name: "Grace", source: "camera" },
  ]);
  await renderOverlay(page, [me, ada, grace1], true);
  await page.getByRole("button", { name: "Options for Grace" }).click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();

  // Grace turns her camera on: LiveKit builds her a new tile.
  await rebuild(page, "user_g#1:camera");
  await expect(page.locator('#user_g\\#1\\:camera [data-neo-menu-for="user_g#1"]')).toHaveCount(1);
  await expect(menu).toBeVisible();
  await expect(page.getByRole("button", { name: "Options for Grace" })).toHaveAttribute("aria-expanded", "true");

  // A new speaker takes her place on the page: no tile for a moment.
  await page.evaluate(() => document.getElementById("user_g#1:camera")!.remove());
  await page.waitForTimeout(300);
  await expect(menu).toBeVisible();

  await menu.getByRole("menuitem", { name: "Mute microphone" }).click();
  await expect.poll(sent).toEqual([{ slug: "weekly", action: "muteAudio", participantIdentity: "user_g#1" }]);
  await expect(menu).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("one menu at a time: opening another person's closes the first; a click outside closes it", async ({ page }) => {
  await load(page);
  await tiles(page, [
    { id: ada.identity, name: "Ada", source: "camera" },
    { id: grace1.identity, name: "Grace", source: "camera" },
  ]);
  await renderOverlay(page, [me, ada, grace1], true);
  await page.getByRole("button", { name: "Options for Grace" }).click();
  await expect(page.getByRole("menu")).toContainText("Grace");
  await page.getByRole("button", { name: "Options for Ada" }).click();
  await expect(page.getByRole("menu")).toHaveCount(1);
  await expect(page.getByRole("menu")).toContainText("Ada");
  await page.getByRole("button", { name: "Options for Ada" }).click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await page.getByRole("button", { name: "Options for Ada" }).click();
  await page.mouse.click(5, 690);
  await expect(page.getByRole("menu")).toHaveCount(0);
});

test("on a phone, tapping an item in a tile's menu sheet does it", async ({ page }) => {
  const errors = await load(page);
  const sent = await recordModeration(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    const w = window as unknown as Win & { __grace: unknown };
    w.__grace = {
      identity: "user_g#1",
      name: "Grace",
      isLocal: false,
      isCameraEnabled: false,
      isMicrophoneEnabled: true,
      metadata: "",
      on() { return this; },
      off() { return this; },
      getTrackPublication() { return undefined; },
    };
    const Tile = w.__mods.MobileParticipantTile.MobileParticipantTile as (p: Record<string, unknown>) => null;
    w.ReactDOM.createRoot(document.getElementById("app")!).render(
      w.React.createElement("div", { style: { width: 180 } }, w.React.createElement(Tile, { participant: w.__grace, localIsHost: true, localIsHostRank: true, participantIsHost: false, slug: "weekly" })),
    );
  });
  await page.getByRole("button", { name: "Options for Grace" }).click();
  const sheet = page.getByRole("menu", { name: "Options for Grace" });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: /Mute mic/ }).click();
  await expect.poll(sent).toEqual([{ slug: "weekly", action: "muteAudio", participantIdentity: "user_g#1" }]);
  // A tap on the dimmed backdrop still closes it.
  await page.getByRole("button", { name: "Options for Grace" }).click();
  await expect(sheet).toBeVisible();
  await page.mouse.click(195, 30);
  await expect(sheet).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a menu near the bottom-right corner opens inside the window", async ({ page }) => {
  await load(page);
  await page.setViewportSize({ width: 800, height: 520 });
  await tiles(page, [
    { id: me.identity, name: "Victor", source: "camera", local: true },
    { id: grace1.identity, name: "Grace", source: "camera" },
    { id: grace2.identity, name: "Grace", source: "camera" },
    { id: ada.identity, name: "Ada", source: "camera" },
  ]);
  await page.evaluate(() => {
    const grid = document.getElementById("grid") as HTMLElement;
    grid.style.cssText += ";position:fixed;right:0;bottom:0;grid-template-columns:repeat(2,240px)";
  });
  await renderOverlay(page, [me, grace1, grace2, ada], true);
  await page.locator('[data-neo-menu-for="user_a#1"] button').click();
  const box = (await page.getByRole("menu").boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(800);
  expect(box.y + box.height).toBeLessThanOrEqual(520);
});

test("the toolbar has its own band: the first row starts below it, moves with it, and takes it back", async ({ page }) => {
  const errors = await load(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addStyleTag({ content: readFileSync(path.join(root, "src/app/room/[name]/initials-overlay.css"), "utf8") });
  await page.evaluate(() => {
    const shell = document.createElement("div");
    shell.className = "room-shell";
    shell.setAttribute("data-lk-theme", "default");
    shell.style.position = "relative";
    shell.innerHTML = `
      <div class="room-toolbar" data-room-chrome="true" style="position:absolute;top:8px;left:50%;transform:translateX(-50%);z-index:12;display:flex;padding:6px 8px;height:32px;background:#123">
        <button>Chat</button><button>Participants</button>
      </div>
      <div class="lk-video-conference" style="display:block;height:100%">
        <div class="lk-participant-tile" id="first" style="height:200px;position:relative;background:#333">
          <span data-lk-participant-name="Ada">Ada</span>
          <button id="menu" style="position:absolute;top:6px;right:44px">⋮</button>
        </div>
      </div>`;
    document.body.appendChild(shell);
    const w = window as unknown as Win;
    const watch = w.__mods.roomLayout.watchToolbarSpace as (s: HTMLElement, b: HTMLElement) => () => void;
    watch(shell, shell.querySelector(".room-toolbar") as HTMLElement);
  });
  const toolbar = page.locator(".room-toolbar");
  const first = page.locator("#first");

  // Shown without hovering, and the first row's menu is clickable, not under it.
  await expect(toolbar).toHaveCSS("opacity", "1");
  const bar = (await toolbar.boundingBox())!;
  await expect.poll(async () => (await first.boundingBox())!.y).toBeGreaterThanOrEqual(bar.y + bar.height);
  await page.locator("#menu").click({ timeout: 2000 }); // fails if the toolbar intercepts it

  // The toolbar grows (a recording banner, larger text): the grid moves down.
  await page.evaluate(() => ((document.querySelector(".room-toolbar") as HTMLElement).style.height = "80px"));
  const grown = (await toolbar.boundingBox())!;
  await expect.poll(async () => (await first.boundingBox())!.y).toBeGreaterThanOrEqual(grown.y + grown.height);

  // A phone: the toolbar folds into More, and the grid takes the space back.
  await page.setViewportSize({ width: 390, height: 800 });
  await expect.poll(async () => (await first.boundingBox())!.y).toBeLessThan(4);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect.poll(async () => (await first.boundingBox())!.y).toBeGreaterThanOrEqual(grown.y + grown.height);
  expect(errors).toEqual([]);
});

test("an enlarged tile gives way to the gallery when it can no longer be shown", () => {
  const base = {
    focusIdentity: "user_a#1",
    focusIsLocal: false,
    present: ["me#1", "user_a#1"],
    isHidden: () => false,
    hideSelf: false,
  };
  expect(enlargedTileGone(base)).toBe(false);
  expect(enlargedTileGone({ ...base, focusIdentity: undefined })).toBe(false);
  // Ada left the meeting.
  expect(enlargedTileGone({ ...base, present: ["me#1"] })).toBe(true);
  // Ada's video was hidden, on this screen or by a host for everyone.
  expect(enlargedTileGone({ ...base, isHidden: (id) => id === "user_a#1" })).toBe(true);
  // Your own enlarged tile, then "Hide me".
  const mine = { ...base, focusIdentity: "me#1", focusIsLocal: true };
  expect(enlargedTileGone(mine)).toBe(false);
  expect(enlargedTileGone({ ...mine, hideSelf: true })).toBe(true);
  // Hiding is about others: your own tile is never "hidden" by that list.
  expect(enlargedTileGone({ ...mine, isHidden: () => true })).toBe(false);
});

const spotlit = (page: Page) =>
  page.evaluate(() => Array.from(document.querySelectorAll(".neo-spotlight")).map((t) => t.id));

test("a host spotlights someone for everyone from the tile menu, and takes it off again", async ({ page }) => {
  const errors = await load(page);
  await tiles(page, [
    { id: ada.identity, name: "Ada", source: "camera" },
    { id: grace1.identity, name: "Grace", source: "camera" },
  ]);
  await renderOverlay(page, [me, ada, grace1], true);
  await page.getByRole("button", { name: "Options for Ada" }).click();
  await page.getByText("Spotlight for everyone").click();

  const sent = () => page.evaluate(() => (window as unknown as Win).__sent);
  await expect.poll(async () => (await sent()).map((s) => s.msg.identity)).toEqual(["user_a#1"]);
  expect((await sent())[0].opts.topic).toBe("neo-spotlight");
  // On a computer tile, which is what never worked.
  await expect.poll(() => spotlit(page)).toEqual(["user_a#1:camera"]);
  // Said by name, not by "user_a#1".
  await expect(page.getByText("Spotlight for everyone: Ada")).toBeVisible();

  await page.getByRole("button", { name: "Options for Ada" }).click();
  await page.getByText("Remove spotlight").click();
  await expect.poll(async () => (await sent()).map((s) => s.msg.identity)).toEqual(["user_a#1", null]);
  await expect.poll(() => spotlit(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test("spotlight is not a double-click: that stays enlarge-on-my-screen, and spotlights nobody", async ({ page }) => {
  await load(page);
  await tiles(page, [{ id: ada.identity, name: "Ada", source: "camera" }]);
  await renderOverlay(page, [me, ada], true);
  await page.locator("#user_a\\#1\\:camera").dblclick();
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => (window as unknown as Win).__sent)).toEqual([]);
});

test("a viewer who is not a host is not offered it, and sees a host's spotlight on a computer tile", async ({ page }) => {
  await load(page);
  await tiles(page, [
    { id: ada.identity, name: "Ada", source: "camera" },
    { id: grace1.identity, name: "Grace", source: "camera" },
  ]);
  await renderOverlay(page, [me, ada, grace1], false);
  await page.getByRole("button", { name: "Options for Grace" }).click();
  await expect(page.getByText("Spotlight for everyone")).toHaveCount(0);

  await page.evaluate(() => {
    const w = window as unknown as Win;
    const msg = new TextEncoder().encode(JSON.stringify({ identity: "user_g#1", ts: Date.now() }));
    w.__room.emit("dataReceived", msg, undefined, undefined, "neo-spotlight");
  });
  await expect.poll(() => spotlit(page)).toEqual(["user_g#1:camera"]);
  await expect(page.getByText("Spotlight for everyone: Grace")).toBeVisible();

  // Grace leaves: the chip goes with her.
  await page.evaluate(() => (window as unknown as Win).__room.emit("participantDisconnected", { identity: "user_g#1" }));
  await expect(page.getByText("Spotlight for everyone: Grace")).toHaveCount(0);
});

test("someone who joins after the spotlight was set is told, with its original time", async ({ page }) => {
  await load(page);
  await tiles(page, [{ id: ada.identity, name: "Ada", source: "camera" }]);
  await renderOverlay(page, [me, ada], true);
  await page.getByRole("button", { name: "Options for Ada" }).click();
  await page.getByText("Spotlight for everyone").click();
  await expect.poll(async () => (await page.evaluate(() => (window as unknown as Win).__sent)).length).toBe(1);

  await page.evaluate(() => (window as unknown as Win).__room.emit("participantConnected", { identity: "user_late#1", name: "Late" }));
  await expect.poll(async () => (await page.evaluate(() => (window as unknown as Win).__sent)).length).toBe(2);
  const [first, catchUp] = await page.evaluate(() => (window as unknown as Win).__sent);
  expect(catchUp.msg).toEqual(first.msg); // the same choice and the same time
  expect(catchUp.opts.destinationIdentities).toEqual(["user_late#1"]);
});

test("breakout rooms and spotlight find whose tile it is on a computer and on a phone", async ({ page }) => {
  await load(page);
  const ids = await page.evaluate(() => {
    const w = window as unknown as Win;
    const of = w.__mods.roomLayout.tileIdentityOf as (el: Element) => string | null;
    const computer = document.createElement("div");
    computer.setAttribute("data-neo-identity", "user_a#1");
    const phone = document.createElement("div");
    phone.setAttribute("data-lk-participant-identity", "user_b#1");
    const stock = document.createElement("div");
    stock.innerHTML = '<span data-lk-participant-name="Ada">Ada</span>';
    return [of(computer), of(phone), of(stock)];
  });
  expect(ids).toEqual(["user_a#1", "user_b#1", null]);
});

/** Renders one of the room's tile overlays on its own. */
async function renderOne(page: Page, people: Person[], component: string, props: object, hidden: string[] = []) {
  await page.evaluate(
    ({ people, component, props, hidden }) => {
      const w = window as unknown as Win & { __hiddenSet: Set<string> };
      w.__participants = people;
      w.__hiddenSet = new Set(hidden);
      const C = w.__mods[component].default as (p: object) => null;
      w.ReactDOM.createRoot(document.getElementById("app")!).render(w.React.createElement(C, props));
    },
    { people, component, props, hidden },
  );
}

const shown = (page: Page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>(".lk-participant-tile"))
      .filter((t) => getComputedStyle(t).display !== "none")
      .map((t) => t.id),
  );

test("hiding one Grace hides her tiles only, not the other Grace's", async ({ page }) => {
  const errors = await load(page);
  await tiles(page, [
    { id: grace1.identity, name: "Grace", source: "camera" },
    { id: grace1.identity, name: "Grace", source: "screen_share" },
    { id: grace2.identity, name: "Grace", source: "camera" },
    { id: ada.identity, name: "Ada", source: "camera" },
  ]);
  await renderOne(page, [me, grace1, grace2, ada], "HiddenVideoOverlay", {}, [grace1.identity]);
  await expect.poll(() => shown(page)).toEqual(["user_g#2:camera", "user_a#1:camera"]);
  expect(errors).toEqual([]);
});

test("a tile that says no identity (LiveKit's stock layout, the embeds) is still hidden by name", async ({ page }) => {
  await load(page);
  await page.evaluate(() => {
    const grid = document.createElement("div");
    grid.innerHTML =
      '<div class="lk-participant-tile" id="stock-ada"><span data-lk-participant-name="Ada">Ada</span></div>' +
      '<div class="lk-participant-tile" id="stock-ben"><span data-lk-participant-name="Ben">Ben</span></div>';
    document.body.insertBefore(grid, document.getElementById("app"));
  });
  await renderOne(page, [me, ada, { identity: "user_b#1", name: "Ben" }], "HiddenVideoOverlay", {}, [ada.identity]);
  await expect.poll(() => shown(page)).toEqual(["stock-ben"]);
});

test("the host's badge goes on the host's tile, not on everyone with the host's name", async ({ page }) => {
  const errors = await load(page);
  await tiles(page, [
    { id: grace1.identity, name: "Grace", source: "camera" },
    { id: grace1.identity, name: "Grace", source: "screen_share" },
    { id: grace2.identity, name: "Grace", source: "camera" },
    { id: ada.identity, name: "Ada", source: "camera" },
  ]);
  const host = { ...grace1, metadata: JSON.stringify({ role: "host" }) };
  const mod = { ...ada, metadata: JSON.stringify({ role: "cohost" }) };
  await renderOne(page, [me, host, grace2, mod], "TileRoleBadges", { ownerUserId: null });
  const badges = () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll("[data-tile-role-badge]")).map(
        (b) => `${b.closest(".lk-participant-tile")!.id}=${b.textContent}`,
      ),
    );
  await expect.poll(badges).toEqual(["user_g#1:camera=Host", "user_a#1:camera=Moderator"]);
  expect(errors).toEqual([]);
});

test("the room plays each voice once: one audio player, whatever the layout", () => {
  // LiveKit's prefab brings its own RoomAudioRenderer, and the room page
  // has one too: on a computer each voice played twice, in step. The page's
  // is the room's only one, outside the layouts, so phones keep it.
  const count = (file: string) =>
    (readFileSync(path.join(root, file), "utf8").match(/<RoomAudioRenderer\b/g) ?? []).length;
  expect(count("src/app/room/[name]/page.tsx")).toBe(1);
  expect(count("src/components/conference/NeoVideoConference.tsx")).toBe(0);
  expect(count("src/components/MobileVideoConference.tsx")).toBe(0);
  const page = readFileSync(path.join(root, "src/app/room/[name]/page.tsx"), "utf8");
  // Not inside a layout's branch: it renders whether the phone or the
  // computer layout is showing.
  const line = page.split("\n").find((l) => l.includes("<RoomAudioRenderer"))!;
  expect(line.trim()).toBe("<RoomAudioRenderer />");
});

/**
 * The phone layout as MobileVideoConference draws it: the room-name row,
 * the status strip, then the tiles (the first row's right-hand tile with
 * its menu button at the top right).
 */
async function phoneLayout(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    const shell = document.createElement("div");
    shell.style.cssText = "position:fixed;top:65px;left:0;right:0;bottom:0;display:flex;flex-direction:column";
    shell.innerHTML = `
      <div style="height:36px">Weekly · 4 IN ROOM</div>
      <div id="nc-phone-status" style="display:flex;flex-wrap:wrap;gap:8px;justify-content:center"></div>
      <div style="flex:1;position:relative;overflow:hidden">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:12px">
          <div class="lk-participant-tile" style="position:relative;aspect-ratio:1;background:#222">Ada</div>
          <div class="lk-participant-tile" style="position:relative;aspect-ratio:1;background:#222">Grace
            <button id="grace-menu" aria-label="Options for Grace" style="position:absolute;top:4px;right:4px;width:28px;height:28px">⋮</button>
          </div>
        </div>
      </div>
      <div style="height:60px">controls</div>`;
    document.body.insertBefore(shell, document.getElementById("app"));
  });
}

async function renderComponent(page: Page, component: string, props: object) {
  await page.evaluate(
    ({ component, props }) => {
      const w = window as unknown as Win;
      const C = w.__mods[component].default as (p: object) => null;
      w.ReactDOM.createRoot(document.getElementById("app")!).render(w.React.createElement(C, props));
    },
    { component, props },
  );
}

/** What is on top at the middle of the element: the element, or what covers it. */
const onTop = (page: Page, selector: string) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel)!;
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit === el || el.contains(hit);
  }, selector);

test("on a phone the meeting timer sits in the status strip, not on the first row's menu button", async ({ page }) => {
  await load(page);
  await phoneLayout(page);
  // A host who opened the timer: the full card, with its controls.
  await renderComponent(page, "MeetingTimer", { slug: "weekly", roomRole: "host", open: true });
  const card = page.locator('#nc-phone-status [data-room-chrome="true"]');
  await expect(card).toHaveCount(1);
  expect(await card.evaluate((el) => getComputedStyle(el).position)).not.toBe("fixed");
  // The tiles start below it, and Grace's menu button is the one tapped.
  const strip = (await page.locator("#nc-phone-status").boundingBox())!;
  const grace = (await page.locator("#grace-menu").boundingBox())!;
  expect(grace.y).toBeGreaterThanOrEqual(strip.y + strip.height);
  expect(await onTop(page, "#grace-menu")).toBe(true);
});

test("on a computer the meeting timer still floats at the top right", async ({ page }) => {
  await load(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await renderComponent(page, "MeetingTimer", { slug: "weekly", roomRole: "host", open: true });
  const card = page.locator('[data-room-chrome="true"]');
  await expect(card).toHaveCount(1);
  expect(await card.evaluate((el) => getComputedStyle(el).position)).toBe("fixed");
});

test("on a phone the host's spotlight hint is not shown, and a spotlight's chip goes in the strip", async ({ page }) => {
  await load(page);
  await phoneLayout(page);
  await renderComponent(page, "SpotlightOverlay", { isHost: true });
  await page.waitForTimeout(100);
  await expect(page.getByText("Spotlight someone for everyone")).toHaveCount(0);

  await page.evaluate(() => {
    const w = window as unknown as Win;
    w.__room.remoteParticipants.set("user_g#1", { identity: "user_g#1", name: "Grace" });
    const msg = new TextEncoder().encode(JSON.stringify({ identity: "user_g#1", ts: Date.now() }));
    w.__room.emit("dataReceived", msg, undefined, undefined, "neo-spotlight");
  });
  await expect(page.locator("#nc-phone-status").getByText("Spotlight for everyone: Grace")).toBeVisible();
});

test("on a computer the host's spotlight hint is still shown", async ({ page }) => {
  await load(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await renderComponent(page, "SpotlightOverlay", { isHost: true });
  await expect(page.getByText("Spotlight someone for everyone")).toBeVisible();
});

/** A remote person as the phone tile reads them. */
function phonePerson(i: number) {
  return { identity: `user_${i}#1`, name: `Person ${i}` };
}

async function renderPhoneGrid(page: Page) {
  await page.setViewportSize({ width: 390, height: 700 });
  // The few utility classes the grid's layout rests on (no Tailwind here).
  await page.addStyleTag({
    content: `.absolute{position:absolute}.relative{position:relative}.inset-0{inset:0}.overflow-y-auto{overflow-y:auto}
      .overflow-hidden{overflow:hidden}.grid{display:grid}.grid-cols-1{grid-template-columns:1fr}.grid-cols-2{grid-template-columns:repeat(2,1fr)}
      .grid-cols-3{grid-template-columns:repeat(3,1fr)}.gap-2{gap:8px}.px-3{padding-left:12px;padding-right:12px}.pb-4{padding-bottom:16px}
      .aspect-square{aspect-ratio:1/1}.aspect-video{aspect-ratio:16/9}`,
  });
  await page.addScriptTag({ content: moduleScript("src/components/conference/keptPlace.ts", "keptPlace") });
  await page.addScriptTag({ content: moduleScript("src/components/conference/MobileParticipantGrid.tsx", "MobileParticipantGrid") });
  await page.evaluate(() => {
    const w = window as unknown as Win & { __render: (people: Person[]) => void; __tick: number };
    const toParticipant = (p: Person) => ({
      ...p,
      isLocal: p.identity === "me#1",
      isCameraEnabled: false,
      isMicrophoneEnabled: false,
      metadata: "",
      on() { return this; },
      off() { return this; },
      getTrackPublication() { return undefined; },
    });
    const host = document.getElementById("app")!;
    host.style.cssText = "position:relative;height:700px";
    const root = w.ReactDOM.createRoot(host);
    const Grid = w.__mods.MobileParticipantGrid.default as (p: Record<string, unknown>) => null;
    w.__tick = 0;
    w.__render = (people) => {
      w.__participants = people.map(toParticipant);
      root.render(w.React.createElement(Grid, { slug: "saregionalmeeting", tick: ++w.__tick }));
    };
  });
}

const gridOrder = (page: Page) =>
  page.evaluate(() => Array.from(document.querySelectorAll("[data-place]")).map((e) => e.getAttribute("data-place")));

/** Who is at the top of the grid's view. */
const topPerson = (page: Page) =>
  page.evaluate(() => {
    const scroller = document.querySelector("[data-place]")!.closest(".overflow-y-auto") as HTMLElement;
    const top = scroller.getBoundingClientRect().top;
    return Array.from(scroller.querySelectorAll("[data-place]")).find((e) => e.getBoundingClientRect().bottom > top + 1)?.getAttribute("data-place");
  });

const render = (page: Page, people: Person[]) =>
  page.evaluate((people) => (window as unknown as { __render: (p: Person[]) => void }).__render(people), people);

const frames = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

test("on a phone, a connection restart keeps the grid where the reader was, in the same order", async ({ page }) => {
  // SA region, 2026-11-20: a host taking the register by scrolling the
  // tiles was thrown back to the top every time the connection restarted
  // (LiveKit drops everyone and adds them back), and people came back in a
  // new order.
  const errors = await load(page);
  await renderPhoneGrid(page);
  const people = [me, ...Array.from({ length: 90 }, (_, i) => phonePerson(i))];
  await render(page, people);
  await expect(page.locator("[data-place]")).toHaveCount(91);

  // The reader scrolls well down the list.
  await page.mouse.move(195, 350);
  await page.mouse.wheel(0, 1500);
  await expect.poll(() => topPerson(page)).not.toBe("me#1");
  await frames(page);
  const reading = await topPerson(page);

  // The restart, while they are still reading: only they are left, then
  // everyone comes back, in a different order.
  await render(page, [me]);
  await frames(page);
  await render(page, [me, ...people.slice(1).reverse()]);
  await frames(page);
  expect(await topPerson(page)).toBe(reading);
  expect(await gridOrder(page)).toEqual(people.map((p) => p.identity));

  // And again a few seconds after their last touch, with the gap a real
  // restart has (here also while the grid shows nobody but "Connecting…").
  await page.waitForTimeout(2700);
  await render(page, []);
  await frames(page);
  await render(page, [me]);
  await frames(page);
  await render(page, people.slice().reverse());
  await frames(page);
  expect(await topPerson(page)).toBe(reading);
  expect(await gridOrder(page)).toEqual(people.map((p) => p.identity));

  // Someone new joins at the end, not on top of the reader's place.
  await render(page, [...people, phonePerson(500)]);
  await frames(page);
  expect(await topPerson(page)).toBe(reading);
  expect((await gridOrder(page)).at(-1)).toBe("user_500#1");
  expect(errors).toEqual([]);
});

test("on a phone, a reader at the top stays at the top as people join and the room restarts", async ({ page }) => {
  const errors = await load(page);
  await renderPhoneGrid(page);
  const people = [me, ...Array.from({ length: 40 }, (_, i) => phonePerson(i))];
  await render(page, people);
  await render(page, [me]);
  await frames(page);
  await render(page, people);
  await frames(page);
  expect(await topPerson(page)).toBe("me#1");
  expect(errors).toEqual([]);
});

/* -------------------------------------------------------------------------- */
/*  Locked participant microphones (src/lib/micLock.ts)                        */
/* -------------------------------------------------------------------------- */

type MicWin = Win & {
  __micCalls: boolean[];
  __micOn: boolean;
  __fetches: Array<{ url: string; method: string; body: string }>;
  __lockAnswer: { locked: boolean; allowed: string[] };
  /** The next POST to /api/livekit/mic-lock fails as the server does when LiveKit does not answer. */
  __lockFail?: boolean;
  __room: Win["__room"] & { name?: string; localParticipant: Record<string, unknown> };
};

/** A participant whose LiveKit permission leaves the microphone out (or not). */
async function micSetup(page: Page, locked: boolean) {
  await page.evaluate((locked) => {
    const w = window as unknown as MicWin;
    w.__micCalls = [];
    w.__micOn = false;
    w.__fetches = [];
    w.__lockAnswer = { locked: true, allowed: [] };
    w.__room.name = "weekly-room";
    Object.assign(w.__room.localParticipant, {
      permissions: { canPublish: true, canPublishSources: locked ? [1, 3, 4] : [] },
      isMicrophoneEnabled: false,
      setMicrophoneEnabled: (on: boolean) => {
        w.__micCalls.push(on);
        return Promise.resolve();
      },
    });
    window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      w.__fetches.push({ url, method: init?.method || "GET", body: typeof init?.body === "string" ? init.body : "" });
      if (url.startsWith("/api/livekit/mic-lock")) {
        if (init?.method === "POST" && w.__lockFail) {
          const fail = { error: "livekit_unavailable", message: "Couldn't mute everyone. The meeting server didn't answer. Try again." };
          return new Response(JSON.stringify(fail), { status: 502, headers: { "content-type": "application/json" } });
        }
        const body = init?.method === "POST" ? { ok: true } : w.__lockAnswer;
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
  }, locked);
}

async function loadMicScreens(page: Page) {
  await page.addScriptTag({ content: moduleScript("src/components/conference/MuteEveryone.tsx", "MuteEveryone") });
  await page.addScriptTag({ content: moduleScript("src/components/conference/MicLockNotice.tsx", "MicLockNotice") });
  await page.addScriptTag({ content: moduleScript("src/components/conference/MobileControlBar.tsx", "MobileControlBar") });
  await page.addScriptTag({ content: moduleScript("src/components/conference/NeoControlBar.tsx", "NeoControlBar") });
}

test("a locked participant's phone: the Mic button shows the lock and says why, and never turns the microphone on", async ({ page }) => {
  const errors = await load(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await micSetup(page, true);
  await loadMicScreens(page);
  await page.evaluate(() => {
    const w = window as unknown as MicWin;
    const Bar = w.__mods.MobileControlBar.default as (p: Record<string, unknown>) => null;
    const Notice = w.__mods.MicLockNotice.default as () => null;
    w.ReactDOM.createRoot(document.getElementById("app")!).render(
      w.React.createElement("div", null, w.React.createElement(Bar, { onLeave: () => {} }), w.React.createElement(Notice)),
    );
  });
  const mic = page.getByRole("button", { name: "Microphone locked" });
  await expect(mic).toBeVisible();
  await expect(mic).toHaveAttribute("title", "Your microphone is locked. An Owner, Host, or Moderator can allow you to unmute.");
  const notice = page.locator("[data-mic-lock-notice]");
  await expect(notice).toContainText("Your microphone is locked. An Owner, Host, or Moderator can allow you to unmute.");
  await notice.getByRole("button", { name: "Dismiss" }).click();
  await expect(notice).toHaveText("");
  // Tapping it, or the keyboard on it: no microphone, the reason again.
  await mic.click();
  await expect(notice).toContainText("Your microphone is locked.");
  await notice.getByRole("button", { name: "Dismiss" }).click();
  await mic.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Space");
  await expect(notice).toContainText("Your microphone is locked.");
  // The headset and keyboard media keys (BackgroundContinuity), and "Ask to
  // unmute" (MediaRequestPrompt), go through the same check.
  const viaMediaKey = await page.evaluate(() => {
    const w = window as unknown as MicWin;
    const m = w.__mods.micLockClient as unknown as { enableMicrophone: (lp: unknown, on: boolean) => Promise<boolean> };
    return m.enableMicrophone(w.__room.localParticipant, true);
  });
  expect(viaMediaKey).toBe(false);
  expect(await page.evaluate(() => (window as unknown as MicWin).__micCalls)).toEqual([]);

  // Allowed: told so, and the microphone stays off until they turn it on.
  await page.evaluate(() => {
    const w = window as unknown as MicWin;
    (w.__room.localParticipant.permissions as { canPublishSources: number[] }).canPublishSources = [];
    w.__room.emit("participantPermissionsChanged");
  });
  await expect(notice).toContainText("You can now unmute.");
  const unmute = page.getByRole("button", { name: "Unmute microphone" });
  await expect(unmute).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as MicWin).__micCalls)).toEqual([]);
  await unmute.click();
  expect(await page.evaluate(() => (window as unknown as MicWin).__micCalls)).toEqual([true]);
  expect(errors).toEqual([]);
});

test("on a computer, the bar shows a locked microphone button only while it is locked", async ({ page }) => {
  const errors = await load(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await micSetup(page, true);
  await loadMicScreens(page);
  await page.evaluate(() => {
    const w = window as unknown as MicWin;
    const Bar = w.__mods.NeoControlBar.default as () => null;
    w.ReactDOM.createRoot(document.getElementById("app")!).render(w.React.createElement(Bar));
  });
  const locked = page.getByRole("button", { name: "Microphone locked" });
  await expect(locked).toBeVisible();
  await expect(locked).toHaveAttribute("title", /An Owner, Host, or Moderator can allow you to unmute/);
  // LiveKit's own bar is laid out in the same row.
  await expect(page.locator("[data-lk-stock-bar]")).toHaveCSS("display", "contents");
  await page.evaluate(() => {
    const w = window as unknown as MicWin;
    (w.__room.localParticipant.permissions as { canPublishSources: number[] }).canPublishSources = [];
    w.__room.emit("participantPermissionsChanged");
  });
  await expect(locked).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a host's computer bar: Mute everyone right of Leave, labelled from the server's state, kept on a failure", async ({ page }) => {
  const errors = await load(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await micSetup(page, false);
  await page.evaluate(() => {
    const w = window as unknown as MicWin;
    w.__lockAnswer = { locked: false, allowed: [] };
    w.__room.localParticipant.metadata = JSON.stringify({ role: "host" });
  });
  await loadMicScreens(page);
  await page.evaluate(() => {
    const w = window as unknown as MicWin;
    const Bar = w.__mods.NeoControlBar.default as () => null;
    w.ReactDOM.createRoot(document.getElementById("app")!).render(w.React.createElement(Bar));
  });
  const mute = page.getByRole("button", { name: "Mute everyone" });
  await expect(mute).toBeVisible();
  // After LiveKit's bar, whose last button is Leave.
  expect(await mute.evaluate((b) => b.previousElementSibling?.hasAttribute("data-lk-stock-bar"))).toBe(true);

  // Pressed: the lock is asked for, and the label follows what the server then says.
  await page.evaluate(() => ((window as unknown as MicWin).__lockAnswer = { locked: true, allowed: [] }));
  await mute.click();
  const unmute = page.getByRole("button", { name: "Unmute everyone" });
  await expect(unmute).toBeVisible();
  const posts = await page.evaluate(() => (window as unknown as MicWin).__fetches.filter((f) => f.method === "POST").map((f) => JSON.parse(f.body)));
  expect(posts).toEqual([{ slug: "weekly-room", room: "weekly-room", action: "lock" }]);

  // A press that fails keeps the confirmed label and says why.
  await page.evaluate(() => ((window as unknown as MicWin).__lockFail = true));
  await unmute.click();
  await expect(page.getByRole("alert")).toHaveText("Couldn't mute everyone. The meeting server didn't answer. Try again.");
  await expect(page.getByRole("button", { name: "Unmute everyone" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("a participant's computer bar has no Mute everyone", async ({ page }) => {
  const errors = await load(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await micSetup(page, false);
  await page.evaluate(() => ((window as unknown as MicWin).__room.localParticipant.metadata = JSON.stringify({ role: "attendee" })));
  await loadMicScreens(page);
  await page.evaluate(() => {
    const w = window as unknown as MicWin;
    const Bar = w.__mods.NeoControlBar.default as () => null;
    w.ReactDOM.createRoot(document.getElementById("app")!).render(w.React.createElement(Bar));
  });
  await expect(page.locator("[data-lk-stock-bar]")).toHaveCount(1);
  await expect(page.getByRole("button", { name: /everyone/ })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a host's phone menu: Allow to unmute on someone locked, Lock microphone again once allowed, nothing while unlocked", async ({ page }) => {
  const errors = await load(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await micSetup(page, false);
  const open = async () => {
    await page.evaluate(() => {
      const w = window as unknown as MicWin & { __tileRoot?: import("react-dom/client").Root };
      const Tile = w.__mods.MobileParticipantTile.MobileParticipantTile as (p: Record<string, unknown>) => null;
      const g = {
        identity: "user_g#1",
        name: "Grace",
        isLocal: false,
        isCameraEnabled: false,
        isMicrophoneEnabled: false,
        metadata: "",
        on() { return this; },
        off() { return this; },
        getTrackPublication() { return undefined; },
      };
      const root = (w.__tileRoot ??= w.ReactDOM.createRoot(document.getElementById("app")!));
      root.render(
        w.React.createElement("div", { style: { width: 180 }, key: String(Math.random()) },
          w.React.createElement(Tile, { participant: g, localIsHost: true, localIsHostRank: true, participantIsHost: false, slug: "weekly" })),
      );
    });
    await page.getByRole("button", { name: "Options for Grace" }).click();
    return page.getByRole("menu", { name: "Options for Grace" });
  };
  const posts = () => page.evaluate(() => (window as unknown as MicWin).__fetches.filter((f) => f.method === "POST"));

  // Locked, Grace not allowed.
  let sheet = await open();
  await sheet.getByRole("button", { name: "Allow to unmute" }).click();
  await expect.poll(posts).toEqual([
    { url: "/api/livekit/mic-lock", method: "POST", body: JSON.stringify({ slug: "weekly", room: "weekly-room", action: "allow", participantIdentity: "user_g#1" }) },
  ]);
  await expect(sheet).toHaveCount(0);

  // Allowed: the item is now Lock microphone again.
  await page.evaluate(() => { (window as unknown as MicWin).__lockAnswer = { locked: true, allowed: ["user_g"] }; });
  sheet = await open();
  await sheet.getByRole("button", { name: "Lock microphone again" }).click();
  await expect.poll(async () => (await posts()).at(-1)?.body).toBe(
    JSON.stringify({ slug: "weekly", room: "weekly-room", action: "relock", participantIdentity: "user_g#1" }),
  );

  // Not locked: neither.
  await page.evaluate(() => { (window as unknown as MicWin).__lockAnswer = { locked: false, allowed: [] }; });
  sheet = await open();
  await expect(sheet.getByRole("button", { name: "Mute mic" })).toBeVisible();
  await expect(sheet.getByRole("button", { name: /Allow to unmute|Lock microphone again/ })).toHaveCount(0);
  expect(errors).toEqual([]);
});
