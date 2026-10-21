/*!
 * NeoLinguaMeet zone widget, protocol v1.
 *
 * Puts a partner zone's meeting on your page. Your backend asks
 * NeoLinguaMeet for a one-time join code (POST /api/partner/v1/join-sessions
 * with your secret key) and returns it from an endpoint on YOUR site; this
 * script fetches that endpoint and hands the code to the meeting frame.
 * The secret key never reaches the browser, and nothing about the visitor
 * goes in a URL.
 *
 *   <div id="meeting"></div>
 *   <script src="https://neolinguameet.com/widget/v1.js"></script>
 *   <script>
 *     const widget = NeoLinguaMeetWidget.mount({
 *       container: "#meeting",                 // element or selector
 *       sessionEndpoint: "/api/prayer-meeting/session?zone=FALF",
 *       height: 640,                           // px or any CSS length; default 600
 *       theme: "dark",                         // "dark" | "light"
 *     });
 *     widget.on("joined", () => {});
 *     widget.on("error", (e) => console.warn(e.code, e.message));
 *   </script>
 *
 * sessionEndpoint is called with credentials (your visitor's cookies) and
 * must answer JSON { code } — the code from join-sessions — or an error
 * status. It is called again whenever the frame needs a new code. It is a
 * POST; sessionBody (an object, or a function returning one or a promise of
 * one) is sent as its JSON body — for example a guest's name. Never put
 * who the visitor is in the endpoint's address.
 *
 * Methods: join(), leave(), requestFullscreen(), destroy(), on(type, fn),
 * off(type, fn). Events: ready, waiting, joined, left, meeting-ended,
 * permission-denied, prayer-time ({ seconds, connected, sessionId }, each
 * second in the meeting), error. See docs/integrations/partner-zones.md.
 */
(function () {
  "use strict";

  var VERSION = 1;
  var EVENTS = ["ready", "waiting", "joined", "left", "meeting-ended", "permission-denied", "prayer-time", "error"];

  // Where this script was loaded from is where the meeting lives.
  var scriptSrc = (document.currentScript && document.currentScript.src) || "";
  var BASE = "";
  try {
    BASE = new URL(scriptSrc).origin;
  } catch (e) {
    BASE = "";
  }

  function resolveContainer(c) {
    if (typeof c === "string") return document.querySelector(c);
    return c && c.nodeType === 1 ? c : null;
  }

  function cssLength(v, fallback) {
    if (typeof v === "number" && isFinite(v) && v > 0) return v + "px";
    if (typeof v === "string" && /^[0-9.]+(px|vh|vw|rem|em|%)$/.test(v)) return v;
    return fallback;
  }

  function mount(options) {
    options = options || {};
    var container = resolveContainer(options.container);
    if (!container) throw new Error("NeoLinguaMeetWidget.mount: container not found");
    if (!options.sessionEndpoint) throw new Error("NeoLinguaMeetWidget.mount: sessionEndpoint is required");
    var base = options.baseUrl ? new URL(options.baseUrl).origin : BASE;
    if (!base) throw new Error("NeoLinguaMeetWidget.mount: cannot tell where the meeting is; pass baseUrl");

    var listeners = {};
    var destroyed = false;
    var fetching = false;

    var src = new URL("/embed/zone", base);
    if (options.theme === "light") src.searchParams.set("theme", "light");

    var iframe = document.createElement("iframe");
    iframe.src = src.toString();
    iframe.title = options.title || "Meeting";
    iframe.setAttribute("allow", "camera; microphone; fullscreen; display-capture; autoplay; clipboard-write");
    iframe.setAttribute("referrerpolicy", "origin");
    iframe.style.width = "100%";
    iframe.style.height = cssLength(options.height, "600px");
    iframe.style.border = "0";
    iframe.style.borderRadius = typeof options.radius === "number" ? options.radius + "px" : "12px";
    iframe.style.background = "#03050a";
    iframe.style.display = "block";
    container.appendChild(iframe);

    function fire(type, detail) {
      var fns = (listeners[type] || []).slice();
      for (var i = 0; i < fns.length; i++) {
        try {
          fns[i](detail || {});
        } catch (e) {
          if (window.console) console.error("[NeoLinguaMeetWidget]", e);
        }
      }
    }

    function send(msg) {
      if (destroyed || !iframe.contentWindow) return;
      msg.nlm = VERSION;
      // Always the meeting's exact origin, never "*".
      iframe.contentWindow.postMessage(msg, base);
    }

    /** sessionBody: an object, or a function returning one (or a promise of one), sent as JSON. */
    function bodyFor() {
      var b = options.sessionBody;
      try {
        return Promise.resolve(typeof b === "function" ? b() : b);
      } catch (e) {
        return Promise.reject(e);
      }
    }

    function fetchCode() {
      if (fetching || destroyed) return;
      fetching = true;
      var get = options.sessionMethod === "GET";
      (get ? Promise.resolve(undefined) : bodyFor())
        .then(function (body) {
          var init = {
            method: get ? "GET" : "POST",
            credentials: "same-origin",
            headers: { accept: "application/json" },
            cache: "no-store",
          };
          if (!get && body != null) {
            init.headers["content-type"] = "application/json";
            init.body = JSON.stringify(body);
          }
          return fetch(options.sessionEndpoint, init);
        })
        .then(function (res) {
          return res.json().then(
            function (data) {
              return { ok: res.ok, status: res.status, data: data };
            },
            function () {
              return { ok: res.ok, status: res.status, data: {} };
            }
          );
        })
        .then(function (r) {
          fetching = false;
          var code = r.data && (r.data.code || (r.data.session && r.data.session.code));
          if (!r.ok || typeof code !== "string") {
            var err = (r.data && r.data.error) || {};
            fire("error", {
              code: typeof err === "object" && err.code ? err.code : r.status === 401 ? "sign_in_required" : "session_endpoint_failed",
              message: typeof err === "object" && err.message ? err.message : typeof err === "string" ? err : "Could not start the meeting.",
              status: r.status,
            });
            return;
          }
          send({ type: "session", code: code });
        })
        .catch(function () {
          fetching = false;
          fire("error", { code: "session_endpoint_failed", message: "Could not start the meeting." });
        });
    }

    function onMessage(event) {
      if (destroyed) return;
      // Only the frame we made, and only from the meeting's origin.
      if (event.source !== iframe.contentWindow || event.origin !== base) return;
      var d = event.data;
      if (!d || typeof d !== "object" || d.nlm !== VERSION || typeof d.type !== "string") return;
      if (d.type === "request-session") {
        fetchCode();
        return;
      }
      if (EVENTS.indexOf(d.type) === -1) return;
      var detail = {};
      for (var k in d) if (k !== "nlm" && k !== "type" && Object.prototype.hasOwnProperty.call(d, k)) detail[k] = d[k];
      fire(d.type, detail);
    }
    window.addEventListener("message", onMessage);

    var api = {
      iframe: iframe,
      join: function () {
        send({ type: "join" });
      },
      leave: function () {
        send({ type: "leave" });
      },
      requestFullscreen: function () {
        var fn = iframe.requestFullscreen || iframe.webkitRequestFullscreen;
        if (fn) return Promise.resolve(fn.call(iframe));
        return Promise.reject(new Error("Full screen is not available"));
      },
      on: function (type, fn) {
        if (typeof fn !== "function") return api;
        (listeners[type] = listeners[type] || []).push(fn);
        return api;
      },
      off: function (type, fn) {
        var fns = listeners[type];
        if (!fns) return api;
        listeners[type] = fn ? fns.filter(function (f) { return f !== fn; }) : [];
        return api;
      },
      destroy: function () {
        if (destroyed) return;
        destroyed = true;
        window.removeEventListener("message", onMessage);
        listeners = {};
        if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
      },
    };
    return api;
  }

  var Widget = { version: VERSION, mount: mount };
  window.NeoLinguaMeetWidget = Widget;
  // The name partners used before the rename.
  if (!window.NeoConferenceWidget) window.NeoConferenceWidget = Widget;
})();
