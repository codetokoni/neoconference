import { NextResponse } from "next/server";

/**
 * GET /api/health
 *
 * Lightweight health endpoint for uptime monitoring.
 * - Reports presence of required env vars per-service (does NOT call external APIs).
 * - Returns 200 when all required services are configured, 503 otherwise.
 *
 * Use externally with services like UptimeRobot, BetterStack, or Vercel monitoring.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

type CheckStatus = "ok" | "missing";

function has(name: string): CheckStatus {
    const v = process.env[name];
    return v && v.length > 0 ? "ok" : "missing";
}

function allOk(...statuses: CheckStatus[]): boolean {
    return statuses.every((s) => s === "ok");
}

export async function GET() {
    const services = {
          clerk: {
                  publishableKey: has("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"),
                  secretKey: has("CLERK_SECRET_KEY"),
          },
          livekit: {
                  url: has("NEXT_PUBLIC_LIVEKIT_URL"),
                  apiKey: has("LIVEKIT_API_KEY"),
                  apiSecret: has("LIVEKIT_API_SECRET"),
          },
          storage: {
                  accessKey: has("S3_ACCESS_KEY"),
                  secretKey: has("S3_SECRET_KEY"),
                  endpoint: has("S3_ENDPOINT"),
                  bucket: has("S3_BUCKET"),
                  region: has("S3_REGION"),
          },
          kv: {
                  restApiUrl: has("KV_REST_API_URL"),
                  restApiToken: has("KV_REST_API_TOKEN"),
          },
    };

  const optional = {
        kingschat: {
                clientId: has("KINGSCHAT_CLIENT_ID"),
                redirectUri: has("KINGSCHAT_REDIRECT_URI"),
                stateSecret: has("KINGSCHAT_STATE_SECRET"),
        },
        espees: {
                merchantWallet: has("ESPEES_MERCHANT_WALLET"),
        },
        bootstrap: {
                adminEmail: has("BOOTSTRAP_ADMIN_EMAIL"),
                businessEmail: has("BOOTSTRAP_BUSINESS_EMAIL"),
        },
  };

  const requiredOk = [
        allOk(services.clerk.publishableKey, services.clerk.secretKey),
        allOk(services.livekit.url, services.livekit.apiKey, services.livekit.apiSecret),
        allOk(
                services.storage.accessKey,
                services.storage.secretKey,
                services.storage.endpoint,
                services.storage.bucket,
                services.storage.region,
              ),
        allOk(services.kv.restApiUrl, services.kv.restApiToken),
      ].every(Boolean);

  const status = requiredOk ? "ok" : "degraded";
    const httpStatus = requiredOk ? 200 : 503;

  return NextResponse.json(
    {
            status,
            timestamp: new Date().toISOString(),
            uptimeSeconds: typeof process.uptime === "function" ? Math.round(process.uptime()) : null,
            services,
            optional,
    },
    { status: httpStatus },
      );
}
