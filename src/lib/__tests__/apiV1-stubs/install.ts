// Stand-ins for what a route reaches outside the app — KV, R2, the LiveKit
// server and Clerk — installed with module.registerHooks. Import this file
// before any app module; everything else runs as written. Each stub
// re-exports the real module ("real:<name>") and overrides only what the
// tests reach. Used by apiV1.smoke.ts and rosterAdd.smoke.ts.

import nodeModule from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

type Resolved = { url: string; format?: string | null; shortCircuit?: boolean };
type Ctx = { parentURL?: string };
const registerHooks = (nodeModule as unknown as {
  registerHooks?: (h: { resolve: (s: string, c: Ctx, next: (s: string, c?: Ctx) => Resolved) => Resolved }) => void;
}).registerHooks;
if (!registerHooks) throw new Error("these smoke tests need Node 22.15+ (module.registerHooks)");

const LIB = pathToFileURL(path.resolve(__dirname, "..", "..") + path.sep).href;
const STUBS = pathToFileURL(__dirname + path.sep).href;
const stub = (name: string): Resolved => ({ url: STUBS + name, shortCircuit: true, format: "module" });
const fromStub = (ctx: Ctx) => (ctx.parentURL || "").startsWith(STUBS);

registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "real:livekit") return next("livekit-server-sdk", ctx);
    if (spec === "real:clerk") return next("@clerk/nextjs/server", ctx);
    if (spec === "real:r2") return next(LIB + "r2.ts", ctx);
    if (!fromStub(ctx)) {
      if (spec === "livekit-server-sdk") return stub("livekit.mjs");
      if (spec === "@clerk/nextjs/server") return stub("clerk.mjs");
    }
    const r = next(spec, ctx);
    if (!fromStub(ctx) && r.url.endsWith("/src/lib/kv.ts")) return stub("kv.mjs");
    if (!fromStub(ctx) && r.url.endsWith("/src/lib/r2.ts")) return stub("r2.mjs");
    return r;
  },
});

// No real KV: stores with an in-memory fallback use it; the rest get kv.mjs.
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;
