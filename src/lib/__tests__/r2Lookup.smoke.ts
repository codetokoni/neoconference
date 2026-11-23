// Run: npx tsx src/lib/__tests__/r2Lookup.smoke.ts
//
// The nightly backup on 22 and 23 Nov 2026 read the whole store, then failed
// to write it: "writing it to R2: getaddrinfo EBUSY …r2.cloudflarestorage.com".
// By then the process was short of file slots, and a name lookup needs some.
// R2's client now remembers the address it looked up when the backup
// connected first (src/lib/r2.ts cachedLookup), and that failure is retried
// like running out of files (src/lib/ops/openFiles.ts).
//
// Driven through the real AWS client against a real HTTPS server on this
// machine standing in for R2 (a self-signed certificate made for these
// tests only: fixtures/r2-test-only.*).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
process.removeAllListeners("warning");

let n = 0;
const t = async (name: string, fn: () => Promise<void> | void) => {
  await fn();
  n++;
  console.log("  ok  " + name);
};

type Addr = { address: string; family: number };
const ebusy = (host: string) => Object.assign(new Error(`getaddrinfo EBUSY ${host}`), { code: "EBUSY", syscall: "getaddrinfo", hostname: host });

(async () => {
  const R2 = await import("../r2");
  const { isTooManyOpenFiles, retryOnTooManyOpenFiles } = await import("../ops/openFiles");

  console.log("remembering R2's address");

  await t("looked up once, then reused; looked up again after 10 minutes", async () => {
    let calls = 0;
    let clock = 0;
    const lookup = R2.cachedLookup((h, _o, cb) => { calls++; cb(null, [{ address: "10.0.0." + calls, family: 4 }]); }, () => clock);
    const ask = (all: boolean) => new Promise<unknown>((res, rej) => lookup("r2.example", { all }, (err, a, f) => (err ? rej(err) : res(all ? a : { a, f }))));
    assert.deepEqual(await ask(false), { a: "10.0.0.1", f: 4 });
    assert.deepEqual(await ask(true), [{ address: "10.0.0.1", family: 4 }]);
    assert.equal(calls, 1);
    clock = 10 * 60_000;
    assert.deepEqual(await ask(false), { a: "10.0.0.2", f: 4 }, "stale: looked up again");
    assert.equal(calls, 2);
  });

  await t("a lookup that fails uses the last address; with none, the failure is passed on", async () => {
    let clock = 0;
    let fail = false;
    const lookup = R2.cachedLookup((h, _o, cb) => (fail ? cb(ebusy(h), []) : cb(null, [{ address: "10.0.0.9", family: 4 }])), () => clock);
    const ask = (host: string) => new Promise<string>((res, rej) => lookup(host, {}, (err, a) => (err ? rej(err) : res(a as string))));
    assert.equal(await ask("r2.example"), "10.0.0.9");
    fail = true;
    clock = 60 * 60_000;
    assert.equal(await ask("r2.example"), "10.0.0.9", "the last answer, not a failure");
    await assert.rejects(ask("other.example"), /EBUSY/);
  });

  console.log("the real R2 client, against a stand-in R2 over HTTPS");

  const fixtures = join(__dirname, "fixtures");
  const puts: string[] = [];
  const server: Server = createServer({ key: readFileSync(join(fixtures, "r2-test-only.key")), cert: readFileSync(join(fixtures, "r2-test-only.crt")) }, (req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "PUT") puts.push(`${req.url} ${body.length}`);
      res.setHeader("content-type", "application/xml");
      res.end(req.method === "GET" ? '<?xml version="1.0"?><ListBucketResult><Name>b</Name><KeyCount>0</KeyCount></ListBucketResult>' : "");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  process.env.S3_ENDPOINT = `https://r2-test.invalid:${port}`;
  process.env.S3_BUCKET = "b";
  process.env.S3_ACCESS_KEY = "test-access";
  process.env.S3_SECRET_KEY = "test-secret";
  process.env.S3_REGION = "auto";

  try {
    await t("its connections go through the lookup it is given (here, one that always fails)", async () => {
      R2.__setR2Resolver((h, _o, cb) => cb(ebusy(h), []));
      await assert.rejects(R2.warmR2(), /EBUSY/);
    });

    await t("connected at the start, it writes later although lookups now fail (the 22 and 23 Nov backups)", async () => {
      const asked: string[] = [];
      let busy = false;
      R2.__setR2Resolver((h, _o, cb) => {
        asked.push(h);
        if (busy) return cb(ebusy(h), []);
        cb(null, [{ address: "127.0.0.1", family: 4 } as Addr]);
      });
      await R2.warmR2();
      assert.deepEqual(asked, ["r2-test.invalid"]);
      busy = true;
      server.closeAllConnections(); // the write needs a new connection, as two minutes later it does
      await R2.putObject("backups/snap_1.json.gz", Buffer.from("snapshot"), "application/gzip");
      assert.equal(puts.length, 1, "written");
      assert.match(puts[0], /^\/b\/backups\/snap_1\.json\.gz\?x-id=PutObject 8$/);
      assert.equal(asked.length, 1, "no lookup at write time");
    });
  } finally {
    R2.__setR2Resolver(undefined);
    server.close();
  }

  console.log("retrying");

  await t("a lookup that could not run for want of file slots is retried like running out of files", async () => {
    assert.equal(isTooManyOpenFiles(ebusy("x.r2.cloudflarestorage.com")), true);
    assert.equal(isTooManyOpenFiles(new Error("getaddrinfo EAI_AGAIN x.r2.cloudflarestorage.com")), true);
    assert.equal(isTooManyOpenFiles(Object.assign(new Error("open failed"), { code: "ENFILE" })), true);
    assert.equal(isTooManyOpenFiles(new Error("getaddrinfo ENOTFOUND x.example")), false, "a name that does not exist is not retried");
    assert.equal(isTooManyOpenFiles(new Error("resource busy or locked")), false);
    let calls = 0;
    assert.equal(await retryOnTooManyOpenFiles(async () => (++calls === 1 ? Promise.reject(ebusy("x")) : "stored"), [5]), "stored");
    assert.equal(calls, 2);
  });

  console.log(`\n${n} checks passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
