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
 *   host's name.
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
      if (name === "livekit-client") return { RoomEvent: { DataReceived: "dataReceived", ParticipantConnected: "participantConnected", ParticipantDisconnected: "participantDisconnected" } };
      if (name === "@/components/SpotlightOverlay") return window.__mods.SpotlightOverlay;
      if (name === "@/components/conference/roomLayout") return window.__mods.roomLayout;
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
        useLocalParticipant: function () { return { localParticipant: { identity: "me#1" } }; },
        useRoomContext: function () { return window.__room; },
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
  await page.addScriptTag({ content: moduleScript("src/components/SpotlightOverlay.tsx", "SpotlightOverlay") });
  await page.addScriptTag({ content: moduleScript("src/components/HostTileMenu.tsx", "HostTileMenu") });
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

test("an open menu follows its tile, and closes when the tile goes", async ({ page }) => {
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
  await page.evaluate(() => document.getElementById("user_g#1:camera")!.remove());
  await expect(menu).toHaveCount(0);
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
