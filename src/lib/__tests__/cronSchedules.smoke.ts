// src/lib/__tests__/cronSchedules.smoke.ts
//
// vercel.json schedules the crons; the Jobs page (src/lib/ops/jobRegistry.ts)
// only describes them. Each schedule is written in both places, plus once in
// words. Moving partner-totals from 01:20 to 06:20 UTC (#631) meant changing
// all three by hand, and nothing would have noticed if one was missed: the
// page would show the wrong time while Vercel ran the other one.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

let n = 0;
const t = async (name: string, fn: () => Promise<void> | void) => {
  await fn();
  n++;
  console.log("  ok  " + name);
};

/** The words the Jobs page should show for a cron expression we use. */
function inWords(expr: string): string | null {
  const every = expr.match(/^\*\/(\d+) \* \* \* \*$/);
  if (every) return `Every ${every[1]} minutes`;
  const daily = expr.match(/^(\d{1,2}) (\d{1,2}) \* \* \*$/);
  if (daily) return `Daily at ${daily[2].padStart(2, "0")}:${daily[1].padStart(2, "0")} UTC`;
  return null;
}

async function main() {
  const root = process.cwd();
  const crons = (JSON.parse(readFileSync(join(root, "vercel.json"), "utf8")).crons ?? []) as { path: string; schedule: string }[];
  const { JOBS } = await import("../ops/jobRegistry");
  const routeJobs = JOBS.filter((j) => j.route);

  await t("every cron in vercel.json is on the Jobs page, at the same schedule", () => {
    assert.ok(crons.length > 0, "vercel.json has crons");
    for (const c of crons) {
      const job = routeJobs.find((j) => j.route === c.path);
      assert.ok(job, `${c.path} runs on Vercel but is not on the Jobs page`);
      assert.equal(job.schedule, c.schedule, `${job.name}: the Jobs page says ${job.schedule}, Vercel runs ${c.schedule}`);
    }
  });

  await t("every scheduled job on the Jobs page is scheduled in vercel.json", () => {
    for (const job of routeJobs) {
      if (job.schedule === null) continue;
      const c = crons.find((x) => x.path === job.route);
      assert.ok(c, `${job.name} (${job.route}) is listed with ${job.schedule} but vercel.json never runs it`);
    }
  });

  await t("the time in words matches the expression", () => {
    for (const job of JOBS) {
      if (job.schedule === null) continue;
      const words = inWords(job.schedule);
      assert.ok(words, `${job.name}: no wording rule for "${job.schedule}"; add one to inWords`);
      assert.equal(job.scheduleText, words, `${job.name}: "${job.scheduleText}" for ${job.schedule}`);
    }
  });

  await t("every cron path has a route", () => {
    for (const c of crons) {
      const file = join(root, "src", "app", ...c.path.split("/").filter(Boolean), "route.ts");
      assert.ok(existsSync(file), `${c.path}: no ${file}`);
    }
  });

  await t("the checks catch a mismatch (calibration)", () => {
    assert.equal(inWords("20 6 * * *"), "Daily at 06:20 UTC");
    assert.equal(inWords("0 14 * * *"), "Daily at 14:00 UTC");
    assert.equal(inWords("*/5 * * * *"), "Every 5 minutes");
    assert.notEqual(inWords("20 1 * * *"), "Daily at 06:20 UTC", "the old partner-totals time must not pass as the new one");
  });

  console.log(`cronSchedules: ${n} passed`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
