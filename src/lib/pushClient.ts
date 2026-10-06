// src/lib/pushClient.ts
//
// The browser half of call alerts: registering the service worker, asking
// for permission (only ever from a button press) and keeping the server's
// copy of this browser's subscription current. Client-only.

export const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || "";

export type AlertsState =
  | "unsupported" //      this browser has no Web Push
  | "ios-install" //      iPhone/iPad Safari: only works from the Home Screen
  | "unavailable" //      the site has no push keys configured
  | "off" //              supported, never asked (or turned off here)
  | "blocked" //          the person said no; only browser settings undo it
  | "on"; //              permission granted and this browser is registered

export function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  // iPadOS reports itself as a Mac; touch gives it away.
  return /iPad|iPhone|iPod/.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1);
}

export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** The service worker, registered once per page. */
export async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  } catch (err) {
    console.warn("[push] service worker registration failed", err);
    return null;
  }
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function sendToServer(sub: PushSubscription): Promise<boolean> {
  const res = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ subscription: sub.toJSON() }),
  });
  return res.ok;
}

/** Where this browser stands, without asking anything. */
export async function alertsState(): Promise<AlertsState> {
  if (isIos() && !isStandalone()) return "ios-install";
  if (!pushSupported()) return "unsupported";
  if (!VAPID_PUBLIC_KEY) return "unavailable";
  if (Notification.permission === "denied") return "blocked";
  if (Notification.permission !== "granted") return "off";
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return "off";
  const res = await fetch(`/api/push/status?endpoint=${encodeURIComponent(sub.endpoint)}`, { cache: "no-store" }).catch(
    () => null
  );
  if (!res?.ok) return "on";
  const status = (await res.json()) as { thisDevice: boolean };
  return status.thisDevice ? "on" : "off";
}

/**
 * Turn alerts on. Must run inside a click handler: it may show the browser's
 * permission prompt. Returns the state afterwards.
 */
export async function turnAlertsOn(): Promise<AlertsState> {
  if (!pushSupported() || !VAPID_PUBLIC_KEY) return alertsState();
  const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
  if (permission !== "granted") return permission === "denied" ? "blocked" : "off";
  const reg = await registration();
  if (!reg) return "unsupported";
  await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(VAPID_PUBLIC_KEY) }));
  return (await sendToServer(sub)) ? "on" : "off";
}

/** Turn alerts off in this browser (other browsers keep theirs). */
export async function turnAlertsOff(): Promise<AlertsState> {
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await fetch("/api/push/subscribe", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    }).catch(() => undefined);
    await sub.unsubscribe().catch(() => undefined);
  }
  return alertsState();
}

/**
 * On page load, with permission already given: make sure the server has this
 * browser's current subscription (it may have changed while no page was
 * open). Never prompts.
 */
export async function syncAlerts(): Promise<void> {
  if (!pushSupported() || !VAPID_PUBLIC_KEY || Notification.permission !== "granted") return;
  const reg = await registration();
  if (!reg) return;
  await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager
      .subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(VAPID_PUBLIC_KEY) })
      .catch(() => null));
  if (sub) await sendToServer(sub).catch(() => false);
}

/** Fired on window when notifications may have changed (a push, a read). */
export const NOTIFICATIONS_CHANGED = "neo:notifications";
