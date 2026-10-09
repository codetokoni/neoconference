// Run: npx tsx src/lib/__tests__/rosterAdd.smoke.ts
//
// The roster editor's "Add person" and "Add column", driven through the real
// POST /api/video/room/roster/participant (and its admin check) with KV and
// Clerk stood in for (./apiV1-stubs), and the Excel download that has to
// carry a column added after the upload.

import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import "./apiV1-stubs/install";

process.env.ADMIN_EMAILS = "admin@example.com";
process.env.VIDEO_ROOM_ADMIN_EMAILS = "admin@example.com";

type Stubbed = typeof globalThis & {
  __users: Record<string, { plan?: string; emails?: string[] }>;
  __who?: string;
};
const g = globalThis as Stubbed;
g.__users = {
  user_admin: { emails: ["admin@example.com"] },
  user_staff: { emails: ["someone@example.com"] },
};

let n = 0;
const t = async (name: string, fn: () => Promise<void>) => {
  await fn();
  n++;
  console.log("  ok  " + name);
};

async function main() {
  const route = await import("../../app/api/video/room/roster/participant/route");
  const codes = await import("../participantCodes");
  const { buildRosterXlsxFromTemplate } = await import("../roster");

  async function add(room: string, body: unknown) {
    const res = await route.POST(
      new Request(`https://www.neoconference.app/api/video/room/roster/participant?room=${room}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    return { status: res.status, body: await res.json() };
  }
  const slots = async (room: string) => (await codes.listCodes(room)).map((c) => `${c.slot}:${c.name}`);

  console.log("roster: add person");
  g.__who = "user_admin";
  await t("an empty room: the first person gets slot 1 and a 6-digit code; fields lowercased, blanks dropped", async () => {
    const r = await add("men", { name: "  Grace Okafor ", meta: { Country: "Nigeria", CENTER: "MC Abuja", Region: "" } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const p = r.body.participant;
    assert.equal(p.slot, 1);
    assert.equal(p.name, "Grace Okafor");
    assert.match(p.code, /^\d{6}$/);
    assert.equal(p.streamId, "men-p01");
    assert.deepEqual(p.meta, { country: "Nigeria", center: "MC Abuja" });
    const second = await add("men", { name: "Tunde" });
    assert.equal(second.body.participant.slot, 2);
    assert.notEqual(second.body.participant.code, p.code);
    assert.deepEqual(await slots("men"), ["1:Grace Okafor", "2:Tunde"]);
  });

  await t("a room of unused 'Child N' slots: the next one is taken over, its code kept, no new slot", async () => {
    await codes.mintCodes("kids", 3);
    await codes.updateParticipant("kids", 1, { name: "Ada" });
    const before = (await codes.listCodes("kids")).find((c) => c.slot === 2)!;
    const r = await add("kids", { name: "Bola" });
    assert.equal(r.body.participant.slot, 2);
    assert.equal(r.body.participant.code, before.code, "the unused code is reused");
    assert.deepEqual(await slots("kids"), ["1:Ada", "2:Bola", "3:Child 3"]);
  });

  await t("after a delete, the gap stays a gap: no empty 'Child N' tile comes back", async () => {
    for (const name of ["A", "B", "C"]) await add("gap", { name });
    await codes.deleteParticipant("gap", 2);
    const r = await add("gap", { name: "D" });
    assert.equal(r.body.participant.slot, 4);
    assert.deepEqual(await slots("gap"), ["1:A", "3:C", "4:D"]);
  });

  await t("no name: 400; not a video-room admin: 403, and nothing is added", async () => {
    assert.equal((await add("men", { name: "   " })).status, 400);
    g.__who = "user_staff";
    assert.equal((await add("men", { name: "Intruder" })).status, 403);
    g.__who = "user_admin";
    assert.deepEqual(await slots("men"), ["1:Grace Okafor", "2:Tunde"]);
  });

  console.log("roster: a column added after the upload reaches the download");
  await t("the Excel gets a header for the new column, values on each row, PASSCODE after it", async () => {
    const sheet = XLSX.utils.aoa_to_sheet([
      ["S/N", "NAME", "COUNTRY"],
      [1, "Grace Okafor", "Nigeria"],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, "Sheet1");
    const template = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

    const out = buildRosterXlsxFromTemplate(template, [
      { code: "111111", slot: 1, name: "Grace Okafor", streamId: "x-p01", meta: { country: "Nigeria", region: "Africa" } },
      { code: "222222", slot: 2, name: "Tunde", streamId: "x-p02", meta: { region: "Lagos" } },
    ]);
    assert.ok(out, "overlay built");
    const back = XLSX.read(out!, { type: "buffer" });
    const rows = XLSX.utils.sheet_to_json<string[]>(back.Sheets[back.SheetNames[0]], { header: 1, defval: "" });
    assert.deepEqual(rows[0], ["S/N", "NAME", "COUNTRY", "REGION", "PASSCODE"]);
    assert.deepEqual(rows[1], [1, "Grace Okafor", "Nigeria", "Africa", "111111"]);
    assert.deepEqual(rows[2], [2, "Tunde", "", "Lagos", "222222"]);
  });

  console.log(`\n${n} checks passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
