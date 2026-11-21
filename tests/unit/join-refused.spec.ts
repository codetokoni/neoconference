import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * A join LiveKit refuses is not leaving the meeting.
 *
 * When LiveKit turns a connection away (the whole account full, or a network
 * that cannot reach it), livekit-client still emits Disconnected, although
 * Connected never came. The room treated every Disconnected as leaving and
 * sent the person to the after-meeting page: refused at the door, it looked
 * exactly like being thrown out. Here the real livekit-client is refused by
 * a LiveKit that is not there, with the room's own handlers
 * (src/lib/connectOutcome.ts) on its events; and the screen it shows instead
 * (components/conference/JoinProblem) runs with real React.
 */

const root = path.resolve(__dirname, "../..");

function umd(pkg: string, file: string): string {
  return path.join(path.dirname(require.resolve(pkg + "/package.json")), "umd", file);
}

/** A source file as a script that puts its exports at window.__mods[name]. */
function moduleScript(file: string, name: string): string {
  const source = readFileSync(path.join(root, file), "utf8");
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, jsx: ts.JsxEmit.React, esModuleInterop: true },
  }).outputText;
  return `(function () {
    var module = { exports: {} };
    var exports = module.exports;
    var require = function (n) {
      if (n === "react") return window.React;
      if (n === "@/lib/livekitCapacity") return window.__mods.livekitCapacity;
      throw new Error("not stubbed: " + n);
    };
    ${code}
    window.__mods = window.__mods || {};
    window.__mods[${JSON.stringify(name)}] = module.exports;
  })();`;
}

const lkUmd = path.join(root, "node_modules/livekit-client/dist/livekit-client.umd.js");

test("refused before getting in: the room's handlers call it a failed join, never leaving", async ({ page }) => {
  await page.setContent("<!doctype html><html><body></body></html>");
  await page.addScriptTag({ path: lkUmd });
  await page.addScriptTag({ content: moduleScript("src/lib/livekitCapacity.ts", "livekitCapacity") });
  await page.addScriptTag({ content: moduleScript("src/lib/connectOutcome.ts", "connectOutcome") });
  const out = await page.evaluate(async () => {
    const w = window as unknown as {
      LivekitClient: { Room: new () => { on: (e: string, f: () => void) => unknown; connect: (u: string, t: string) => Promise<void> }; RoomEvent: Record<string, string> };
      __mods: { connectOutcome: { connectWatch: (h: () => { onLeave: () => void; onJoinFailed: () => void }) => { onConnected: () => void; onDisconnected: () => void } } };
    };
    const LK = w.LivekitClient;
    const calls: string[] = [];
    const watch = w.__mods.connectOutcome.connectWatch(() => ({ onLeave: () => calls.push("leave"), onJoinFailed: () => calls.push("join_failed") }));
    const events: string[] = [];
    const room = new LK.Room();
    room.on(LK.RoomEvent.Connected, () => (events.push("connected"), watch.onConnected()));
    room.on(LK.RoomEvent.Disconnected, () => (events.push("disconnected"), watch.onDisconnected()));
    let refused = "";
    try {
      // Nothing listens there: LiveKit unreachable, as a refused join is.
      await room.connect("ws://127.0.0.1:9", "not-a-real-token");
    } catch (e) {
      refused = String((e as Error)?.message || e);
    }
    return { calls, events, refused };
  });
  expect(out.refused, "the connection was refused").not.toBe("");
  expect(out.events, "livekit-client says Disconnected, with no Connected").toEqual(["disconnected"]);
  expect(out.calls).toEqual(["join_failed"]);
});

test("after the room connected, a disconnect is leaving, as before", async ({ page }) => {
  await page.setContent("<!doctype html><html><body></body></html>");
  await page.addScriptTag({ content: moduleScript("src/lib/livekitCapacity.ts", "livekitCapacity") });
  await page.addScriptTag({ content: moduleScript("src/lib/connectOutcome.ts", "connectOutcome") });
  const calls = await page.evaluate(() => {
    const m = (window as unknown as { __mods: { connectOutcome: { connectWatch: (h: () => { onLeave: () => void; onJoinFailed: () => void }) => { onConnected: () => void; onDisconnected: () => void } } } }).__mods.connectOutcome;
    const calls: string[] = [];
    let handlers = { onLeave: () => calls.push("old leave"), onJoinFailed: () => calls.push("old failed") };
    const watch = m.connectWatch(() => handlers);
    watch.onConnected();
    handlers = { onLeave: () => calls.push("leave"), onJoinFailed: () => calls.push("join_failed") };
    watch.onDisconnected();
    return calls;
  });
  expect(calls, "the latest handlers, and leaving").toEqual(["leave"]);
});

test("the screen instead: Meeting full or Could not connect, the reason, and Try again", async ({ page }) => {
  await page.setContent("<!doctype html><html><body><div id=app></div></body></html>");
  await page.addScriptTag({ path: umd("react", "react.production.min.js") });
  await page.addScriptTag({ path: umd("react-dom", "react-dom.production.min.js") });
  await page.addScriptTag({ content: moduleScript("src/components/conference/JoinProblem.tsx", "JoinProblem") });
  const show = (full: boolean, message: string) =>
    page.evaluate(
      ([full, message]) => {
        const w = window as unknown as { React: { createElement: (...a: unknown[]) => unknown }; ReactDOM: { render: (el: unknown, node: Element) => void }; __mods: { JoinProblem: { default: unknown } }; __retries?: number };
        w.__retries = 0;
        w.ReactDOM.render(w.React.createElement(w.__mods.JoinProblem.default, { full, message, onRetry: () => (w.__retries = (w.__retries || 0) + 1) }), document.getElementById("app")!);
      },
      [full, message] as [boolean, string],
    );
  await show(true, "This meeting is full right now.");
  await expect(page.getByRole("heading", { name: "Meeting full" })).toBeVisible();
  await expect(page.getByText("This meeting is full right now.")).toBeVisible();
  await page.getByRole("button", { name: "Try again" }).click();
  expect(await page.evaluate(() => (window as unknown as { __retries: number }).__retries)).toBe(1);
  await show(false, "We couldn't connect you to the meeting.");
  await expect(page.getByRole("heading", { name: "Could not connect" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Meeting full" })).toHaveCount(0);
});

test("the room wires them: its LiveKitRoom reports Connected and Disconnected through the watch, and a full token refusal shows the screen", () => {
  const src = readFileSync(path.join(root, "src/app/room/[name]/page.tsx"), "utf8");
  expect(src).toContain("onConnected={watch.onConnected}");
  expect(src).toContain("onDisconnected={watch.onDisconnected}");
  expect(src).not.toMatch(/onDisconnected=\{onLeave\}/);
  expect(src).toMatch(/body\?\.error === "room_full"[\s\S]{0,200}setJoinProblem\(\{ full: true/);
});
