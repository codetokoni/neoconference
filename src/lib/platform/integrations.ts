// src/lib/platform/integrations.ts
//
// Every outside service the code talks to, and whether this deployment is
// configured for it — judged by which environment variables are present.
// Values never leave the server: the browser gets "set / not set" and a
// fingerprint (the first 8 hex characters of the value's SHA-256), which
// changes when a secret is rotated and says nothing about the secret.
//
// Secrets held in environment variables can only be rotated at the
// provider and then in Vercel (Project → Settings → Environment Variables)
// followed by a redeploy; ROTATION_STEPS says how for each.

import { createHash } from "crypto";

export interface IntegrationVar {
  name: string;
  /** Needed for the integration to work at all. */
  required: boolean;
  secret: boolean;
}

export interface Integration {
  id: string;
  name: string;
  purpose: string;
  vars: IntegrationVar[];
  /** Where its secrets are made and rotated. */
  console: string;
  /** Configured some other way when no variable is set (e.g. Vercel's own credentials). */
  implicit?: string;
}

const v = (name: string, required = true, secret = true): IntegrationVar => ({ name, required, secret });

export const INTEGRATIONS: Integration[] = [
  { id: "clerk", name: "Clerk", purpose: "Sign-in and accounts", vars: [v("CLERK_SECRET_KEY"), v("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", true, false)], console: "https://dashboard.clerk.com" },
  { id: "kv", name: "Upstash Redis (KV)", purpose: "All app data", vars: [v("KV_REST_API_URL", true, false), v("KV_REST_API_TOKEN")], console: "https://console.upstash.com" },
  { id: "livekit", name: "LiveKit", purpose: "Meetings (video, audio, recording egress)", vars: [v("NEXT_PUBLIC_LIVEKIT_URL", true, false), v("LIVEKIT_API_KEY"), v("LIVEKIT_API_SECRET"), v("CAPTIONS_AGENT_NAME", false, false)], console: "https://cloud.livekit.io" },
  { id: "ams", name: "Ant Media Server", purpose: "The video programme (broadcast rooms, translation audio)", vars: [v("AMS_REST_BASE", true, false), v("NEXT_PUBLIC_AMS_HTTP", false, false), v("NEXT_PUBLIC_AMS_WS", false, false), v("NEXT_PUBLIC_AMS_RTMP", false, false), v("NEXT_PUBLIC_AMS_SRT", false, false), v("NEXT_PUBLIC_AMS_WHIP_BASE", false, false)], console: "The AMS droplet's web panel" },
  { id: "r2", name: "Cloudflare R2", purpose: "Recordings, uploads and the platform logo", vars: [v("S3_ENDPOINT", true, false), v("S3_BUCKET", true, false), v("S3_ACCESS_KEY"), v("S3_SECRET_KEY"), v("S3_REGION", false, false)], console: "https://dash.cloudflare.com → R2 → Manage API tokens" },
  { id: "resend", name: "Resend", purpose: "Email", vars: [v("RESEND_API_KEY"), v("MAIL_FROM", false, false)], console: "https://resend.com/api-keys" },
  { id: "espees", name: "eSPees", purpose: "Plan payments", vars: [v("ESPEES_API_KEY"), v("ESPEES_MERCHANT_WALLET", true, false), v("ESPEES_PRODUCT_SKU", false, false)], console: "The eSPees merchant portal" },
  { id: "stripe", name: "Stripe", purpose: "Paid event tickets", vars: [v("STRIPE_SECRET_KEY"), v("STRIPE_WEBHOOK_SECRET")], console: "https://dashboard.stripe.com/apikeys" },
  { id: "deepgram", name: "Deepgram", purpose: "Recording transcripts and live translation speech", vars: [v("DEEPGRAM_API_KEY"), v("TRANSCRIBE_PROVIDER", false, false)], console: "https://console.deepgram.com" },
  { id: "assemblyai", name: "AssemblyAI", purpose: "Recording transcripts (alternative provider)", vars: [v("ASSEMBLYAI_API_KEY")], console: "https://www.assemblyai.com/app/account" },
  { id: "deepl", name: "DeepL", purpose: "Text translation", vars: [v("DEEPL_API_KEY")], console: "https://www.deepl.com/your-account/keys" },
  {
    id: "ai",
    name: "OpenAI / Vercel AI Gateway",
    purpose: "Meeting summaries and the assistant",
    vars: [v("AI_GATEWAY_API_KEY", false), v("OPENAI_API_KEY", false), v("OPENAI_SUMMARY_MODEL", false, false)],
    console: "https://vercel.com/dashboard → AI Gateway, or https://platform.openai.com/api-keys",
    implicit: "On Vercel the AI Gateway authenticates with the deployment's own OIDC token, so no key is needed.",
  },
  { id: "firebase", name: "Firebase Cloud Messaging", purpose: "Push notifications to the Android app", vars: [v("FIREBASE_SERVICE_ACCOUNT")], console: "https://console.firebase.google.com → Project settings → Service accounts" },
  { id: "vapid", name: "Web Push (VAPID)", purpose: "Push notifications to browsers", vars: [v("NEXT_PUBLIC_VAPID_PUBLIC_KEY", true, false), v("VAPID_PRIVATE_KEY"), v("VAPID_SUBJECT", false, false)], console: "Generated locally (npx web-push generate-vapid-keys)" },
  { id: "kingschat", name: "KingsChat", purpose: "Sign in with KingsChat, and messages", vars: [v("KINGSCHAT_CLIENT_ID", true, false), v("KINGSCHAT_MOBILE_CLIENT_ID", false, false), v("KINGSCHAT_REDIRECT_URI", false, false), v("KINGSCHAT_API_BASE", false, false)], console: "The KingsChat developer portal" },
  { id: "neoemail", name: "NeoEmail", purpose: "Sign in with NeoEmail", vars: [v("NEOEMAIL_CLIENT_ID", true, false), v("NEOEMAIL_CLIENT_SECRET"), v("NEOEMAIL_ISSUER", true, false), v("NEOEMAIL_REDIRECT_URI", false, false)], console: "The NeoEmail identity provider's client settings" },
  { id: "hsmoh", name: "HSMOH", purpose: "Event registration sync", vars: [v("HSMOH_API_KEY"), v("HSMOH_BASE_URL", true, false)], console: "Ask the HSMOH team" },
  { id: "streamlab", name: "StreamLab", purpose: "RTMP livestream provisioning", vars: [v("STREAMLAB_API_KEY"), v("STREAMLAB_BASE_URL", true, false)], console: "The StreamLab dashboard" },
  { id: "internal", name: "Internal secrets", purpose: "Cron and scheduler auth, admin two-factor encryption, health report", vars: [v("CRON_SECRET"), v("DISPATCH_SECRET", false), v("ADMIN_MFA_KEY", false), v("HEALTH_CHECK_TOKEN", false)], console: "Made by you (any long random string)" },
];

export type IntegrationState = "configured" | "partial" | "not_configured";

export interface IntegrationStatus {
  id: string;
  name: string;
  purpose: string;
  state: IntegrationState;
  console: string;
  implicit?: string;
  vars: { name: string; required: boolean; secret: boolean; set: boolean; fingerprint: string | null }[];
}

/** First 8 hex characters of the value's SHA-256: changes on rotation, reveals nothing. */
export function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

export function integrationStatuses(env: Record<string, string | undefined> = process.env): IntegrationStatus[] {
  return INTEGRATIONS.map((i) => {
    const vars = i.vars.map((x) => {
      const value = env[x.name];
      const set = typeof value === "string" && value.length > 0;
      return { name: x.name, required: x.required, secret: x.secret, set, fingerprint: set ? fingerprint(value!) : null };
    });
    const required = vars.filter((x) => x.required);
    const anySet = vars.some((x) => x.set);
    let state: IntegrationState;
    if (required.length ? required.every((x) => x.set) : anySet || !!i.implicit) state = "configured";
    else state = anySet ? "partial" : "not_configured";
    return { id: i.id, name: i.name, purpose: i.purpose, state, console: i.console, implicit: i.implicit, vars };
  });
}

/** How to rotate a secret that lives in an environment variable. */
export const ROTATION_STEPS = [
  "Create a new key or secret in the provider's console (the link beside each integration). Keep the old one active for now.",
  "In Vercel: Project → Settings → Environment Variables, edit the variable for Production (and Preview if used), paste the new value, save.",
  "Redeploy production (Deployments → the latest → Redeploy) so the new value is used, and check the fingerprint here changed.",
  "Once the site works on the new value, revoke the old key in the provider's console.",
];

export const ROTATION_DOCS = "https://vercel.com/docs/environment-variables/managing-environment-variables";
