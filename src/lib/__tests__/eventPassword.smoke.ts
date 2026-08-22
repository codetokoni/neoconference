// Run: npx tsx src/lib/__tests__/eventPassword.smoke.ts
// Roundtrip smoke test for the FRS §12.2 password hash format.

import assert from "node:assert/strict";
import {
  hashMeetingPassword,
  verifyMeetingPassword,
  isMeetingPasswordHash,
} from "../eventPassword";

let n = 0;
const t = (name: string, fn: () => void) => { fn(); n++; console.log("  ok  " + name); };

console.log("meeting password hash");

t("hash returns the s1$ scheme prefix", () => {
  const stored = hashMeetingPassword("hunter2");
  assert.ok(stored, "expected a value");
  assert.ok(stored!.startsWith("s1$"));
  assert.ok(isMeetingPasswordHash(stored!));
});

t("hash then verify roundtrips", () => {
  const stored = hashMeetingPassword("a-decent-secret");
  assert.ok(stored);
  assert.equal(verifyMeetingPassword("a-decent-secret", stored!), true);
  assert.equal(verifyMeetingPassword("a-different-secret", stored!), false);
});

t("empty input clears the field (returns undefined)", () => {
  assert.equal(hashMeetingPassword(""), undefined);
});

t("verify returns false for missing input or stored", () => {
  assert.equal(verifyMeetingPassword("", "s1$abc$def"), false);
  assert.equal(verifyMeetingPassword("hi", undefined), false);
  assert.equal(verifyMeetingPassword("hi", null), false);
});

t("legacy plaintext row still verifies (silent migration)", () => {
  // Pre-hash rows stored the plaintext directly. verifyMeetingPassword must
  // accept them so a room with an old password keeps working until the
  // next PATCH re-keys it.
  assert.equal(verifyMeetingPassword("legacy", "legacy"), true);
  assert.equal(verifyMeetingPassword("wrong", "legacy"), false);
});

t("different calls to hash the same plaintext produce different rows (salt)", () => {
  const a = hashMeetingPassword("same-input");
  const b = hashMeetingPassword("same-input");
  assert.notEqual(a, b);
  assert.equal(verifyMeetingPassword("same-input", a!), true);
  assert.equal(verifyMeetingPassword("same-input", b!), true);
});

t("isMeetingPasswordHash rejects legacy plaintext", () => {
  assert.equal(isMeetingPasswordHash("legacy-plain"), false);
  assert.equal(isMeetingPasswordHash(""), false);
  assert.equal(isMeetingPasswordHash(null), false);
  assert.equal(isMeetingPasswordHash(undefined), false);
});

t("malformed s1$ row does not verify anything", () => {
  assert.equal(verifyMeetingPassword("hi", "s1$"), false);
  assert.equal(verifyMeetingPassword("hi", "s1$onlySalt"), false);
  assert.equal(verifyMeetingPassword("hi", "s1$salt$nonhex"), false);
});

console.log(`\n${n} checks passed`);
