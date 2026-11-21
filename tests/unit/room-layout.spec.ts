import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { enlargedTileGone } from "../../src/components/conference/roomLayout";
import { pinRoleOf, rolePins, showPinnedRow } from "../../src/components/conference/rolePins";

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
      if (name === "./rolePins") return window.__mods.rolePins;
      // The meeting layout's control bar, where a test has not loaded it: none.
      if (name === "./NeoControlBar") return (window.__mods && window.__mods.NeoControlBar) || { __esModule: true, default: function () { return null; } };
      if (name === "./roomLayout") return window.__mods.roomLayout;
      if (name === "./micLockClient" || name === "@/components/conference/micLockClient") return window.__mods.micLockClient;
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
      if (name === "@/components/conference/rolePins") return window.__mods.rolePins;
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
  await page.addScriptTag({ content: moduleScript("src/components/conference/rolePins.ts", "rolePins") });
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
      metadata: p.metadata ?? "",
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

/* ------------------------------------------------------------------ */
/*  The row of Owner, Hosts and Moderators pinned at the top            */
/* ------------------------------------------------------------------ */

// Roles as the server writes them into LiveKit metadata: the token route
// ('host' / 'cohost' and owner: true) and the roles route, which rewrites
// 'role' for everyone in the room when someone is promoted or demoted.
const md = (role: string, owner = false) => JSON.stringify({ role, ...(owner ? { owner: true } : {}), planLimits: {} });
const owner = { identity: "user_o#1", name: "Olu", metadata: md("host", true) };
const host = { identity: "user_h#1", name: "Hana", metadata: md("host") };
const mod1 = { identity: "user_m1#1", name: "Mo", metadata: md("cohost") };
const mod2 = { identity: "user_m2#1", name: "Mia", metadata: md("cohost") };
const ben = { identity: "user_b#1", name: "Ben", metadata: md("attendee") };

test("pinned: Owner, then Hosts, then Moderators; one role keeps the order it came in", () => {
  const ids = (people: Person[], ownerUserId: string | null = null) =>
    rolePins(people, ownerUserId).map((p) => `${p.person.identity}=${p.role}`);
  expect(ids([me, mod2, ben, mod1, host, ada, owner])).toEqual([
    "user_o#1=owner",
    "user_h#1=host",
    "user_m2#1=moderator",
    "user_m1#1=moderator",
  ]);
  // The owner by the room's ownerUserId, for a token without the flag.
  expect(ids([{ ...host, identity: "user_x#9" }, { identity: "user_o#2", name: "Olu", metadata: md("host") }], "user_o")).toEqual([
    "user_o#2=owner",
    "user_x#9=host",
  ]);
  // The owner's id alone is not a role: an owner the server has not made
  // host (or whose metadata has not arrived) is not pinned.
  expect(pinRoleOf({ identity: "user_o#3", metadata: "" }, "user_o")).toBeNull();
  expect(pinRoleOf({ identity: "user_o#3", metadata: "not json" })).toBeNull();
  // Only you would be left in the main area: no row.
  expect(showPinnedRow({ pinned: 1, rest: [{ identity: "me#1", isLocal: true }], sharing: false })).toBe(false);
  expect(showPinnedRow({ pinned: 1, rest: [{ identity: "me#1", isLocal: true }], sharing: true })).toBe(true);
  expect(showPinnedRow({ pinned: 1, rest: [{ identity: "user_b#1", isLocal: false }], sharing: false })).toBe(true);
  expect(showPinnedRow({ pinned: 0, rest: [{ identity: "user_b#1", isLocal: false }], sharing: false })).toBe(false);
});

type Track = {
  participant: Person & { isLocal: boolean };
  source: "camera" | "screen_share";
  publication?: { trackSid: string; source: string; isSubscribed: boolean };
};
type DesktopOpts = { shares?: string[]; focus?: string; ownerUserId?: string | null; hideSelf?: boolean; cameraOff?: string[] };

/** NeoVideoConference with LiveKit's layout components stood in for: each tile says whose it is and where it is. */
async function renderDesktop(page: Page) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addStyleTag({ path: path.join(root, "src/app/room/[name]/initials-overlay.css") });
  await page.addStyleTag({
    content: `.lk-video-conference,.lk-video-conference-inner{height:700px;display:flex;flex-direction:column}.lk-participant-tile{background:#222;color:#fff}`,
  });
  await page.evaluate(() => {
    const w = window as unknown as Win & Record<string, unknown>;
    const R = w.React;
    const h = R.createElement;
    const Ctx = R.createContext<unknown>(null);
    const lk = (w as unknown as { __lk: Record<string, unknown> }).__lk;
    const tile = (props: Record<string, unknown>) => {
      const ctx = R.useContext(Ctx) as Track | null;
      const t = (props.trackRef as Track | undefined) ?? ctx!;
      return h(
        "div",
        {
          className: "lk-participant-tile",
          "data-neo-identity": props["data-neo-identity"],
          "data-neo-source": props["data-neo-source"],
          "data-neo-pinned": props["data-neo-pinned"],
          "data-lk-video-muted": t.publication ? "false" : "true",
        },
        h("span", { "data-lk-participant-name": t.participant.name }, t.participant.name),
      );
    };
    const list = (cls: string) => (p: { tracks: Track[]; children: unknown }) =>
      h("div", { className: cls }, p.tracks.map((t, i) => h(Ctx.Provider, { key: i, value: t }, p.children as never)));
    Object.assign(lk, {
      useTracks: () => w.__tracks,
      useCreateLayoutContext: () => ({ pin: { dispatch: (m: unknown) => (w.__pinMsgs as unknown[]).push(m) }, widget: {} }),
      usePinnedTracks: () => w.__focus,
      useTrackRefContext: () => R.useContext(Ctx),
      isTrackReference: (t: Track) => !!t.publication,
      LayoutContextProvider: (p: { children: unknown }) => p.children,
      GridLayout: list("lk-grid-layout"),
      CarouselLayout: list("lk-carousel"),
      FocusLayoutContainer: (p: { children: unknown }) => h("div", { className: "lk-focus-layout" }, p.children as never),
      FocusLayout: (p: Record<string, unknown>) =>
        h("div", { className: "lk-participant-tile", "data-focus": "true", "data-neo-identity": p["data-neo-identity"], "data-neo-source": p["data-neo-source"] }),
      ParticipantTile: tile,
      ControlBar: () => null,
      Chat: () => null,
      ConnectionStateToast: () => null,
    });
    w.__pinMsgs = [];
    w.__focus = [];
  });
  await page.addScriptTag({ content: moduleScript("src/components/conference/keptPlace.ts", "keptPlace") });
  await page.addScriptTag({ content: moduleScript("src/components/conference/NeoVideoConference.tsx", "NeoVideoConference") });
  await page.evaluate(() => {
    const w = window as unknown as Win & Record<string, unknown>;
    const root = w.ReactDOM.createRoot(document.getElementById("app")!);
    const Conf = w.__mods.NeoVideoConference.default as (p: Record<string, unknown>) => null;
    const Badges = w.__mods.TileRoleBadges.default as (p: Record<string, unknown>) => null;
    w.__renderDesktop = (people: Person[], opts: DesktopOpts = {}) => {
      const parts = people.map((p) => ({ ...p, isLocal: p.identity === "me#1" }));
      w.__participants = parts as never;
      const tracks: Track[] = [];
      for (const p of parts) {
        const off = (opts.cameraOff ?? []).includes(p.identity);
        tracks.push({
          participant: p,
          source: "camera",
          ...(off ? {} : { publication: { trackSid: "cam_" + p.identity, source: "camera", isSubscribed: true } }),
        });
      }
      for (const id of opts.shares ?? []) {
        const p = parts.find((x) => x.identity === id)!;
        tracks.push({ participant: p, source: "screen_share", publication: { trackSid: "scr_" + id, source: "screen_share", isSubscribed: true } });
      }
      w.__tracks = tracks;
      w.__focus = opts.focus ? [tracks.find((t) => `${t.participant.identity}:${t.source}` === opts.focus)] : [];
      root.render(
        w.React.createElement(
          w.React.Fragment,
          null,
          w.React.createElement(Conf, { ownerUserId: opts.ownerUserId ?? null, hideSelf: opts.hideSelf ?? false, tick: Math.random() }),
          w.React.createElement(Badges, { ownerUserId: opts.ownerUserId ?? null }),
        ),
      );
    };
  });
}

const desktop = (page: Page, people: Person[], opts: DesktopOpts = {}) =>
  page.evaluate(
    ({ people, opts }) => (window as unknown as { __renderDesktop: (p: Person[], o: DesktopOpts) => void }).__renderDesktop(people, opts),
    { people, opts },
  );

/** The pinned row, left to right, and what the main area shows. */
const desktopLayout = (page: Page) =>
  page.evaluate(() => {
    const row = document.querySelector("[data-neo-pinned-row]");
    const ids = (sel: string) =>
      Array.from(document.querySelectorAll(sel)).map((t) => `${t.getAttribute("data-neo-identity")}:${t.getAttribute("data-neo-source")}`);
    return {
      row: row ? Array.from(row.children).map((t) => `${t.getAttribute("data-neo-identity")}=${t.getAttribute("data-neo-pinned")}`) : null,
      grid: ids(".lk-grid-layout > .lk-participant-tile"),
      carousel: ids(".lk-carousel > .lk-participant-tile"),
      focus: ids("[data-focus]"),
    };
  });

test("on a computer, the Owner, Hosts and Moderators are a row above the gallery, and the gallery has everyone else", async ({ page }) => {
  const errors = await load(page);
  await renderDesktop(page);
  await desktop(page, [me, mod2, ben, owner, mod1, host, ada]);
  const layout = await desktopLayout(page);
  expect(layout.row).toEqual(["user_o#1=owner", "user_h#1=host", "user_m2#1=moderator", "user_m1#1=moderator"]);
  expect(layout.grid).toEqual(["me#1:camera", "user_b#1:camera", "user_a#1:camera"]);
  // Above the gallery, in the layout, not over it.
  const [rowBox, gridBox] = await Promise.all([
    page.locator("[data-neo-pinned-row]").boundingBox(),
    page.locator(".lk-grid-layout").boundingBox(),
  ]);
  expect(rowBox!.y + rowBox!.height).toBeLessThanOrEqual(gridBox!.y + 0.5);
  // Each pinned tile carries the role badge the room puts on every tile.
  await expect
    .poll(() =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll("[data-neo-pinned-row] > .lk-participant-tile")).map(
          (t) => t.querySelector("[data-tile-role-badge]")?.textContent ?? null,
        ),
      ),
    )
    .toEqual(["Owner", "Host", "Moderator", "Moderator"]);
  expect(errors).toEqual([]);
});

test("on a computer, a join, a leave or a role change redraws the row at once, and a reconnect keeps its order", async ({ page }) => {
  const errors = await load(page);
  await renderDesktop(page);
  await desktop(page, [me, ben, mod1]);
  expect((await desktopLayout(page)).row).toEqual(["user_m1#1=moderator"]);
  // The owner joins late.
  await desktop(page, [me, ben, mod1, owner]);
  expect((await desktopLayout(page)).row).toEqual(["user_o#1=owner", "user_m1#1=moderator"]);
  // Ben is made a moderator (seen before Mo), then Mo is made a host.
  const benMod = { ...ben, metadata: md("cohost") };
  await desktop(page, [me, benMod, mod1, owner, ada]);
  expect((await desktopLayout(page)).row).toEqual(["user_o#1=owner", "user_b#1=moderator", "user_m1#1=moderator"]);
  const moHost = { ...mod1, metadata: md("host") };
  await desktop(page, [me, benMod, moHost, owner, ada]);
  expect((await desktopLayout(page)).row).toEqual(["user_o#1=owner", "user_m1#1=host", "user_b#1=moderator"]);
  // Demoted: back in the gallery.
  await desktop(page, [me, ben, moHost, owner, ada]);
  let layout = await desktopLayout(page);
  expect(layout.row).toEqual(["user_o#1=owner", "user_m1#1=host"]);
  expect(layout.grid).toContain("user_b#1:camera");
  // A reconnect: everyone gone, then back in LiveKit's new order. Mia was
  // never seen before, Mx neither; they come after in the order they came.
  await desktop(page, [me]);
  expect((await desktopLayout(page)).row).toBeNull();
  await desktop(page, [me, ada, owner, mod2, moHost, ben, { ...mod1, identity: "user_m3#1", name: "Mx", metadata: md("cohost") }]);
  layout = await desktopLayout(page);
  expect(layout.row).toEqual(["user_o#1=owner", "user_m1#1=host", "user_m2#1=moderator", "user_m3#1=moderator"]);
  // The same people back in yet another order: the row does not move.
  await desktop(page, [{ ...mod1, identity: "user_m3#1", name: "Mx", metadata: md("cohost") }, ben, moHost, mod2, owner, ada, me]);
  expect((await desktopLayout(page)).row).toEqual(layout.row);
  // The owner leaves.
  await desktop(page, [me, ada, mod2, moHost, ben]);
  expect((await desktopLayout(page)).row).toEqual(["user_m1#1=host", "user_m2#1=moderator"]);
  expect(errors).toEqual([]);
});

test("on a computer, a camera that is off is still a pinned tile, with its name", async ({ page }) => {
  const errors = await load(page);
  await renderDesktop(page);
  await desktop(page, [me, ben, owner, mod1], { cameraOff: [owner.identity] });
  const off = page.locator('[data-neo-pinned-row] > [data-neo-identity="user_o#1"]');
  await expect(off).toHaveAttribute("data-lk-video-muted", "true");
  await expect(off).toContainText("Olu");
  await expect(off.locator("[data-tile-role-badge]")).toHaveText("Owner");
  expect(errors).toEqual([]);
});

test("on a computer, a screen share is the main view under the row, and an enlarged tile leaves the row alone", async ({ page }) => {
  const errors = await load(page);
  await renderDesktop(page);
  // The owner shares: LiveKit's rule enlarges the share; the row stays.
  await desktop(page, [me, ben, owner, mod1, ada], { shares: [owner.identity], focus: "user_o#1:screen_share" });
  let layout = await desktopLayout(page);
  expect(layout.row).toEqual(["user_o#1=owner", "user_m1#1=moderator"]);
  expect(layout.focus).toEqual(["user_o#1:screen_share"]);
  expect(layout.carousel).toEqual(["me#1:camera", "user_b#1:camera", "user_a#1:camera"]);
  const [rowBox, focusBox] = await Promise.all([
    page.locator("[data-neo-pinned-row]").boundingBox(),
    page.locator(".neo-focus-wrapper").boundingBox(),
  ]);
  expect(rowBox!.y + rowBox!.height).toBeLessThanOrEqual(focusBox!.y + 0.5);
  // A viewer enlarges Ben on their own screen: the row is as it was.
  await desktop(page, [me, ben, owner, mod1, ada], { focus: "user_b#1:camera" });
  layout = await desktopLayout(page);
  expect(layout.row).toEqual(["user_o#1=owner", "user_m1#1=moderator"]);
  expect(layout.focus).toEqual(["user_b#1:camera"]);
  // Enlarging a moderator shows them large and keeps them in the row,
  // with a badge on both of their tiles.
  await desktop(page, [me, ben, owner, mod1, ada], { focus: "user_m1#1:camera" });
  layout = await desktopLayout(page);
  expect(layout.row).toEqual(["user_o#1=owner", "user_m1#1=moderator"]);
  expect(layout.focus).toEqual(["user_m1#1:camera"]);
  await expect
    .poll(() => page.evaluate(() => document.querySelectorAll('[data-neo-identity="user_m1#1"] [data-tile-role-badge]').length))
    .toBe(2);
  expect(errors).toEqual([]);
});

test("on a computer, many moderators: the row scrolls sideways in one line and stays low", async ({ page }) => {
  const errors = await load(page);
  await renderDesktop(page);
  const mods = Array.from({ length: 12 }, (_, i) => ({ identity: `user_mm${i}#1`, name: `Mod ${i}`, metadata: md("cohost") }));
  await desktop(page, [me, ben, ...mods]);
  const m = await page.evaluate(() => {
    const row = document.querySelector<HTMLElement>("[data-neo-pinned-row]")!;
    const tiles = Array.from(row.children) as HTMLElement[];
    return {
      scrolls: row.scrollWidth > row.clientWidth,
      overflowX: getComputedStyle(row).overflowX,
      lines: new Set(tiles.map((t) => Math.round(t.getBoundingClientRect().top))).size,
      rowHeight: row.getBoundingClientRect().height,
      firstLeft: tiles[0].getBoundingClientRect().left,
    };
  });
  expect(m).toMatchObject({ scrolls: true, overflowX: "auto", lines: 1 });
  expect(m.rowHeight).toBeLessThan(200);
  // Scrolling starts from the first moderator, not from the middle.
  expect(m.firstLeft).toBeGreaterThanOrEqual(0);
  expect(errors).toEqual([]);
});

test("on a computer, a host and you alone: no row; a host hiding themselves is not in their own row", async ({ page }) => {
  const errors = await load(page);
  await renderDesktop(page);
  await desktop(page, [me, owner]);
  const layout = await desktopLayout(page);
  expect(layout.row).toBeNull();
  expect(layout.grid).toEqual(["me#1:camera", "user_o#1:camera"]);
  const meHost = { ...me, metadata: md("host") };
  await desktop(page, [meHost, ben, mod1], { hideSelf: true });
  expect((await desktopLayout(page)).row).toEqual(["user_m1#1=moderator"]);
  await desktop(page, [meHost, ben, mod1]);
  expect((await desktopLayout(page)).row).toEqual(["me#1=host", "user_m1#1=moderator"]);
  expect(errors).toEqual([]);
});

/** The phone grid's pinned row, left to right, with each tile's role label. */
const phoneRow = (page: Page) =>
  page.evaluate(() => {
    const row = document.querySelector("[data-neo-pinned-row]");
    if (!row) return null;
    return Array.from(row.querySelectorAll("[data-lk-participant-identity]")).map((t) => {
      const pill = Array.from(t.querySelectorAll("span")).find((s) => /^(OWNER|HOST|MODERATOR)$/.test(s.textContent || ""));
      return `${t.getAttribute("data-lk-participant-identity")}=${pill?.textContent ?? "-"}`;
    });
  });

async function phoneRowStyles(page: Page) {
  await page.addStyleTag({
    content: `.flex{display:flex}.overflow-x-auto{overflow-x:auto}.shrink-0{flex-shrink:0}.pt-3{padding-top:12px}.pb-1{padding-bottom:4px}.pb-2{padding-bottom:8px}.w-full{width:100%}`,
  });
}

test("on a phone, the Owner, Hosts and Moderators are a row above the grid, labelled, and the grid has everyone else", async ({ page }) => {
  const errors = await load(page);
  await renderPhoneGrid(page);
  await phoneRowStyles(page);
  await render(page, [me, mod2, ben, owner, mod1, host, ada]);
  await expect.poll(() => phoneRow(page)).toEqual(["user_o#1=OWNER", "user_h#1=HOST", "user_m2#1=MODERATOR", "user_m1#1=MODERATOR"]);
  expect(await gridOrder(page)).toEqual(["me#1", "user_b#1", "user_a#1"]);
  // Above the grid; one line that scrolls sideways when wider than the phone.
  const m = await page.evaluate(() => {
    const row = document.querySelector<HTMLElement>("[data-neo-pinned-row]")!;
    const first = document.querySelector("[data-place]")!;
    return {
      above: row.getBoundingClientRect().bottom <= first.getBoundingClientRect().top + 0.5,
      scrolls: row.scrollWidth > row.clientWidth,
      overflowX: getComputedStyle(row).overflowX,
      lines: new Set(Array.from(row.children).map((c) => Math.round(c.getBoundingClientRect().top))).size,
    };
  });
  expect(m).toEqual({ above: true, scrolls: true, overflowX: "auto", lines: 1 });
  // A promotion and a demotion redraw it.
  await render(page, [me, mod2, { ...ben, metadata: md("host") }, owner, ada]);
  await expect.poll(() => phoneRow(page)).toEqual(["user_o#1=OWNER", "user_b#1=HOST", "user_m2#1=MODERATOR"]);
  expect(await gridOrder(page)).toEqual(["me#1", "user_a#1"]);
  // You and the host alone: the ordinary grid.
  await render(page, [me, owner]);
  await expect.poll(() => phoneRow(page)).toBeNull();
  expect(await gridOrder(page)).toEqual(["me#1", "user_o#1"]);
  expect(errors).toEqual([]);
});

test("on a phone, a screen share stays the main view, under the pinned row", async ({ page }) => {
  const errors = await load(page);
  await renderPhoneGrid(page);
  await phoneRowStyles(page);
  await page.evaluate(() => {
    const w = window as unknown as { __lk: Record<string, unknown> };
    // The owner's share, as useTracks gives it.
    w.__lk.useTracks = () => [
      { participant: { identity: "user_o#1", name: "Olu" }, source: "screen_share", publication: { isSubscribed: true, track: {} } },
    ];
  });
  await render(page, [me, ben, owner, mod1]);
  await expect.poll(() => phoneRow(page)).toEqual(["user_o#1=OWNER", "user_m1#1=MODERATOR"]);
  const order = await page.evaluate(() => {
    const row = document.querySelector("[data-neo-pinned-row]")!.getBoundingClientRect();
    const label = Array.from(document.querySelectorAll("div")).filter((d) => d.textContent?.startsWith("Sharing ·")).at(-1)!;
    const share = label.previousElementSibling!.getBoundingClientRect();
    const grid = document.querySelector("[data-place]")!.getBoundingClientRect();
    return { rowAboveShare: row.bottom <= share.top + 0.5, shareAboveGrid: share.bottom <= grid.top + 0.5 };
  });
  expect(order).toEqual({ rowAboveShare: true, shareAboveGrid: true });
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
        const body = init?.method === "POST" ? { ok: true } : w.__lockAnswer;
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
  }, locked);
}

async function loadMicScreens(page: Page) {
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
