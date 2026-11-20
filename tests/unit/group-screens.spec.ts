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
      // The sign-in form's Clerk: window.__signIn is the resource, calls recorded in window.__clerkCalls.
      useSignIn: function () { return { isLoaded: true, signIn: window.__signIn, setActive: function (a) { window.__clerkCalls.push(["setActive", a]); return Promise.resolve(); } }; },
      useSignUp: function () { return { isLoaded: true, signUp: window.__signUp, setActive: function (a) { window.__clerkCalls.push(["setActive", a]); return Promise.resolve(); } }; },
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

const feedbackKinds = [
  { key: "sound", label: "Sound" },
  { key: "video", label: "Video" },
  { key: "joining", label: "Getting in" },
  { key: "dropping", label: "Keeps dropping out" },
  { key: "other", label: "Something else" },
];

const API = {
  "/api/groups/g1/meetings?scope=upcoming": { items: [meetingItem(1, "live", NOW - 600_000), meetingItem(0, "scheduled", NOW + 600_000), meetingItem(2, "scheduled", NOW + 86_400_000)], nextCursor: null },
  "/api/groups/g1/meetings?scope=past": { items: [meetingItem(3, "ended", NOW - 86_400_000), meetingItem(4, "ended", NOW - 2 * 86_400_000)], nextCursor: 5 },
  "/api/groups/g1/reports?": { items: Array.from({ length: 6 }, (_, i) => ({ eventId: `e${i}`, title: i === 0 ? "A very long meeting title that keeps going for a while" : `Rehearsal ${i}`, kind: "scheduled", date: iso(NOW - i * 86_400_000), durationMin: 75, invited: 15, attended: 12, absent: 3 })), nextCursor: null },
  "/api/groups/g1/messages": chat,
  "/api/me/notifications": notifications,
  "/api/me/meetings": myReports,
  "/api/groups/g1/meetings": { slug: "neo-group-meeting" },
  // GET and POST share the stub: the room asks what it may do, then rings.
  "/api/events/neomeeting/ring-in": {
    open: true,
    groups: [
      { id: "g1", name: "neomeeting", members: [{ userId: "user_a", name: "Ada" }, { userId: "user_b", name: longName }] },
      { id: "g2", name: "hsmanagers", members: Array.from({ length: 30 }, (_, i) => ({ userId: `user_h${i}`, name: `Manager ${i + 1}` })) },
    ],
    rung: ["user_h0", "user_h1"],
    busy: ["user_h2"],
  },
  "/api/events/ended-room/ring-in": { open: false, groups: [] },
  // Meeting feedback (src/lib/meetingFeedback.ts). The panel's GET first:
  // "/api/events/ev_fb" would also match it by prefix.
  "/api/events/sa/feedback": { meeting: { name: "SA Regional Meeting", slug: "sa" }, kinds: feedbackKinds, token: "1700000000000.sig", signedIn: false, ok: true, ticket: 1042 },
  "/api/events/ev_fb/feedback": {
    meeting: { name: "SA Regional Meeting", slug: "sa" },
    kinds: feedbackKinds,
    token: null,
    signedIn: true,
    manage: {
      feedback: [
        { id: "f1", ts: NOW - 60_000, where: "room", kind: "sound", message: "The sound keeps cutting out " + "and coming back ".repeat(12), name: longName, email: "oluwaseun.adebayo-williamson.the.third@averyveryverylongdomainname.example.com", device: "Chrome on Android" },
        { id: "f2", ts: NOW - 120_000, where: "after", rating: 2, message: "", name: "Ada", device: "Safari on iPhone" },
        { id: "f3", ts: NOW - 180_000, where: "link", kind: "joining", message: "The link would not open", name: "", device: "unknown device" },
      ],
      tally: { stars: [0, 1, 0, 0, 0], rated: 1, average: 2, kinds: { sound: 1, joining: 1 }, written: 2 },
      contact: null,
      contactAllowed: true,
      reach: { kcHandleKnown: null, ownerKcLinked: null },
    },
  },
  "/api/events/ev_free/feedback": {
    meeting: { name: "Free meeting", slug: "free" },
    kinds: feedbackKinds,
    token: null,
    signedIn: true,
    manage: { feedback: [], tally: { stars: [0, 0, 0, 0, 0], rated: 0, average: null, kinds: {}, written: 0 }, contact: null, contactAllowed: false, reach: { kcHandleKnown: null, ownerKcLinked: null } },
  },
  "/api/events/ev_fb": {
    ok: true,
    event: { id: "ev_fb", feedbackContact: { kcHandle: "pastormatt", email: "help@church.org" } },
    feedbackReach: { kcHandleKnown: false, ownerKcLinked: true },
  },
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
  "src/components/HeaderNav.tsx",
  "src/app/dashboard/groups/[id]/reports/[eid]/MeetingReportView.tsx",
  "src/app/dashboard/reports/page.tsx",
  "src/app/dashboard/DashboardGroups.tsx",
  "src/components/EnterMeetingButton.tsx",
  "src/components/groups/RingIntoMeeting.tsx",
  "src/app/sign-in/[[...sign-in]]/EmailPasswordSignIn.tsx",
  "src/app/sign-up/[[...sign-up]]/EmailPasswordSignUp.tsx",
  "src/components/feedback/FeedbackForm.tsx",
  "src/components/feedback/FeedbackButton.tsx",
  "src/app/dashboard/e/[slug]/FeedbackPanel.tsx",
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

  // Seen on a phone (2026-10-26): in the site's header the avatar menu sits
  // right of the bell, so a panel lined up with the bell's right edge started
  // off the left of the screen ("otifications"). The page did not scroll
  // sideways, so expectNoSideScroll never saw it. Rendered here in the
  // layout's own header, with the real HeaderNav.
  test(`the notification panel stays on screen in the site header at ${width}px`, async ({ page }) => {
    const { errors } = await setup(page, width);
    await page.evaluate(() => {
      const w = window as unknown as { __require: (id: string) => { default: unknown }; React: typeof import("react"); ReactDOM: { createRoot: (el: Element) => { render: (n: unknown) => void } } };
      const h = w.React.createElement;
      const Nav = w.__require("src/components/HeaderNav.tsx").default as import("react").FC<{ role?: string | null }>;
      // src/app/layout.tsx's header, with the logo and name.
      w.ReactDOM.createRoot(document.getElementById("app")!).render(
        h("header", { className: "sticky top-0 z-40 backdrop-blur-xl bg-[rgba(4,8,16,0.55)] border-b border-white/5" },
          h("div", { className: "mx-auto max-w-7xl px-4 sm:px-6 py-3 flex items-center justify-between" },
            h("a", { href: "/", className: "group inline-flex items-center gap-2.5" },
              h("span", { className: "h-8 w-8 rounded-xl" }),
              h("span", { className: "font-semibold tracking-tight text-cyan-100 text-[17px]" }, "NeoLinguaMeet")),
            h(Nav, { role: null })))
      );
    });
    await page.getByRole("button", { name: /Notifications/ }).click();
    const panel = page.getByRole("menu");
    await expect(panel).toBeVisible();
    const box = (await panel.boundingBox())!;
    expect(box.x, `panel's left edge @${width}`).toBeGreaterThanOrEqual(8);
    expect(box.x + box.width, `panel's right edge @${width}`).toBeLessThanOrEqual(width - 8);
    const heading = (await panel.getByText("Notifications", { exact: true }).boundingBox())!;
    expect(heading.x, `heading @${width}`).toBeGreaterThanOrEqual(box.x);
    await page.screenshot({ path: `test-results/group-screens/header-bell-${width}.png` });

    // Each one can be cleared, by a button inside the panel that does not
    // sit over its text; then all of them at once.
    const sent = () =>
      page.evaluate(() =>
        (window as unknown as { __calls: Array<{ url: string; method: string; body: string }> }).__calls
          .filter((c) => c.method === "DELETE")
          .map((c) => c.body)
      );
    const clearOne = panel.getByRole("menuitem", { name: "Clear “Rehearsal”" });
    const x = (await clearOne.boundingBox())!;
    expect(x.x + x.width, `× inside the panel @${width}`).toBeLessThanOrEqual(box.x + box.width);
    const title = (await panel.getByText("Rehearsal", { exact: true }).boundingBox())!;
    expect(title.x + title.width, `× clear of the title @${width}`).toBeLessThanOrEqual(x.x);
    await clearOne.click();
    await expect.poll(sent).toEqual([JSON.stringify({ ids: ["n2"] })]);
    await panel.getByRole("button", { name: "Clear all" }).click();
    await expect.poll(sent).toEqual([JSON.stringify({ ids: ["n2"] }), JSON.stringify({ all: true })]);
    await expect(panel.getByText("Nothing yet.")).toBeVisible();
    await expectLabelledButtons(page, `header bell @${width}`);
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

const callsOf = (page: Page) =>
  page.evaluate(() => (window as unknown as { __calls: Array<{ url: string; method: string; body: string }> }).__calls);

test("the dashboard's Call opens a group with its call picker already showing", async ({ page }) => {
  const { errors } = await setup(page, 1280);
  await render(page, "src/app/dashboard/groups/[id]/GroupView.tsx", { ...groupProps, openCall: true });
  await expect(page.getByRole("dialog", { name: "Private call" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("without it the group page opens as before, picker closed", async ({ page }) => {
  await setup(page, 1280);
  await render(page, "src/app/dashboard/groups/[id]/GroupView.tsx", groupProps);
  await expect(page.getByRole("dialog", { name: "Private call" })).toHaveCount(0);
});

const dashGroups = [
  { id: "g1", name: "neomeeting", memberCount: 12, canStart: true, canCall: true },
  { id: "g2", name: "A group whose name goes on for rather a long time indeed", memberCount: 111, canStart: true, canCall: true },
  { id: "g3", name: "Connect", memberCount: 3, canStart: false, canCall: false },
];

for (const width of WIDTHS) {
  test(`"Your groups" on the dashboard at ${width}px: every group, its buttons, nothing off the side`, async ({ page }) => {
    const { errors } = await setup(page, width);
    await render(page, "src/app/dashboard/DashboardGroups.tsx", { groups: dashGroups });
    await expect(page.getByRole("heading", { name: "Your groups" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Start a meeting for neomeeting" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Call people in neomeeting" })).toHaveAttribute("href", "/dashboard/groups/g1?call=1");
    // A member who may not start or call sees the group, not the buttons.
    await expect(page.getByRole("link", { name: /^Connect/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Start a meeting for Connect" })).toHaveCount(0);
    await expectNoSideScroll(page, `your groups @${width}`);
    await expectLabelledButtons(page, `your groups @${width}`);
    await page.screenshot({ path: `test-results/group-screens/dashboard-groups-${width}.png` });
    expect(errors).toEqual([]);
  });
}

test("Start meeting on the dashboard starts the group's meeting now, as the group page's button does", async ({ page }) => {
  await setup(page, 1280);
  await render(page, "src/app/dashboard/DashboardGroups.tsx", { groups: dashGroups });
  await page.getByRole("button", { name: "Start a meeting for neomeeting" }).click();
  await expect.poll(async () => (await callsOf(page)).filter((c) => c.url === "/api/groups/g1/meetings").length).toBe(1);
  const call = (await callsOf(page)).find((c) => c.url === "/api/groups/g1/meetings")!;
  expect(call.method).toBe("POST");
  expect(JSON.parse(call.body)).toMatchObject({ mode: "now", title: "neomeeting meeting" });
});

test("Enter meeting: a meeting that is on is a link into its room", async ({ page }) => {
  await setup(page, 1280);
  await render(page, "src/components/EnterMeetingButton.tsx", { eventId: "e1", slug: "neomeeting", livekitRoom: "neomeeting", state: "live", className: "x" });
  await expect(page.getByRole("link", { name: "Enter meeting →" })).toHaveAttribute("href", "/room/neomeeting?event=neomeeting");
  expect(await callsOf(page)).toEqual([]);
});

test("Enter meeting: an ended meeting is reopened and entered in one click", async ({ page }) => {
  await setup(page, 1280);
  await render(page, "src/components/EnterMeetingButton.tsx", { eventId: "e1", slug: "neomeeting", livekitRoom: "neomeeting", state: "ended", className: "x" });
  await expect(page.getByRole("link")).toHaveCount(0);
  await page.getByRole("button", { name: "Enter meeting →" }).click();
  await expect.poll(async () => (await callsOf(page)).map((c) => `${c.method} ${c.url}`)).toEqual(["POST /api/events/e1/start"]);
});

for (const width of [360, 1280]) {
  test(`in the room, Call people in rings members of a chosen group into this meeting, at ${width}px`, async ({ page }) => {
    const { errors } = await setup(page, width);
    await render(page, "src/components/groups/RingIntoMeeting.tsx", { slug: "neomeeting" });
    await page.getByRole("button", { name: "Call people in" }).click();
    await page.getByLabel("From group").selectOption("g2");
    await page.getByRole("button", { name: "Everyone in hsmanagers" }).click();
    await expect(page.getByRole("button", { name: "Call 30 people" })).toBeVisible();
    await expectNoSideScroll(page, `call people in @${width}`);
    await expectLabelledButtons(page, `call people in @${width}`);
    await page.screenshot({ path: `test-results/group-screens/ring-into-${width}.png`, fullPage: true });
    await page.getByRole("button", { name: "Call 30 people" }).click();
    await expect(page.getByRole("status")).toHaveText("Ringing 2 people. 1 is in another meeting and got a message instead.");
    const post = (await callsOf(page)).find((c) => c.url === "/api/events/neomeeting/ring-in" && c.method === "POST")!;
    expect(JSON.parse(post.body)).toEqual({ groupId: "g2", userIds: Array.from({ length: 30 }, (_, i) => `user_h${i}`) });
    expect(errors).toEqual([]);
  });
}

test("Call people in is not shown once the meeting is over", async ({ page }) => {
  await setup(page, 1280);
  await render(page, "src/components/groups/RingIntoMeeting.tsx", { slug: "ended-room" });
  await expect(page.getByRole("button", { name: "Call people in" })).toHaveCount(0);
});

/**
 * The email-and-password sign-in against a stand-in for Clerk's sign-in:
 * `create` answers as `outcome` says. Calls land in window.__clerkCalls.
 */
async function signInWith(page: Page, outcome: "wrong_password" | "no_password" | "needs_code" | "complete") {
  await page.evaluate((outcome) => {
    const w = window as unknown as { __clerkCalls: unknown[][]; __signIn: unknown };
    w.__clerkCalls = [];
    const clerkError = (code: string, message: string) => Object.assign(new Error(message), { errors: [{ code, message, longMessage: message }] });
    const rec = (name: string, a?: unknown) => w.__clerkCalls.push([name, a]);
    w.__signIn = {
      create: async (a: unknown) => {
        rec("create", a);
        if (outcome === "wrong_password") throw clerkError("form_password_incorrect", "Password is incorrect. Try again, or use another method.");
        if (outcome === "no_password") throw clerkError("strategy_for_user_invalid", "Verification strategy is not valid for this account.");
        if (outcome === "needs_code")
          return { status: "needs_second_factor", supportedSecondFactors: [{ strategy: "email_code", emailAddressId: "idn_1", safeIdentifier: "ada@example.com" }] };
        return { status: "complete", createdSessionId: "sess_1" };
      },
      prepareSecondFactor: async (a: unknown) => rec("prepareSecondFactor", a),
      attemptSecondFactor: async (a: { code: string }) => {
        rec("attemptSecondFactor", a);
        if (a.code !== "123456") throw clerkError("form_code_incorrect", "Incorrect code");
        return { status: "complete", createdSessionId: "sess_2" };
      },
    };
  }, outcome);
  await render(page, "src/app/sign-in/[[...sign-in]]/EmailPasswordSignIn.tsx", {});
  await page.getByLabel("Email address").fill("ada@example.com");
  await page.getByLabel("Password", { exact: true }).fill("secret-1");
  await page.getByRole("button", { name: "Sign in" }).click();
}
const clerkCalls = (page: Page) => page.evaluate(() => (window as unknown as { __clerkCalls: unknown[][] }).__clerkCalls);
const navs = (page: Page) => page.evaluate(() => (window as unknown as { __nav: string[] }).__nav);

test("sign-in: a wrong password says what to do, KingsChat included, not Clerk's words", async ({ page }) => {
  await setup(page, 360);
  await signInWith(page, "wrong_password");
  await expect(page.getByRole("alert")).toContainText("That password isn’t right");
  await expect(page.getByRole("alert")).toContainText("Forgot password?");
  await expect(page.getByRole("alert")).toContainText("Continue with KingsChat");
});

test("sign-in: an account with no password (made with KingsChat) is told to use KingsChat", async ({ page }) => {
  await setup(page, 360);
  await signInWith(page, "no_password");
  await expect(page.getByRole("alert")).toHaveText("This account doesn’t use a password: sign in with “Continue with KingsChat” above (or Neoemail).");
});

test("sign-in: when Clerk asks for a code, it is sent, typed in and the person is signed in", async ({ page }) => {
  const { errors } = await setup(page, 360);
  await signInWith(page, "needs_code");
  await expect(page.getByRole("heading", { name: "Enter your sign-in code" })).toBeVisible();
  await expect(page.getByText("We sent a code to a••@example.com.")).toBeVisible();
  expect(await clerkCalls(page)).toContainEqual(["prepareSecondFactor", { strategy: "email_code", emailAddressId: "idn_1" }]);
  await expectNoSideScroll(page, "sign-in code @360");

  // A wrong code says so; a new code can be asked for.
  await page.getByLabel("Code").fill("000000");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("alert")).toContainText("That code isn’t right");
  await page.getByRole("button", { name: "Send a new code" }).click();
  await expect(page.getByRole("status")).toHaveText("A new code is on its way.");

  await page.getByLabel("Code").fill("123456");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect.poll(() => navs(page)).toEqual(["/"]);
  const calls = await clerkCalls(page);
  expect(calls).toContainEqual(["attemptSecondFactor", { strategy: "email_code", code: "123456" }]);
  expect(calls).toContainEqual(["setActive", { session: "sess_2" }]);
  expect(calls.filter((c) => c[0] === "prepareSecondFactor").length).toBe(2);
  expect(errors).toEqual([]);
});

test("sign-in: a plain sign-in goes straight in", async ({ page }) => {
  await setup(page, 1280);
  await signInWith(page, "complete");
  await expect.poll(() => navs(page)).toEqual(["/"]);
  expect(await clerkCalls(page)).toContainEqual(["setActive", { session: "sess_1" }]);
});

/** The sign-up form against a stand-in for Clerk's sign-up, answering as `outcome` says. */
async function signUpWith(page: Page, outcome: "email_taken" | "code" | "missing") {
  await page.evaluate((outcome) => {
    const w = window as unknown as { __clerkCalls: unknown[][]; __signUp: unknown };
    w.__clerkCalls = [];
    const clerkError = (code: string, message: string) => Object.assign(new Error(message), { errors: [{ code, message, longMessage: message }] });
    const rec = (name: string, a?: unknown) => w.__clerkCalls.push([name, a]);
    w.__signUp = {
      create: async (a: unknown) => {
        rec("create", a);
        if (outcome === "email_taken") throw clerkError("form_identifier_exists", "That email address is taken. Please try another.");
        return {};
      },
      prepareEmailAddressVerification: async (a: unknown) => rec("prepare", a),
      attemptEmailAddressVerification: async (a: { code: string }) => {
        rec("attempt", a);
        if (a.code !== "654321") throw clerkError("form_code_incorrect", "Incorrect code");
        if (outcome === "missing") return { status: "missing_requirements", missingFields: ["username"] };
        return { status: "complete", createdSessionId: "sess_new" };
      },
    };
  }, outcome);
  await render(page, "src/app/sign-up/[[...sign-up]]/EmailPasswordSignUp.tsx", {});
  await page.getByLabel("Email address").fill("ada@example.com");
  await page.getByLabel("Password", { exact: true }).fill("secret-123");
  await page.getByLabel("Confirm password", { exact: true }).fill("secret-123");
  await page.getByRole("button", { name: "Create account" }).click();
}

test("sign-up: an email that already has an account is told to sign in instead, KingsChat included", async ({ page }) => {
  await setup(page, 360);
  await signUpWith(page, "email_taken");
  await expect(page.getByRole("alert")).toContainText("This email already has an account. Sign in instead");
  await expect(page.getByRole("alert")).toContainText("Continue with KingsChat");
});

test("sign-up: the email code can be sent again; a wrong one is refused; the right one signs you in", async ({ page }) => {
  const { errors } = await setup(page, 360);
  await signUpWith(page, "code");
  await expect(page.getByRole("heading", { name: "Verify your email" })).toBeVisible();
  await page.getByLabel("Verification code").fill("111111");
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(page.getByRole("alert")).toContainText("That code isn’t right");
  await page.getByRole("button", { name: "Send a new code" }).click();
  await expect(page.getByRole("status")).toContainText("A new code is on its way");
  await expectNoSideScroll(page, "sign-up code @360");
  await page.getByLabel("Verification code").fill("654321");
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect.poll(() => navs(page)).toEqual(["/"]);
  const calls = await clerkCalls(page);
  expect(calls.filter((c) => c[0] === "prepare").length).toBe(2);
  expect(calls).toContainEqual(["setActive", { session: "sess_new" }]);
  expect(errors).toEqual([]);
});

test("sign-up: if the account still needs something after the code, it says what, not just 'incomplete'", async ({ page }) => {
  await setup(page, 360);
  await signUpWith(page, "missing");
  await page.getByLabel("Verification code").fill("654321");
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(page.getByRole("alert")).toContainText("the account also needs a username");
});

test("password boxes are named for what they are, and Show says what it shows and whether it is on", async ({ page }) => {
  await setup(page, 360);
  await page.evaluate(() => {
    (window as unknown as { __signUp: unknown; __clerkCalls: unknown[] }).__signUp = {};
    (window as unknown as { __clerkCalls: unknown[] }).__clerkCalls = [];
  });
  await render(page, "src/app/sign-up/[[...sign-up]]/EmailPasswordSignUp.tsx", {});
  // Not "Password Show", as it was when the Show button sat inside the label.
  const pw = page.getByRole("textbox", { name: "Password", exact: true });
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute("type", "password");
  const show = page.getByRole("button", { name: "Show password" });
  await expect(show).toHaveAttribute("aria-pressed", "false");
  await show.click();
  await expect(page.getByRole("button", { name: "Hide password" })).toHaveAttribute("aria-pressed", "true");
  await expect(pw).toHaveAttribute("type", "text");
  await expect(page.getByRole("button", { name: "Show confirm password" })).toBeVisible();

  // A mismatch is announced on the box itself.
  await page.getByLabel("Password", { exact: true }).fill("secret-123");
  await page.getByLabel("Confirm password", { exact: true }).fill("secret-12");
  const confirm = page.getByLabel("Confirm password", { exact: true });
  await expect(confirm).toHaveAttribute("aria-invalid", "true");
  await expect(confirm).toHaveAccessibleDescription("Passwords do not match.");
});

/* -------------------------------------------------------------------------- */
/*  Meeting feedback                                                           */
/* -------------------------------------------------------------------------- */

const feedbackPosts = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __calls: Array<{ url: string; method: string; body: string }> }).__calls
      .filter((c) => c.method === "POST" && c.url.includes("/feedback"))
      .map((c) => JSON.parse(c.body)),
  );

for (const width of WIDTHS) {
  test(`feedback link: a guest says what went wrong, with a name and email for a reply, at ${width}px`, async ({ page }) => {
    const { errors } = await setup(page, width);
    await render(page, "src/components/feedback/FeedbackForm.tsx", { slug: "sa", where: "link" });
    await expectNoSideScroll(page, `feedback form @${width}`);
    await expectLabelledButtons(page, `feedback form @${width}`);
    // Nothing is sent without words.
    await page.getByRole("button", { name: "Send feedback" }).click();
    await expect(page.getByRole("alert")).toHaveText("Write what happened first.");
    expect(await feedbackPosts(page)).toEqual([]);

    // The chip is the label; its radio is for screen readers and keys.
    await page.getByText("Sound", { exact: true }).click();
    await expect(page.getByRole("radio", { name: "Sound" })).toBeChecked();
    await page.getByLabel("What happened?").fill("No sound after I signed in again");
    await page.getByLabel("Your name (optional)").fill("Pastor Matthew");
    await page.getByLabel("Email (optional, for a reply)").fill("pm@example.com");
    await page.screenshot({ path: `test-results/group-screens/feedback-link-${width}.png`, fullPage: true });
    await page.getByRole("button", { name: "Send feedback" }).click();
    await expect(page.getByRole("status")).toContainText("Your feedback was sent");
    await expect(page.getByRole("status")).toContainText("They can reply to the email you gave.");
    expect(await feedbackPosts(page)).toEqual([
      { message: "No sound after I signed in again", kind: "sound", where: "link", token: "1700000000000.sig", website: "", name: "Pastor Matthew", email: "pm@example.com" },
    ]);
    expect(errors).toEqual([]);
  });
}

test("after leaving: one tap of the stars sends the rating; words can follow, without counting it again", async ({ page }) => {
  await setup(page, 360);
  await render(page, "src/components/feedback/FeedbackForm.tsx", { slug: "sa", where: "after" });
  await expect(page.getByText("How was SA Regional Meeting?")).toBeVisible();
  await page.getByRole("radio", { name: "4 stars" }).click();
  await expect(page.getByRole("status")).toContainText("Thanks, 4 stars sent.");
  await expect(page.getByRole("radio", { name: "4 stars" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("radio", { name: "5 stars" })).toBeDisabled();
  await page.getByLabel("Tell the organiser more").fill("Video froze twice");
  await page.getByRole("button", { name: "Send feedback" }).click();
  await expect(page.getByText("Your feedback was sent")).toBeVisible();
  const posts = await feedbackPosts(page);
  expect(posts.map((p) => [p.rating, p.message, p.where])).toEqual([
    [4, undefined, "after"],
    [undefined, "Video froze twice", "after"],
  ]);
});

test("in the meeting: Send feedback opens a dialog over everything, focus inside, and Escape closes it", async ({ page }) => {
  await setup(page, 360);
  await page.evaluate(() => {
    // The toolbar is transformed: a fixed dialog inside it would be trapped.
    document.getElementById("app")!.style.transform = "translateZ(0)";
  });
  await render(page, "src/components/feedback/FeedbackButton.tsx", { eventSlug: "sa", className: "px-2" });
  const open = page.getByRole("button", { name: "Send feedback" });
  await expect(open).toHaveAttribute("data-in-more", "true");
  await open.click();
  const dialog = page.getByRole("dialog", { name: "Send feedback" });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((d) => d.parentElement === document.body), "portalled to <body>").toBe(true);
  await expect(page.getByLabel("What happened?")).toBeFocused();
  await expectLabelledButtons(page, "feedback dialog");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

for (const width of WIDTHS) {
  test(`the owner's feedback panel: the link, where it goes, ratings and messages, at ${width}px`, async ({ page }) => {
    const { errors } = await setup(page, width);
    await render(page, "src/app/dashboard/e/[slug]/FeedbackPanel.tsx", { eventId: "ev_fb", slug: "sa" });
    await expect(page.getByText(/\/feedback\/sa$/)).toBeVisible();
    await expect(page.getByText("2.0 from 1 rating")).toBeVisible();
    await expect(page.getByText("2 written messages")).toBeVisible();
    await expect(page.getByText("Getting in: 1")).toBeVisible();
    await expect(page.getByText("The link would not open")).toBeVisible();
    await expect(page.getByLabel("2 of 5 stars")).toBeVisible();
    await expectNoSideScroll(page, `feedback panel @${width}`);
    await expectLabelledButtons(page, `feedback panel @${width}`);

    await page.getByLabel("KingsChat handle").fill("@PastorMatt");
    await page.getByLabel("Email").fill("Help@Church.org");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("status")).toHaveText("Saved. New feedback will be sent there too.");
    // What the server kept, and why KingsChat cannot reach it yet.
    await expect(page.getByLabel("KingsChat handle")).toHaveValue("@pastormatt");
    await expect(page.getByText("Nobody has signed in here with @pastormatt yet", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Remove" })).toBeVisible();
    const patch = await page.evaluate(() =>
      (window as unknown as { __calls: Array<{ url: string; method: string; body: string }> }).__calls.filter((c) => c.method === "PATCH"),
    );
    expect(patch.map((c) => [c.url, JSON.parse(c.body)])).toEqual([["/api/events/ev_fb", { feedbackContact: { kcHandle: "@PastorMatt", email: "Help@Church.org" } }]]);
    await page.screenshot({ path: `test-results/group-screens/feedback-panel-${width}.png`, fullPage: true });
    expect(errors).toEqual([]);
  });
}

test("the owner's feedback panel on the free plan: no contact boxes, a word about plans", async ({ page }) => {
  await setup(page, 360);
  await render(page, "src/app/dashboard/e/[slug]/FeedbackPanel.tsx", { eventId: "ev_free", slug: "free" });
  await expect(page.getByText("On a paid plan, feedback can also go straight to a KingsChat handle or an email.")).toBeVisible();
  await expect(page.getByRole("link", { name: "See plans" })).toHaveAttribute("href", "/pricing");
  await expect(page.getByLabel("KingsChat handle")).toHaveCount(0);
  await expect(page.getByText("No ratings yet")).toBeVisible();
  await expect(page.getByText("No feedback yet.")).toBeVisible();
});
