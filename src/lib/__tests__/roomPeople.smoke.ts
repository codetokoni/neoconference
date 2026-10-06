// Who can be added to a group from its meeting's room.
// Run: npx tsx src/lib/__tests__/roomPeople.smoke.ts

import assert from "node:assert/strict";
import { notInGroup, userIdOfIdentity } from "@/lib/roomPeople";

let n = 0;
const t = (name: string, fn: () => void) => { fn(); n++; console.log("  ok  " + name); };

t("the user id is the identity before its nonce", () => {
  assert.equal(userIdOfIdentity("user_abc#k3j9"), "user_abc");
  assert.equal(userIdOfIdentity("user_abc"), "user_abc");
  assert.equal(userIdOfIdentity(undefined), "");
});

t("only people with an account who are not members, never yourself, each once", () => {
  const here = [
    { userId: "user_member", name: "Kemi" },
    { userId: "user_new", name: "Zed" },
    { userId: "user_new", name: "Zed" }, // the same person on a second device
    { userId: "guest-4f2a", name: "Visitor" },
    { userId: "user_me", name: "Ada" },
  ];
  assert.deepEqual(notInGroup(here, new Set(["user_member", "user_me"]), "user_me"), [{ userId: "user_new", name: "Zed" }]);
});

console.log(`\n${n} checks passed`);
