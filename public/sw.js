/* NeoConference service worker — call alerts (Web Push).
 *
 * Plain JS, served from /sw.js with scope "/". It does one job: turn pushes
 * from src/lib/pushStore.ts into notifications, and open the right page when
 * one is clicked. It caches nothing.
 *
 * Payload (see PushPayload in src/lib/pushStore.ts):
 *   { type, title, body, url, eventSlug?, groupId?, ringId?, expiresAt? }
 */

/* Types the bell shows by itself while a NeoConference tab is in view. */
const QUIET_WHEN_VISIBLE = ["invite", "updated", "cancelled", "started", "added", "mention"];

/* Types with a meeting to go into. */
const JOINABLE = ["invite", "updated", "started", "added", "reminder", "ring"];

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

/** Only paths on this site: a payload can never send someone elsewhere. */
function sameOriginUrl(path) {
  const p = typeof path === "string" && path.startsWith("/") && !path.startsWith("//") ? path : "/dashboard";
  return new URL(p, self.location.origin).href;
}

function readPayload(event) {
  if (!event.data) return null;
  try {
    return event.data.json();
  } catch (e) {
    return { type: "invite", title: "NeoConference", body: event.data.text(), url: "/dashboard" };
  }
}

self.addEventListener("push", (event) => {
  const payload = readPayload(event);
  if (!payload) return;
  event.waitUntil(handlePush(payload));
});

async function handlePush(p) {
  if (typeof p.expiresAt === "number" && Date.now() > p.expiresAt) return;

  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  // Every open tab hears about it, so its bell refreshes.
  for (const w of windows) w.postMessage({ kind: "neo-push", payload: p });
  const visible = windows.some((w) => w.visibilityState === "visible");

  // Reminders, rings and missed calls are never in QUIET_WHEN_VISIBLE: they
  // always reach the person, tab open or not.
  if (visible && QUIET_WHEN_VISIBLE.includes(p.type)) return;

  const ring = p.type === "ring";
  const options = {
    body: p.body || "",
    icon: "/icons/icon-192.png",
    badge: "/icons/badge-96.png",
    data: p,
    // One notification per meeting: a change replaces the invitation.
    ...(p.eventSlug ? { tag: p.eventSlug } : {}),
    renotify: Boolean(p.eventSlug) && (ring || p.type === "reminder"),
    requireInteraction: ring,
    actions: JOINABLE.includes(p.type) ? [{ action: "open", title: "Join" }] : [],
  };
  await self.registration.showNotification(p.title || "NeoConference", options);
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const p = event.notification.data || {};
  const url = sameOriginUrl(p.url);
  event.waitUntil(openOrFocus(url));
});

async function openOrFocus(url) {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const tab = windows.find((w) => new URL(w.url).origin === self.location.origin);
  if (tab) {
    await tab.focus();
    try {
      // Only works for a tab this worker controls; otherwise the page itself
      // navigates when told to (src/components/notifications/PushRegistrar).
      if (typeof tab.navigate === "function") {
        await tab.navigate(url);
        return;
      }
    } catch (e) {
      /* fall through to asking the page */
    }
    tab.postMessage({ kind: "neo-navigate", url });
    return;
  }
  await self.clients.openWindow(url);
}

/* The browser replaced this device's subscription (keys rotated, or it
 * expired). Subscribe again with the same server key and tell the server. If
 * the request is refused (the sign-in cookie may have lapsed), the next visit
 * to the site sends the current subscription anyway. */
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(resubscribe(event));
});

async function resubscribe(event) {
  const key = event.oldSubscription && event.oldSubscription.options && event.oldSubscription.options.applicationServerKey;
  const sub =
    event.newSubscription ||
    (key ? await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }) : null);
  if (!sub) return;
  await fetch("/api/push/subscribe", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ subscription: sub.toJSON() }),
  }).catch(() => undefined);
}
