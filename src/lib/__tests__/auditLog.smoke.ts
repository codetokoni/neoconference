// Run: npx tsx src/lib/__tests__/auditLog.smoke.ts
// Roundtrip smoke test for the FRS §12.4 persistent audit sink.
// Uses the in-memory fallback so no KV is required.

import assert from "node:assert/strict";
import {
  appendAuditEntry,
  listRecentAuditEntries,
  __resetInMemoryAuditLog,
} from "../auditLog";

let n = 0;
const t = async (name: string, fn: () => Promise<void>) => {
  await fn();
  n++;
  console.log("  ok  " + name);
};

async function main() {
  console.log("audit log");

  await t("empty log returns []", async () => {
    __resetInMemoryAuditLog();
    const entries = await listRecentAuditEntries();
    assert.deepEqual(entries, []);
  });

  await t("append then list roundtrips a single entry", async () => {
    __resetInMemoryAuditLog();
    await appendAuditEntry({
      ts: Date.now(),
      permission: "recording:start",
      allowed: true,
      userId: "u_x",
      role: "host",
      reason: "assignment",
      eventId: "ev_1",
    });
    const entries = await listRecentAuditEntries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].permission, "recording:start");
    assert.equal(entries[0].userId, "u_x");
  });

  await t("newest first: last append lands at index 0", async () => {
    __resetInMemoryAuditLog();
    await appendAuditEntry({
      ts: 1_000_000,
      permission: "meeting:end",
      allowed: false,
      userId: "u_y",
      role: "participant",
      reason: "default",
    });
    await appendAuditEntry({
      ts: 2_000_000,
      permission: "role:grant",
      allowed: true,
      userId: "u_z",
      role: "host",
      reason: "assignment",
    });
    const entries = await listRecentAuditEntries();
    assert.equal(entries.length, 2);
    assert.equal(entries[0].permission, "role:grant");
    assert.equal(entries[1].permission, "meeting:end");
  });

  await t("limit truncates newest-first slice", async () => {
    __resetInMemoryAuditLog();
    for (let i = 0; i < 20; i++) {
      await appendAuditEntry({
        ts: 1_000_000 + i,
        permission: "captions:dispatch",
        allowed: true,
        userId: "u_" + i,
        role: "host",
        reason: "assignment",
      });
    }
    const three = await listRecentAuditEntries(3);
    assert.equal(three.length, 3);
    assert.equal(three[0].userId, "u_19");
    assert.equal(three[1].userId, "u_18");
    assert.equal(three[2].userId, "u_17");
  });

  await t("missing ts gets defaulted to Date.now() on append", async () => {
    __resetInMemoryAuditLog();
    // ts:0 counts as missing in the enrichment path.
    await appendAuditEntry({
      ts: 0,
      permission: "participant:kick",
      allowed: false,
      userId: "u_v",
      role: "moderator",
      reason: "assignment",
    });
    const entries = await listRecentAuditEntries();
    assert.equal(entries.length, 1);
    assert.ok(entries[0].ts > 0, "ts should have been defaulted");
  });

  console.log(`\n${n} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
