import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";

/**
 * The Groups screens at phone, tablet and desktop widths.
 *
 * Renders the real components — the group page and its tabs, the schedule
 * dialog, the incoming-call overlay, the notification bell, a meeting
 * report and My meeting reports — with real React, the site's own compiled
 * Tailwind CSS and fixture data, then checks what a person would hit:
 *
 *   - no sideways scrolling of the page at 360, 768 or 1280 px;
 *   - every button says what it does (text or aria-label);
 *   - dialogs keep keyboard focus inside, close on Escape and hand focus
 *     back; the ring overlay is announced and Escape declines it.
 *
 * Next, Clerk and the icon set are stood in for by small stubs; everything
 * of ours is the real source, transpiled by TypeScript.
 */

const root = path.resolve(__dirname, "../..");

function umd(pkg: string, file: string): string {
  return path.join(path.dirname(require.resolve(pkg + "/package.json")), "umd", file);
}

/* -------------------------------------------------------------------------- */
/*  A tiny CommonJS loader for our own source                                  */
/* -------------------------------------------------------------------------- */

const STUBS: Record<string, string> = {
  react: "module.exports = window.React;",
  "react-dom": "module.exports = window.ReactDOM;",
  "next/link": `
    var R = window.React;
    module.exports = { __esModule: true, default: function Link(p) {
      var rest = Object.assign({}, p); delete rest.prefetch;
      return R.createElement("a", rest, p.children);
    } };`,
  "next/navigation": `
    module.exports = {
      useRouter: function () { return { push: function (u) { window.__nav.push(u); }, replace: function () {}, refresh: function () {} }; },
      usePathname: function () { return window.__pathname || "/dashboard"; },
      useParams: function () { return window.__params || {}; },
      useSearchParams: function () { return new URLSearchParams(); },
    };`,
  "@clerk/nextjs": `
    module.exports = {
      useAuth: function () { return { isLoaded: true, isSignedIn: true, userId: "user_me" }; },
      useUser: function () { return { isLoaded: true, isSignedIn: true, user: { id: "user_me" } }; },
    };`,
  "lucide-react": `
    var R = window.React;
    module.exports = new Proxy({ __esModule: true }, { get: function (t, name) {
      if (name === "__esModule") return true;
      return function Icon(p) { return R.createElement("svg", { width: 16, height: 16, className: p.className, "aria-hidden": p["aria-hidden"] }); };
    } });`,
};

function resolveLocal(from: string, spec: string): string {
  const base = spec.startsWith("@/") ? path.join(root, "src", spec.slice(2)) : path.resolve(path.dirname(from), spec);
  for (const ext of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
    if (existsSync(base + ext) && !base.endsWith(path.sep)) {
      try {
        readFileSync(base + ext);
        return base + ext;
      } catch {
        /* a directory */
      }
    }
  }
  throw new Error(`cannot resolve ${spec} from ${from}`);
}

/** Every module an entry needs, as browser scripts that register themselves. */
function bundle(entries: string[]): string {
  const out: string[] = [];
  const seen = new Set<string>();
  const ids = new Map<string, string>();
  const visit = (file: string): string => {
    const id = path.relative(root, file).replace(/\\/g, "/");
    if (seen.has(id)) return id;
    seen.add(id);
    const source = readFileSync(file, "utf8");
    const code = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, jsx: ts.JsxEmit.React, esModuleInterop: true },
    }).outputText;
    const map: Record<string, string> = {};
    for (const m of code.matchAll(/require\("([^"]+)"\)/g)) {
      const spec = m[1];
      if (STUBS[spec]) map[spec] = "stub:" + spec;
      else if (spec.startsWith(".") || spec.startsWith("@/")) map[spec] = visit(resolveLocal(file, spec));
      else throw new Error(`no stub for ${spec} (needed by ${id})`);
    }
    ids.set(id, id);
    out.push(`window.__define(${JSON.stringify(id)}, ${JSON.stringify(map)}, function (module, exports, require) {\n${code}\n});`);
    return id;
  };
  for (const e of entries) visit(path.join(root, e));
  return out.join("\n");
}

const LOADER = `
  window.process = { env: { NEXT_PUBLIC_VAPID_PUBLIC_KEY: "" } };
  window.__nav = [];
  var defs = {}, cache = {};
  var stubs = ${JSON.stringify(STUBS)};
  window.__define = function (id, map, factory) { defs[id] = { map: map, factory: factory }; };
  function load(id) {
    if (cache[id]) return cache[id].exports;
    var module = { exports: {} };
    cache[id] = module;
    if (id.indexOf("stub:") === 0) { new Function("module", "exports", stubs[id.slice(5)])(module, module.exports); return module.exports; }
    var d = defs[id];
    d.factory(module, module.exports, function (spec) { return load(d.map[spec]); });
    return module.exports;
  }
  window.__require = load;
`;

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const longName = "Oluwaseun Adebayo-Williamson the Third";

const members = [
  { userId: "user_me", role: "owner", name: "Ada Okafor", email: "ada@example.com", joinedAt: 1, addedBy: "user_me" },
  { userId: "user_h", role: "host", name: longName, email: "oluwaseun.adebayo-williamson.the.third@averyveryverylongdomainname.example.com", joinedAt: 2, addedBy: "user_me" },
  { userId: "user_m", role: "moderator", name: "Musa", email: "musa@example.com", joinedAt: 3, addedBy: "user_me" },
  ...Array.from({ length: 12 }, (_, i) => ({ userId: `user_p${i}`, role: "participant", name: `Member number ${i + 1}`, email: `member${i + 1}@example.com`, joinedAt: 10 + i, addedBy: "user_me" })),
];

const group = {
  id: "g1",
  name: "The Lagos Central Choir and Ushering Department",
  description: "Rehearsals every Tuesday. Bring your folders.",
  iconUrl: "",
  creatorId: "user_me",
  createdAt: iso(NOW),
  updatedAt: iso(NOW),
  settings: { retryIntervalMin: 3, maxAttempts: 5 },
};

const capabilities = {
  role: "owner",
  manageMembers: true,
  assignableRoles: ["host", "moderator", "participant"],
  removableRoles: ["host", "moderator", "participant"],
  editSettings: true,
  deleteGroup: true,
  transferOwnership: true,
  leave: false,
  schedule: true,
  start: true,
  call: true,
  addParticipants: true,
  viewReports: true,
  exportReports: true,
};

const meetingItem = (i: number, state: string, startMs: number) => ({
  id: `e${i}`,
  slug: `meeting-${i}`,
  title: i === 0 ? "A very long meeting title that keeps going for a while to test wrapping" : `Rehearsal ${i}`,
  description: "",
  state,
  kind: "scheduled",
  start: iso(startMs),
  durationMin: 90,
  timezone: "Africa/Lagos",
  invitedCount: 15,
  attendedCount: 11,
  hasPassword: false,
  waitingRoom: true,
  createdBy: "user_me",
});

const participants = members.map((m, i) => ({
  key: m.userId,
  userId: m.userId,
  name: m.name,
  email: m.email,
  invited: true,
  status: i % 4 === 3 ? "absent" : "present",
  declined: i === 7,
  joinedAt: i % 4 === 3 ? null : NOW - 3_600_000 + i * 60_000,
  leftAt: i % 4 === 3 ? null : NOW - 600_000,
  attendedMs: i % 4 === 3 ? 0 : 2_500_000,
  entries: i === 2 ? 3 : 1,
  callAttempts: i % 3,
  missedCalls: i % 2,
}));

const report = {
  eventId: "e9",
  slug: "meeting-9",
  title: "Sunday service planning",
  group: { id: "g1", name: group.name },
  kind: "scheduled",
  state: "ended",
  hosts: ["Ada Okafor", longName],
  scheduledStart: iso(NOW - 3_700_000),
  actualStart: iso(NOW - 3_600_000),
  actualEnd: iso(NOW - 600_000),
  durationMin: 50,
  participants,
  summary: {
    invited: 15, attended: 11, absent: 4, firstToJoin: "Ada Okafor", lastToLeave: longName,
    totalCallAttempts: 15, totalMissedCalls: 7, chatMessages: 42, recordingUrl: "/replay/meeting-9", recorded: true,
    aiSummary: "We agreed the order of service and who reads.",
  },
  builtAt: NOW,
};

const chat = {
  ver: 7,
  hasOlder: true,
  live: [{ slug: "meeting-live", title: "Rehearsal happening right now" }],
  messages: [
    { id: "m1", userId: null, name: "NeoConference", text: "Ada Okafor scheduled “Rehearsal” · Tue 14 Oct 2026, 10:00 (Africa/Lagos)", ts: iso(NOW - 86_400_000), system: true, link: { href: "/meeting-1", label: "Open meeting" } },
    { id: "m2", userId: "user_h", name: longName, text: "A".repeat(120), ts: iso(NOW - 3_000_000) },
    { id: "m3", userId: "user_me", name: "Ada Okafor", text: "Thanks @Musa — see https://example.com/a/very/long/link/that/should/wrap/somewhere/in/the/bubble", ts: iso(NOW - 2_000_000), mentions: ["user_m"], replyToId: "m2", replyTo: { id: "m2", name: longName, snippet: "A".repeat(140) } },
    { id: "m4", userId: "user_m", name: "Musa", text: "", ts: iso(NOW - 1_000_000), attachments: [{ url: null, name: "programme-sheet-for-sunday-final-final-v3.pdf", size: 240_000, mime: "application/pdf", kind: "file" }] },
    { id: "m5", userId: "user_p1", name: "Member number 2", text: "Message removed", ts: iso(NOW - 500_000), deleted: true },
  ],
};

const notifications = {
  unread: 3,
  nextCursor: null,
  items: [
    { id: "n1", ts: NOW - 30_000, type: "ring", title: `${group.name}: Rehearsal`, body: "Ada Okafor is calling", url: "/room/meeting-1?event=meeting-1&join=1", read: false, eventSlug: "meeting-1", ringId: "r1", expiresAt: "__SOON__", caller: "Ada Okafor", groupName: group.name, meetingTitle: "Rehearsal with a long name for the overlay" },
    { id: "n2", ts: NOW - 60_000, type: "invite", title: "Rehearsal", body: `Ada Okafor invited you · Tue 14 Oct 2026, 10:00 (Africa/Lagos)`, url: "/meeting-1", read: false },
    { id: "n3", ts: NOW - 120_000, type: "mention", title: `Musa mentioned you in ${group.name}`, body: "A".repeat(140), url: "/dashboard/groups/g1?tab=chat", read: true },
  ],
};

const myReports = {
  nextCursor: null,
  items: [
    { eventId: "e9", title: "Sunday service planning", groupName: group.name, date: iso(NOW - 86_400_000), durationMin: 50, attendedMs: 2_500_000, status: "present", declined: false },
    { eventId: "e8", title: "Missed one", groupName: "Ushers", date: iso(NOW - 2 * 86_400_000), durationMin: 30, attendedMs: 0, status: "absent", declined: true },
  ],
};

const API = {
  "/api/groups/g1/meetings?scope=upcoming": { items: [meetingItem(1, "live", NOW - 600_000), meetingItem(0, "scheduled", NOW + 600_000), meetingItem(2, "scheduled", NOW + 86_400_000)], nextCursor: null },
  "/api/groups/g1/meetings?scope=past": { items: [meetingItem(3, "ended", NOW - 86_400_000), meetingItem(4, "ended", NOW - 2 * 86_400_000)], nextCursor: 5 },
  "/api/groups/g1/reports?": { items: Array.from({ length: 6 }, (_, i) => ({ eventId: `e${i}`, title: i === 0 ? "A very long meeting title that keeps going for a while" : `Rehearsal ${i}`, kind: "scheduled", date: iso(NOW - i * 86_400_000), durationMin: 75, invited: 15, attended: 12, absent: 3 })), nextCursor: null },
  "/api/groups/g1/messages": chat,
  "/api/me/notifications": notifications,
  "/api/me/meetings": myReports,
};

/* -------------------------------------------------------------------------- */
/*  Page setup                                                                 */
/* -------------------------------------------------------------------------- */

let css = "";
test.beforeAll(() => {
  const out = path.join(mkdtempSync(path.join(tmpdir(), "neo-css-")), "site.css");
  const cli = require.resolve("tailwindcss/lib/cli.js");
  execFileSync(process.execPath, [cli, "-c", path.join(root, "tailwind.config.ts"), "-i", path.join(root, "src/app/globals.css"), "-o", out], { cwd: root, stdio: "pipe" });
  css = readFileSync(out, "utf8");
});

const ENTRIES = [
  "src/app/dashboard/groups/[id]/GroupView.tsx",
  "src/components/notifications/IncomingCall.tsx",
  "src/components/notifications/NotificationBell.tsx",
  "src/app/dashboard/groups/[id]/reports/[eid]/MeetingReportView.tsx",
  "src/app/dashboard/reports/page.tsx",
];
let modules = "";

async function setup(page: Page, width: number): Promise<{ errors: string[]; calls: Array<{ url: string; method: string; body: string }> }> {
  if (!modules) modules = bundle(ENTRIES);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width, height: 800 });
  await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body style="margin:0;background:#05070d"><div id="app"></div></body></html>`);
  await page.addScriptTag({ path: umd("react", "react.production.min.js") });
  await page.addScriptTag({ path: umd("react-dom", "react-dom.production.min.js") });
  await page.addScriptTag({ content: LOADER });
  await page.addScriptTag({ content: modules });
  await page.evaluate((api) => {
    const w = window as unknown as { __calls: Array<{ url: string; method: string; body: string }> };
    w.__calls = [];
    window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      w.__calls.push({ url, method: init?.method || "GET", body: typeof init?.body === "string" ? init.body : "" });
      const key = Object.keys(api).find((k) => url === k || url.startsWith(k));
      const body = key ? (api as Record<string, unknown>)[key] : { ok: true };
      // A ring lasts 45 s from when it is read, however long the run takes.
      const text = JSON.stringify(body).replace(/"__SOON__"/g, String(Date.now() + 40_000));
      return new Response(text, { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
  }, API);
  return {
    errors,
    get calls() {
      return [];
    },
  } as never;
}

async function render(page: Page, entry: string, props: Record<string, unknown>) {
  await page.evaluate(
    ({ entry, props }) => {
      const w = window as unknown as { __require: (id: string) => { default: unknown }; React: typeof import("react"); ReactDOM: { createRoot: (el: Element) => { render: (n: unknown) => void } } };
      const C = w.__require(entry).default as Parameters<typeof w.React.createElement>[0];
      w.ReactDOM.createRoot(document.getElementById("app")!).render(w.React.createElement(C, props));
    },
    { entry, props }
  );
  await page.evaluate(() => new Promise((r) => setTimeout(r, 120)));
}

/** Nothing on the page makes it scroll sideways. */
async function expectNoSideScroll(page: Page, where: string) {
  const { scroll, inner, culprit } = await page.evaluate(() => {
    const inner = window.innerWidth;
    let culprit = "";
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("#app *"))) {
      const r = el.getBoundingClientRect();
      if (r.right > inner + 1 && getComputedStyle(el).position !== "fixed") {
        // Inside something that scrolls on its own is fine (wide tables).
        let p = el.parentElement;
        let contained = false;
        while (p) {
          const o = getComputedStyle(p).overflowX;
          if (o === "auto" || o === "scroll" || o === "hidden") { contained = true; break; }
          p = p.parentElement;
        }
        if (!contained) { culprit = `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 80)} → ${Math.round(r.right)}px`; break; }
      }
    }
    return { scroll: document.documentElement.scrollWidth, inner, culprit };
  });
  expect(culprit, `${where}: element sticking out`).toBe("");
  expect(scroll, `${where}: page scrolls sideways`).toBeLessThanOrEqual(inner);
}

/** Every button names what it does. */
async function expectLabelledButtons(page: Page, where: string) {
  const bare = await page.evaluate(() =>
    Array.from(document.querySelectorAll("button"))
      .filter((b) => !(b.textContent || "").trim() && !b.getAttribute("aria-label") && !b.getAttribute("aria-labelledby"))
      .map((b) => b.outerHTML.slice(0, 120))
  );
  expect(bare, `${where}: buttons with no name`).toEqual([]);
}

const WIDTHS = [360, 768, 1280];
const groupProps = {
  group,
  members,
  activity: Array.from({ length: 8 }, (_, i) => ({ ts: NOW - i * 3_600_000, actorId: "user_me", type: "meeting_scheduled", detail: i === 0 ? `Ada Okafor scheduled “${"A very long meeting name ".repeat(4)}” (12 meetings)` : `Something happened ${i}` })),
  me: { userId: "user_me", role: "owner" },
  capabilities,
  chatUnread: 4,
  nextMeeting: { slug: "meeting-0", title: "A very long meeting title that keeps going for a while", start: iso(NOW + 600_000), state: "scheduled" },
};

/* -------------------------------------------------------------------------- */
/*  Tests                                                                      */
/* -------------------------------------------------------------------------- */

for (const width of WIDTHS) {
  test(`group page, every tab, at ${width}px`, async ({ page }) => {
    const { errors } = await setup(page, width);
    await render(page, "src/app/dashboard/groups/[id]/GroupView.tsx", groupProps);
    for (const tab of ["Members", "Chat", "Meetings", "Reports", "Settings"]) {
      await page.getByRole("tab", { name: new RegExp(`^${tab}`) }).click();
      await page.evaluate(() => new Promise((r) => setTimeout(r, 150)));
      await expectNoSideScroll(page, `${tab} @${width}`);
      await expectLabelledButtons(page, `${tab} @${width}`);
      await page.screenshot({ path: `test-results/group-screens/group-${tab.toLowerCase()}-${width}.png`, fullPage: true });
    }
    expect(errors).toEqual([]);
  });

  test(`schedule dialog and call picker at ${width}px`, async ({ page }) => {
    const { errors } = await setup(page, width);
    await render(page, "src/app/dashboard/groups/[id]/GroupView.tsx", groupProps);
    await page.getByRole("button", { name: "Schedule" }).click();
    await page.getByRole("button", { name: "Weekly" }).click();
    await expectNoSideScroll(page, `schedule @${width}`);
    await expectLabelledButtons(page, `schedule @${width}`);
    await page.screenshot({ path: `test-results/group-screens/schedule-${width}.png` });
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Call", exact: true }).click();
    await expectNoSideScroll(page, `call picker @${width}`);
    await page.screenshot({ path: `test-results/group-screens/call-${width}.png` });
    expect(errors).toEqual([]);
  });

  test(`ring overlay and notification bell at ${width}px`, async ({ page }) => {
    const { errors } = await setup(page, width);
    await page.evaluate(() => {
      const w = window as unknown as { __require: (id: string) => { default: unknown }; React: typeof import("react"); ReactDOM: { createRoot: (el: Element) => { render: (n: unknown) => void } } };
      const h = w.React.createElement;
      const Bell = w.__require("src/components/notifications/NotificationBell.tsx").default as Parameters<typeof h>[0];
      const Ring = w.__require("src/components/notifications/IncomingCall.tsx").default as Parameters<typeof h>[0];
      w.ReactDOM.createRoot(document.getElementById("app")!).render(
        h("div", null, h("header", { style: { display: "flex", justifyContent: "flex-end", padding: "12px 16px" } }, h(Bell)), h(Ring))
      );
    });
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await expectNoSideScroll(page, `ring @${width}`);
    await page.screenshot({ path: `test-results/group-screens/ring-${width}.png` });
    await page.getByRole("button", { name: /Notifications/ }).click();
    await expectNoSideScroll(page, `bell @${width}`);
    await expectLabelledButtons(page, `bell @${width}`);
    await page.screenshot({ path: `test-results/group-screens/bell-${width}.png` });
    expect(errors).toEqual([]);
  });

  test(`meeting report and My meeting reports at ${width}px`, async ({ page }) => {
    const { errors } = await setup(page, width);
    await render(page, "src/app/dashboard/groups/[id]/reports/[eid]/MeetingReportView.tsx", { report, groupId: "g1", canExport: true });
    await expectNoSideScroll(page, `report @${width}`);
    await expectLabelledButtons(page, `report @${width}`);
    await page.screenshot({ path: `test-results/group-screens/report-${width}.png`, fullPage: true });
    await render(page, "src/app/dashboard/reports/page.tsx", {});
    await expectNoSideScroll(page, `my reports @${width}`);
    await page.screenshot({ path: `test-results/group-screens/my-reports-${width}.png`, fullPage: true });
    expect(errors).toEqual([]);
  });
}

test("dialogs keep focus inside, close on Escape and give focus back", async ({ page }) => {
  await setup(page, 768);
  await render(page, "src/app/dashboard/groups/[id]/GroupView.tsx", groupProps);
  const opener = page.getByRole("button", { name: "Schedule" });
  await opener.focus();
  await opener.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press(i % 7 === 6 ? "Shift+Tab" : "Tab");
    const inside = await page.evaluate(() => Boolean(document.activeElement?.closest("[role=dialog]")));
    expect(inside, `focus left the dialog after ${i + 1} tabs`).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("the ring overlay is announced, Answer has focus, and Escape declines", async ({ page }) => {
  await setup(page, 360);
  await render(page, "src/components/notifications/IncomingCall.tsx", {});
  await expect(page.locator("[aria-live=assertive]")).toContainText("Ada Okafor is calling you into");
  await expect(page.getByRole("button", { name: "Answer" })).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest("[role=alertdialog]")))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  const calls = await page.evaluate(() => (window as unknown as { __calls: Array<{ url: string; body: string }> }).__calls);
  const decline = calls.find((c) => c.url === "/api/events/meeting-1/call-response");
  expect(decline && JSON.parse(decline.body)).toEqual({ action: "decline", ringId: "r1" });
});
