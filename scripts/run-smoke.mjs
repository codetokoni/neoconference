// Runs every server smoke test (src/lib/__tests__/*.smoke.ts), each in its
// own process as `npx tsx <file>` would, and fails if any of them does.
//
//   npm run test:smoke                 all of them
//   npm run test:smoke -- ringing fcm  only files whose name contains one
//
// Each file is a script that throws on its first failed check. They ran only
// by hand until CI picked them up here; permissions.smoke.ts stayed red for
// three weeks that way.
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const dir = join("src", "lib", "__tests__");
const only = process.argv.slice(2);
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".smoke.ts"))
  .filter((f) => only.length === 0 || only.some((o) => f.includes(o)))
  .sort();

if (files.length === 0) {
  console.error(`No smoke tests in ${dir}${only.length ? ` matching ${only.join(", ")}` : ""}.`);
  process.exit(1);
}

/** One file, with its output kept to show only if it fails. */
function run(file) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, ["--import", "tsx", join(dir, file)], {
      env: { ...process.env, NODE_ENV: "test" },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => {
      out += "\n[run-smoke] timed out after 5 min";
      child.kill("SIGKILL");
    }, 5 * 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ file, ok: code === 0, ms: Date.now() - started, out });
    });
  });
}

const failed = [];
for (const file of files) {
  const r = await run(file);
  const passed = r.out.match(/(\d+) checks passed/)?.[1];
  console.log(`${r.ok ? "pass" : "FAIL"}  ${file}  ${(r.ms / 1000).toFixed(1)}s${passed ? `  (${passed} checks)` : ""}`);
  if (!r.ok) failed.push(r);
}

for (const r of failed) {
  console.log(`\n----- ${r.file} -----\n${r.out.trim()}`);
}
console.log(`\n${files.length - failed.length} of ${files.length} smoke test files passed`);
process.exit(failed.length ? 1 : 0);
