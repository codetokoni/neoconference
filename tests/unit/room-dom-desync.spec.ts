import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * The meeting page survives a role change.
 *
 * Found on production 2026-09-28: a participant demoted from Moderator to
 * Participant got "Application error" on the room page, with
 * "Failed to execute 'insertBefore' on 'Node'" in the console. The
 * "You're now a Participant" toast mounts just before <MobileMoreMenu />,
 * so React inserts it in front of the More button — which MobileMoreMenu
 * had moved into .lk-control-bar with appendChild. React's anchor was no
 * longer a child of the room container, the commit threw, and Next
 * blanked the page. (Only the second role change of a visit shows the
 * toast, which is why Host → Moderator survived and the demotion after
 * it did not.)
 *
 * These render the real components with real React in a browser.
 */

const root = path.resolve(__dirname, "../..");

/** The browser build of an installed package; its exports map hides umd/. */
function umd(pkg: string, file: string): string {
  return path.join(path.dirname(require.resolve(pkg + "/package.json")), "umd", file);
}

/** A component file as a script that sets window[name] to its default export. */
function component(file: string, name: string): string {
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
      throw new Error("unexpected import " + name);
    };
    ${code}
    window[${JSON.stringify(name)}] = module.exports.default;
  })();`;
}

/** Loads React and the room components; returns the page's uncaught errors. */
async function load(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setContent("<!doctype html><html><body><div id=app></div></body></html>");
  // Production builds, as the site ships. The development build reports
  // every error a boundary catches as uncaught as well, which would hide
  // whether one really escaped.
  await page.addScriptTag({ path: umd("react", "react.production.min.js") });
  await page.addScriptTag({ path: umd("react-dom", "react-dom.production.min.js") });
  await page.addScriptTag({ content: component("src/components/MobileMoreMenu.tsx", "MobileMoreMenu") });
  await page.addScriptTag({
    content: component("src/components/ConferenceErrorBoundary.tsx", "ConferenceErrorBoundary"),
  });
  return errors;
}

type Win = {
  React: typeof import("react");
  ReactDOM: typeof import("react-dom") & { createRoot: typeof import("react-dom/client").createRoot };
  MobileMoreMenu: () => null;
  ConferenceErrorBoundary: (p: { children: unknown }) => null;
  setToast: (v: boolean) => void;
};

const setToast = (page: Page, v: boolean) =>
  page.evaluate((v) => (window as unknown as Win).setToast(v), v);

/** Lets a throwing commit's errors land before we look at them. */
const settle = (page: Page) => page.evaluate(() => new Promise((r) => setTimeout(r, 50)));

test("a toast mounting before the More menu does not break the page", async ({ page }) => {
  const errors = await load(page);
  await page.evaluate(() => {
    const w = window as unknown as Win;
    const h = w.React.createElement;
    // Same shape as the room page: the role toast, then the More menu,
    // then (later in the same parent) LiveKit's control bar.
    function Room() {
      const [toast, setToast] = w.React.useState(false);
      w.setToast = setToast;
      return h(
        "div",
        { id: "room" },
        toast ? h("div", { id: "toast" }, "You're now a Participant") : null,
        h(w.MobileMoreMenu),
        h("div", { className: "lk-control-bar" }, h("button", { id: "leave" }, "Leave")),
      );
    }
    w.ReactDOM.createRoot(document.getElementById("app")!).render(h(Room));
  });
  // The button reaches the control bar on its first try.
  await expect(page.locator(".lk-control-bar .nc-mobile-more-btn")).toHaveCount(1);

  await setToast(page, true);
  // Say why first: a throwing commit unmounts the whole tree, which
  // otherwise shows up only as "#toast not found".
  await settle(page);
  expect(errors).toEqual([]);
  await expect(page.locator("#toast")).toHaveText("You're now a Participant");
  await setToast(page, false);
  await expect(page.locator("#toast")).toHaveCount(0);

  expect(errors).toEqual([]);
  await expect(page.locator("#leave")).toHaveCount(1);
  await expect(page.locator(".lk-control-bar .nc-mobile-more-btn")).toHaveCount(1);

  // And the button still opens its menu from there.
  await page.evaluate(() => (document.querySelector(".nc-mobile-more-btn") as HTMLButtonElement).click());
  await expect(page.locator(".nc-mobile-more-popover")).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("a DOM desync inside the meeting UI remounts it instead of blanking the page", async ({ page }) => {
  const errors = await load(page);
  const logged: string[] = [];
  page.on("console", (m) => logged.push(m.text()));
  await page.evaluate(() => {
    const w = window as unknown as Win;
    const h = w.React.createElement;
    // The bug's shape, kept here on purpose now MobileMoreMenu no longer
    // has it: a component that moves its own React-owned node elsewhere.
    function Mover() {
      const ref = w.React.useRef<HTMLButtonElement>(null);
      w.React.useEffect(() => {
        const bar = document.querySelector(".lk-control-bar");
        if (bar && ref.current) bar.appendChild(ref.current);
      }, []);
      return h("button", { ref, className: "moved" }, "More");
    }
    function Room() {
      const [toast, setToast] = w.React.useState(false);
      w.setToast = setToast;
      return h(
        "div",
        { id: "room" },
        h(
          w.ConferenceErrorBoundary,
          null,
          toast ? h("div", { id: "toast" }, "You're now a Participant") : null,
          h(Mover),
          h("div", { className: "lk-control-bar" }, h("button", { id: "leave" }, "Leave")),
        ),
      );
    }
    w.ReactDOM.createRoot(document.getElementById("app")!).render(h(Room));
  });
  await expect(page.locator(".lk-control-bar .moved")).toHaveCount(1);

  await setToast(page, true);
  await settle(page);

  expect(errors).toEqual([]);
  // Once: tearing the broken UI down must not fail again. Without the
  // boundary's own wrapper, removing the moved button threw removeChild
  // errors too — three failures for one desync, one short of giving up.
  const caught = logged.filter((l) => l.startsWith("[conference]"));
  expect(caught).toHaveLength(1);
  expect(caught[0]).toContain("[conference] meeting UI failed; remounting it");
  expect(caught[0]).toContain("insertBefore");
  await expect(page.locator("#toast")).toHaveText("You're now a Participant");
  await expect(page.locator("#leave")).toHaveCount(1);
  await expect(page.locator("[data-conference-error]")).toHaveCount(0);
});

test("a meeting UI that keeps failing offers a reload instead of looping", async ({ page }) => {
  const errors = await load(page);
  await page.evaluate(() => {
    const w = window as unknown as Win;
    const h = w.React.createElement;
    function Broken(): null {
      throw new Error("always broken");
    }
    w.ReactDOM.createRoot(document.getElementById("app")!).render(
      h("div", { id: "room" }, h(w.ConferenceErrorBoundary, null, h(Broken))),
    );
  });

  await expect(page.getByRole("alert")).toContainText("Something went wrong showing the meeting.");
  await expect(page.getByRole("button", { name: "Reload" })).toHaveCount(1);
  expect(errors).toEqual([]);
});
