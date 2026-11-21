// Run: npx tsx src/lib/__tests__/openFiles.smoke.ts
//
// The nightly backup failed on half its nights from 13 Nov 2026 with
// "uv_os_homedir returned EMFILE (too many open files)" and nothing to say
// where. src/lib/ops/openFiles.ts: a step that fails says which step and
// what was open; running out of files is retried once, nothing else is;
// the R2 client is one per process, not a new one (and its connection pool)
// per call.

import assert from "node:assert/strict";
import { isTooManyOpenFiles, openFilesText, retryOnTooManyOpenFiles, step, TOO_MANY_OPEN_FILES_WAITS_MS } from "../ops/openFiles";

let n = 0;
const t = async (name: string, fn: () => Promise<void> | void) => {
  await fn();
  n++;
  console.log("  ok  " + name);
};

const emfile = () => Object.assign(new Error("A system error occurred: uv_os_homedir returned EMFILE (too many open files)"), { code: "ERR_SYSTEM_ERROR" });

(async () => {
  await t("running out of file slots is recognised, by message or by code", () => {
    assert.equal(isTooManyOpenFiles(emfile()), true);
    assert.equal(isTooManyOpenFiles(Object.assign(new Error("open failed"), { code: "EMFILE" })), true);
    assert.equal(isTooManyOpenFiles(new Error("R2 unavailable")), false);
  });

  await t("it is retried once, after a pause; other failures are not retried", async () => {
    let calls = 0;
    assert.equal(await retryOnTooManyOpenFiles(async () => (++calls === 1 ? Promise.reject(emfile()) : "stored"), 5), "stored");
    assert.equal(calls, 2);
    calls = 0;
    await assert.rejects(retryOnTooManyOpenFiles(async () => { calls++; throw new Error("R2 unavailable"); }, 5), /R2 unavailable/);
    assert.equal(calls, 1);
    calls = 0;
    await assert.rejects(retryOnTooManyOpenFiles(async () => { calls++; throw emfile(); }, 5), /EMFILE/);
    assert.equal(calls, 2, "once more, not forever");
  });

  await t("a failed step names itself and says what was open", async () => {
    await assert.rejects(step("writing it to R2", async () => { throw emfile(); }), (e: Error) => {
      assert.match(e.message, /^writing it to R2: A system error occurred: uv_os_homedir returned EMFILE/);
      assert.ok(e.message.endsWith(`(${openFilesText()})`));
      return true;
    });
    assert.equal(await step("reading", async () => 7), 7);
  });

  await t("what is open reads as numbers on Linux, and says unknown elsewhere", () => {
    assert.match(openFilesText(), process.platform === "linux" ? /^\d+ open, \d+ sockets$/ : /^open files unknown$/);
  });

  await t("the R2 client is made once and reused; changed settings make a new one", async () => {
    Object.assign(process.env, { S3_ENDPOINT: "https://r2.test", S3_BUCKET: "b", S3_ACCESS_KEY: "ak", S3_SECRET_KEY: "sk" });
    const { r2Client } = await import("../r2");
    const a = r2Client();
    assert.equal(r2Client(), a);
    process.env.S3_ACCESS_KEY = "ak2";
    assert.notEqual(r2Client(), a);
  });

  await t("by default it waits 3, 10 and 30 s and tries again after each, then gives up", async () => {
    assert.deepEqual(TOO_MANY_OPEN_FILES_WAITS_MS, [3000, 10_000, 30_000]);
    let calls = 0;
    const waits = [1, 1, 1];
    assert.equal(await retryOnTooManyOpenFiles(async () => (++calls <= 3 ? Promise.reject(emfile()) : "stored"), waits), "stored");
    assert.equal(calls, 4);
    calls = 0;
    await assert.rejects(retryOnTooManyOpenFiles(async () => { calls++; throw emfile(); }, waits), /EMFILE/);
    assert.equal(calls, 4, "three retries, not forever");
  });

  await t("R2's library finds a home directory without asking the system (no file slot needed)", async () => {
    const { ensureHome } = await import("../r2");
    const { tmpdir } = await import("node:os");
    const before = process.env.HOME;
    delete process.env.HOME;
    ensureHome();
    assert.equal(process.env.HOME, tmpdir(), "unset: a temporary folder");
    process.env.HOME = "/home/someone";
    ensureHome();
    assert.equal(process.env.HOME, "/home/someone", "set: left alone");
    if (before === undefined) delete process.env.HOME;
    else process.env.HOME = before;
  });

  console.log(`\n${n} checks passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
