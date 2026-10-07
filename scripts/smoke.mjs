// scripts/smoke.mjs
//
// Runs every src/lib/__tests__/*.smoke.ts, one process each, and exits
// non-zero if any fails. `npm run test:smoke`; CI runs it on every PR
// (.github/workflows/lib-smoke.yml).
//
// One process per file because each smoke file is a script: it deletes the
// KV env vars to fall back to in-memory stores and throws on the first
// failed assert, so files must not share a module cache or stop each other.
// That throw is also why this runs them all rather than stopping at the
// first failure — permissions.smoke.ts once stopped at a stale assertion and
// the six checks after it went unrun from #272 to #450, unseen because
// nothing ran it.
//
// Pass file names (or parts of them) to run only those:
//   npm run test:smoke -- permissions groups

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const DIR = join("src", "lib", "__tests__");
// A smoke file that waits on a network it never gets should fail, by name,
// not hang the job until the workflow timeout.
const PER_FILE_TIMEOUT_MS = 120_000;

const filters = process.argv.slice(2);
const files = readdirSync(DIR)
  .filter((f) => f.endsWith(".smoke.ts"))
  .filter((f) => filters.length === 0 || filters.some((p) => f.includes(p)))
  .sort();

if (files.length === 0) {
  console.error(`No smoke files in ${DIR}${filters.length ? ` matching ${filters.join(", ")}` : ""}.`);
  process.exit(1);
}

const failed = [];
for (const f of files) {
  const file = join(DIR, f);
  const started = Date.now();
  const r = spawnSync(process.execPath, ["--import", "tsx", file], {
    encoding: "utf8",
    timeout: PER_FILE_TIMEOUT_MS,
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (r.status === 0) {
    console.log(`ok    ${f} (${secs}s)`);
    continue;
  }
  const why = r.error?.code === "ETIMEDOUT"
    ? `timed out after ${PER_FILE_TIMEOUT_MS / 1000}s`
    : r.error
      ? r.error.message
      : r.signal
        ? `killed by ${r.signal}`
        : `exit ${r.status}`;
  failed.push(f);
  console.log(`FAIL  ${f} (${secs}s, ${why})`);
  // Its own output says which check failed and why.
  for (const line of `${r.stdout ?? ""}${r.stderr ?? ""}`.trimEnd().split("\n")) {
    console.log(`      ${line}`);
  }
}

console.log(`\n${files.length - failed.length}/${files.length} smoke files passed.`);
if (failed.length) {
  console.log(`Failed: ${failed.join(", ")}`);
  process.exit(1);
}
