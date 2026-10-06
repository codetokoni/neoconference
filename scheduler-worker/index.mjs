// scheduler-worker/index.mjs
//
// Ticks the NeoConference scheduler: every 30 s (±3 s) it POSTs
// DISPATCH_URL with "Authorization: Bearer DISPATCH_SECRET", which runs the
// reminders and rings that are due (src/app/api/internal/dispatch).
//
// No dependencies: Node 20's fetch. One log line per tick. After failures it
// waits longer each time, up to 5 minutes, and goes back to 30 s on the first
// success. Exits cleanly on SIGTERM / SIGINT (docker stop).

const URL_ = process.env.DISPATCH_URL || "";
const SECRET = process.env.DISPATCH_SECRET || "";
const EVERY_MS = 30_000;
const JITTER_MS = 3_000;
const TIMEOUT_MS = 20_000;
const MAX_BACKOFF_MS = 5 * 60_000;

if (!URL_ || !SECRET) {
  console.error("[scheduler] DISPATCH_URL and DISPATCH_SECRET must both be set in scheduler-worker/.env");
  process.exit(1);
}

let stopping = false;
let failures = 0;
let timer = null;
let wake = null;

function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[scheduler] ${signal}: stopping`);
  if (timer) clearTimeout(timer);
  if (wake) wake();
}
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));

function sleep(ms) {
  return new Promise((resolve) => {
    wake = resolve;
    timer = setTimeout(resolve, ms);
  });
}

async function tick() {
  const started = Date.now();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(URL_, {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}` },
      signal: ctrl.signal,
    });
    const text = await res.text();
    const ms = Date.now() - started;
    if (!res.ok) {
      failures++;
      console.log(`[scheduler] ${new Date().toISOString()} HTTP ${res.status} ${ms}ms ${text.slice(0, 200)}`);
      return;
    }
    failures = 0;
    console.log(`[scheduler] ${new Date().toISOString()} ok ${ms}ms ${text.slice(0, 200)}`);
  } catch (err) {
    failures++;
    const why = err && err.name === "AbortError" ? `timeout after ${TIMEOUT_MS}ms` : String(err && err.message ? err.message : err);
    console.log(`[scheduler] ${new Date().toISOString()} failed: ${why}`);
  } finally {
    clearTimeout(t);
  }
}

function nextDelay() {
  const jitter = Math.round((Math.random() * 2 - 1) * JITTER_MS);
  if (failures === 0) return EVERY_MS + jitter;
  // 30 s, 60 s, 120 s, 240 s, then 5 min.
  return Math.min(EVERY_MS * 2 ** (failures - 1), MAX_BACKOFF_MS) + jitter;
}

console.log(`[scheduler] started; ticking ${URL_} every ${EVERY_MS / 1000}s`);
while (!stopping) {
  await tick();
  if (stopping) break;
  await sleep(nextDelay());
}
console.log("[scheduler] stopped");
process.exit(0);
