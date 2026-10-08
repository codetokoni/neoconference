// Run: npx tsx src/lib/__tests__/translationLanguages.smoke.ts
// (needs `npm ci --prefix translation-worker` once, for the worker's SSE server)
//
// The AMS player (/video/join, /video/dashboard) offers every DeepL language
// the translation worker can caption into. The worker builds on its own in
// Docker, so it keeps its own copy of the language list; these checks keep
// the two agreeing, and drive the worker's real SSE server to show it
// refuses languages it can't produce and knows which ones are being heard.

import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { TRANSLATION_LANGUAGES } from "../translationLanguages";
import { channelsForRoom, machineChannelsForRoom, splitMachineChannels } from "../simulcast";
import {
  TRANSLATION_LANGUAGES as WORKER_LANGUAGES,
  deeplTarget as workerTarget,
} from "../../../translation-worker/src/languages";
// The worker's SSE server is loaded at run time, not imported: its module
// needs `cors`, which only the worker's own package installs, and the site's
// production build type-checks this file. A static import here failed every
// Vercel build from #474 to #477 ("Cannot find module 'cors'").
type WorkerSse = {
  acceptLangs: (fn: (lang: string) => boolean) => void;
  listenedLangs: (room: string) => string[];
  startSseServer: (port: number) => void;
};
const WORKER_SSE = "../../../translation-worker/src/sse";

let n = 0;
const t = async (name: string, fn: () => void | Promise<void>) => {
  await fn();
  n++;
  console.log("  ok  " + name);
};

async function main() {
  console.log("translation languages");

  await t("the worker translates into every language the web list has, but English", () => {
    const web = TRANSLATION_LANGUAGES.filter((l) => l.code !== "en").map((l) => l.code).sort();
    const worker = WORKER_LANGUAGES.map((l) => l.code).sort();
    assert.deepEqual(worker, web);
  });

  await t("…to the same DeepL targets, but Portuguese, which the booth has always had Brazilian", () => {
    for (const l of TRANSLATION_LANGUAGES) {
      if (l.code === "en") continue;
      assert.equal(workerTarget(l.code), l.code === "pt" ? "PT-BR" : l.deepl, l.code);
    }
  });

  await t("every language the player offers, booth or machine, is one the worker produces", () => {
    const offered = [
      ...channelsForRoom("neoconf").filter((c) => !c.video),
      ...machineChannelsForRoom("neoconf"),
    ];
    for (const c of offered) assert.ok(workerTarget(c.lang), c.lang);
    assert.ok(offered.length > 100, `only ${offered.length} languages`);
  });

  await t("More languages repeats no booth and not English, and its ids are not AMS streams", () => {
    const booths = channelsForRoom("neoconf");
    const more = machineChannelsForRoom("neoconf");
    const boothLangs = new Set(booths.map((c) => c.lang));
    for (const c of more) {
      assert.ok(!boothLangs.has(c.lang), c.lang);
      assert.notEqual(c.lang, "en");
      assert.notEqual(c.lang, "pt-br", "Português is the booth");
      assert.ok(c.machine);
      assert.match(c.id, /^neoconf-t-/);
      assert.ok(c.code.length <= 4, `${c.code} is cut to four in chat`);
    }
    assert.equal(new Set(more.map((c) => c.id)).size, more.length);
    // Alphabetical by the English name, which leads the label.
    const english = more.map((c) => c.label.split(" · ")[0]);
    assert.deepEqual(english, [...english].sort((a, b) => a.localeCompare(b)));
    assert.ok(more.some((c) => c.label === "Swahili · Kiswahili"));
  });

  await t("ten languages get buttons, Hausa and Igbo among them; the rest stay in the list", () => {
    const more = machineChannelsForRoom("neoconf");
    const { top, rest } = splitMachineChannels(more);
    assert.deepEqual(
      top.map((c) => c.lang),
      ["de", "it", "ha", "ja", "ko", "zh", "hi", "ru", "tr", "ig"],
    );
    // Every language exactly once, buttons or list.
    assert.equal(top.length + rest.length, more.length);
    const topIds = new Set(top.map((c) => c.id));
    assert.ok(rest.every((c) => !topIds.has(c.id)));
    const english = rest.map((c) => c.label.split(" · ")[0]);
    assert.deepEqual(english, [...english].sort((a, b) => a.localeCompare(b)));
    for (const l of ["sw", "nl", "pl"]) assert.ok(rest.some((c) => c.lang === l), `${l} is in the list`);
  });

  await t("the worker's SSE server refuses a language it can't produce and tracks who hears what", async () => {
    const { acceptLangs, listenedLangs, startSseServer }: WorkerSse = await import(WORKER_SSE);
    acceptLangs((lang) => lang === "en" || workerTarget(lang) !== null);
    const server = await listen(startSseServer);
    const port = (server.address() as AddressInfo).port;
    try {
      // A language nobody translates into: 404 before any stream opens.
      const bad = await get(port, "/translations/r1/xx");
      assert.equal(bad.status, 404);
      bad.res.destroy();
      assert.deepEqual(listenedLangs("r1"), []);

      const de = await get(port, "/translations/r1/de");
      const ha = await get(port, "/translations/r1/HA");
      const other = await get(port, "/translations/r2/fr");
      assert.equal(de.status, 200);
      assert.equal(ha.status, 200);
      assert.deepEqual(listenedLangs("r1").sort(), ["de", "ha"]);
      assert.deepEqual(listenedLangs("r2"), ["fr"]);

      de.res.destroy();
      await until(() => listenedLangs("r1").length === 1);
      assert.deepEqual(listenedLangs("r1"), ["ha"]);
      ha.res.destroy();
      other.res.destroy();
      await until(() => listenedLangs("r1").length === 0 && listenedLangs("r2").length === 0);
    } finally {
      server.close();
    }
  });

  console.log(`\n${n} checks passed`);
  process.exit(0);
}

/** startSseServer on a free port. It keeps no handle, so find it by listening. */
function listen(startSseServer: (port: number) => void): Promise<http.Server> {
  return new Promise((resolve) => {
    const realListen = http.Server.prototype.listen;
    http.Server.prototype.listen = function (this: http.Server, ...args: unknown[]) {
      http.Server.prototype.listen = realListen;
      const cb = args.find((a) => typeof a === "function") as (() => void) | undefined;
      return realListen.call(this, 0, () => {
        cb?.();
        resolve(this);
      });
    } as typeof realListen;
    startSseServer(0);
  });
}

function get(port: number, path: string): Promise<{ status: number; res: http.IncomingMessage }> {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path }, (res) => resolve({ status: res.statusCode ?? 0, res })).on(
      "error",
      reject,
    );
  });
}

async function until(ok: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
