// examples/prayerclouds/server.mjs — a sample PrayerClouds adapter.
//
// What a partner website adds so /zone/<ZONE> shows that zone's NeoLinguaMeet
// meeting, each visitor joining under their own name. Node 18+, no
// dependencies:
//
//   NLM_PARTNER_KEY=nlm_pk_…  SITE_ORIGIN=http://localhost:4000  node server.mjs
//
// Three pieces, all on the partner's own site:
//   GET  /zone/:zone                      the zone page, with the widget script
//                                         and the prayer reports (prayer-reports.js)
//   POST /api/prayer-meeting/session      called by the widget; asks
//                                         NeoLinguaMeet for a one-time code
//                                         for THIS signed-in visitor
//   GET  /api/prayer-meeting/reports/*    prayer time and zone reports, read
//                                         from NeoLinguaMeet for THIS visitor
//
// The secret key stays here, on the server. The browser only ever sees a
// two-minute, single-use code. Replace currentUser() with your own session
// lookup; everything else can stay as it is.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const KEY = process.env.NLM_PARTNER_KEY || "";
const NLM = (process.env.NLM_ORIGIN || "https://neolinguameet.com").replace(/\/+$/, "");
/** This site's origin exactly as the browser sees it; it must be approved in NeoLinguaMeet's admin. */
const SITE_ORIGIN = (process.env.SITE_ORIGIN || "http://localhost:4000").replace(/\/+$/, "");
const PORT = Number(process.env.PORT || 4000);
/** Let visitors without an account in, by name (the integration must allow guests too). */
const GUESTS = process.env.ALLOW_GUESTS === "1";

if (!KEY) {
  console.error("Set NLM_PARTNER_KEY (from NeoLinguaMeet admin > Integrations > Partner zones).");
  process.exit(1);
}

/**
 * The signed-in PrayerClouds user, or null. REPLACE THIS with your own
 * session check (cookie, JWT, framework auth). The sample trusts a demo
 * cookie "demo_user=<id>|<name>" so it can run on its own.
 */
function currentUser(req) {
  const m = /(?:^|;\s*)demo_user=([^;]+)/.exec(req.headers.cookie || "");
  if (!m) return null;
  const [id, name] = decodeURIComponent(m[1]).split("|");
  return id && name ? { id, name } : null;
}

const ZONE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) break;
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

/** POST /api/prayer-meeting/session?zone=FALF  ->  { code } | { error } */
async function session(req, res, url) {
  // Only this site's own pages may ask (the widget calls it same-origin).
  if (req.headers.origin && req.headers.origin !== SITE_ORIGIN) return send(res, 403, { error: { code: "forbidden", message: "Not from this site." } });
  const zone = url.searchParams.get("zone") || "";
  if (!ZONE_RE.test(zone)) return send(res, 400, { error: { code: "invalid_zone", message: "Unknown zone." } });

  const user = currentUser(req);
  let who;
  if (user) {
    who = { id: String(user.id), displayName: String(user.name).slice(0, 60) };
  } else if (GUESTS) {
    const body = await readJson(req);
    const name = typeof body.displayName === "string" ? body.displayName.trim().slice(0, 60) : "";
    if (!name) return send(res, 401, { error: { code: "name_required", message: "Enter your name to join." } });
    who = { guest: true, displayName: name };
  } else {
    return send(res, 401, { error: { code: "sign_in_required", message: "Sign in to join the prayer meeting." } });
  }

  let r;
  try {
    r = await fetch(`${NLM}/api/partner/v1/join-sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ zoneId: zone, origin: SITE_ORIGIN, user: who }),
    });
  } catch {
    return send(res, 502, { error: { code: "unreachable", message: "The meeting service is not reachable. Try again." } });
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    // Pass NeoLinguaMeet's reason on (never the key); log it for yourselves.
    console.warn("[prayer-meeting] join-sessions", r.status, data?.error?.code);
    return send(res, r.status === 401 ? 502 : r.status, { error: data.error || { code: "failed", message: "Could not start the meeting." } });
  }
  return send(res, 200, { code: data.code, expiresAt: data.expiresAt, title: data.meeting?.title });
}

/*
 * GET /api/prayer-meeting/reports/<view>?zone=FALF&period=today[&from&to&page&pageSize&session]
 *   view: me | zone | participants | session | export | public
 *
 * Reads NeoLinguaMeet's report API with the key, naming the signed-in
 * visitor as the viewer (X-Viewer-Id). The viewer always comes from YOUR
 * login, never from the browser; NeoLinguaMeet decides what that person
 * may see (their own time; a zone's report only if they lead that zone or
 * administer the organisation). Keep the lists of leaders and
 * administrators in step with your own roles: PUT /api/partner/v1/roles
 * and /api/partner/v1/zones/:zone/leaders (see syncRoles below).
 */
const REPORT_PARAMS = ["period", "from", "to", "page", "pageSize"];
async function reports(req, res, url, view) {
  const zone = url.searchParams.get("zone") || "";
  if (!ZONE_RE.test(zone)) return send(res, 400, { error: { code: "invalid_zone", message: "Unknown zone." } });
  const z = encodeURIComponent(zone);
  const paths = {
    me: `/api/partner/v1/attendance/me?zoneId=${z}`,
    zone: `/api/partner/v1/reports/zones/${z}`,
    participants: `/api/partner/v1/reports/zones/${z}/participants`,
    export: `/api/partner/v1/reports/zones/${z}/export`,
    public: `/api/partner/v1/zones/${z}/public-stats`,
  };
  let path = paths[view];
  const sessionId = url.searchParams.get("session") || "";
  if (view === "session") {
    if (!/^ps_[a-f0-9]{16}$/.test(sessionId)) return send(res, 400, { error: { code: "invalid_session", message: "Unknown session." } });
    path = `/api/partner/v1/reports/zones/${z}/sessions/${sessionId}`;
  }
  if (!path) return send(res, 404, { error: { code: "not_found", message: "No such report." } });

  const user = currentUser(req);
  if (view !== "public" && !user) return send(res, 401, { error: { code: "sign_in_required", message: "Sign in to see prayer reports." } });

  const q = new URLSearchParams();
  for (const k of REPORT_PARAMS) if (url.searchParams.get(k)) q.set(k, url.searchParams.get(k));
  const target = `${NLM}${path}${path.includes("?") ? "&" : "?"}${q}`;
  const headers = { authorization: `Bearer ${KEY}` };
  if (view !== "public") headers["x-viewer-id"] = String(user.id);
  if (req.headers["if-none-match"]) headers["if-none-match"] = req.headers["if-none-match"];
  let r;
  try {
    r = await fetch(target, { headers });
  } catch {
    return send(res, 502, { error: { code: "unreachable", message: "The meeting service is not reachable." } });
  }
  const pass = { "cache-control": "private, no-cache" };
  for (const h of ["etag", "content-type", "content-disposition"]) if (r.headers.get(h)) pass[h] = r.headers.get(h);
  res.writeHead(r.status === 401 ? 502 : r.status, pass);
  res.end(r.status === 304 ? undefined : Buffer.from(await r.arrayBuffer()));
}

/**
 * Keeping NeoLinguaMeet's lists in step with your own roles: call this
 * whenever leaders or administrators change in PrayerClouds (or nightly).
 *   await syncRoles({ orgAdmins: ["u_1"], leaders: { FALF: ["u_7", "u_9"] } });
 */
export async function syncRoles({ orgAdmins = [], leaders = {} }) {
  const put = (path, body) =>
    fetch(`${NLM}${path}`, { method: "PUT", headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` }, body: JSON.stringify(body) }).then((r) => {
      if (!r.ok) throw new Error(`${path}: ${r.status}`);
    });
  await put("/api/partner/v1/roles", { orgAdmins });
  for (const [zone, ids] of Object.entries(leaders)) await put(`/api/partner/v1/zones/${encodeURIComponent(zone)}/leaders`, { leaders: ids });
}

const REPORTS_JS = readFileSync(new URL("./prayer-reports.js", import.meta.url));

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** GET /zone/:zone — your zone page; only the widget part matters. */
function zonePage(req, res, zone) {
  const user = currentUser(req);
  const endpoint = `/api/prayer-meeting/session?zone=${encodeURIComponent(zone)}`;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(zone)} Prayer Meeting</title>
<style>
body{font-family:system-ui,sans-serif;margin:0 auto;max-width:1100px;padding:16px}#status{font-size:14px;color:#555;min-height:1.4em}
.pr-stats{display:flex;flex-wrap:wrap;gap:8px}.pr-stat{border:1px solid #ddd;border-radius:8px;padding:8px 12px;min-width:120px}
.pr-stat-label{font-size:12px;color:#666}.pr-stat-value{font-size:18px;font-variant-numeric:tabular-nums}
.pr-table{border-collapse:collapse;width:100%;font-size:14px;margin:8px 0}.pr-table th,.pr-table td{border-bottom:1px solid #eee;padding:6px;text-align:left}
.pr-periods button[aria-pressed=true]{font-weight:700}.pr-updated,.pr-period{font-size:12px;color:#666}.pr-live{font-variant-numeric:tabular-nums;font-weight:600}
</style>
</head><body>
<h1>${escapeHtml(zone)} Prayer Meeting</h1>
${
  user
    ? `<p>Signed in as <strong>${escapeHtml(user.name)}</strong></p>`
    : GUESTS
      ? `<form id="guest"><label>Your name <input name="name" maxlength="60" required></label> <button>Join as a guest</button></form>`
      : `<p><a href="/login?next=${encodeURIComponent(`/zone/${zone}`)}">Sign in</a> to join.</p>`
}
<p id="status"></p>
<div id="meeting"></div>
<div id="prayer-reports"></div>
<script src="${NLM}/widget/v1.js"></script>
<script src="/prayer-reports.js"></script>
<script>
  const reports = PrayerReports.mount({ el: "#prayer-reports", zone: ${JSON.stringify(zone)}, signedIn: ${user ? "true" : "false"} });
  const status = document.getElementById("status");
  const signedIn = ${user ? "true" : "false"};
  function start(guestName) {
    const widget = NeoLinguaMeetWidget.mount({
      container: "#meeting",
      sessionEndpoint: ${JSON.stringify(endpoint)},
      // A guest's name goes in the request body, never in the address.
      sessionBody: guestName ? { displayName: guestName } : undefined,
      height: "min(80vh, 720px)",
    });
    listen(widget);
  }
  const guest = document.getElementById("guest");
  if (signedIn) start();
  else if (guest) guest.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = new FormData(guest).get("name").trim();
    if (!name) return;
    guest.remove();
    start(name);
  });
  function listen(widget) {
  widget.on("ready", (e) => { status.textContent = "Joining as " + e.participant.name; });
  widget.on("waiting", (e) => { status.textContent = e.reason === "waiting_room" ? "Waiting to be let in…" : "Waiting for the host…"; });
  widget.on("joined", () => { status.textContent = "You are in the meeting."; });
  widget.on("left", () => { status.textContent = "You left the meeting."; });
  widget.on("meeting-ended", () => { status.textContent = "The meeting has ended."; });
  widget.on("permission-denied", (e) => { status.textContent = "Allow your " + e.device + " in the browser to be seen and heard."; });
  widget.on("error", (e) => { status.textContent = e.message || "Could not open the meeting."; });
  // The meeting shows "Your Prayer Time" itself; this mirrors it on the page.
  widget.on("prayer-time", (e) => reports.liveTimer(e));
  widget.on("left", () => reports.refresh());
  }
</script>
</body></html>`);
}

createServer(async (req, res) => {
  const url = new URL(req.url || "/", SITE_ORIGIN);
  const zone = /^\/zone\/([^/]+)\/?$/.exec(url.pathname)?.[1];
  if (req.method === "GET" && zone && ZONE_RE.test(decodeURIComponent(zone))) return zonePage(req, res, decodeURIComponent(zone));
  if (req.method === "POST" && url.pathname === "/api/prayer-meeting/session") return session(req, res, url);
  const view = /^\/api\/prayer-meeting\/reports\/([a-z]+)$/.exec(url.pathname)?.[1];
  if (req.method === "GET" && view) return reports(req, res, url, view);
  if (req.method === "GET" && url.pathname === "/prayer-reports.js") {
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
    return res.end(REPORTS_JS);
  }
  if (req.method === "GET" && url.pathname === "/demo-login") {
    // Demo only: pretend to sign in. Your site has its own login.
    const id = url.searchParams.get("id") || "pc_demo";
    const name = url.searchParams.get("name") || "Demo Visitor";
    res.writeHead(302, { "set-cookie": `demo_user=${encodeURIComponent(`${id}|${name}`)}; Path=/; HttpOnly; SameSite=Lax`, location: url.searchParams.get("next") || "/zone/FALF" });
    return res.end();
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("Not found");
}).listen(PORT, () => console.log(`PrayerClouds sample on ${SITE_ORIGIN} (try /demo-login?name=Grace then /zone/FALF)`));
