/*!
 * NeoConference embed loader
 *
 * Usage on any website:
 *
 *   <div data-neo-meeting data-token="GUEST_JOIN_TOKEN"></div>
 *   <script src="https://www.neoconference.app/embed.js" async></script>
 *
 * Optional attributes on the container:
 *   data-token   (required) guest join token minted via the NeoConference API
 *   data-url     (optional) LiveKit server ws URL, if not using the default
 *   data-height  (optional) CSS height of the embed (default: 600px)
 *   data-base    (optional) origin of the embed host (default: script origin)
 *
 * Mint the token server-side, per user, just before rendering:
 *   POST https://www.neoconference.app/api/v1/meetings/{id}/tokens
 *   Authorization: Bearer nc_live_...
 */
(function () {
  "use strict";

  var SELECTOR = "[data-neo-meeting]";

  function scriptOrigin() {
    try {
      var cur = document.currentScript;
      if (cur && cur.src) return new URL(cur.src).origin;
    } catch (e) {}
    return "https://www.neoconference.app";
  }

  var DEFAULT_BASE = scriptOrigin();

  function mount(el) {
    if (el.getAttribute("data-neo-mounted") === "1") return;

    var token = el.getAttribute("data-token");
    if (!token) {
      console.warn("[NeoConference] data-token is required on", el);
      return;
    }

    var base = el.getAttribute("data-base") || DEFAULT_BASE;
    var height = el.getAttribute("data-height") || "600px";
    var serverUrl = el.getAttribute("data-url") || "";

    var src = base.replace(/\/$/, "") + "/embed/meeting?token=" + encodeURIComponent(token);
    if (serverUrl) src += "&url=" + encodeURIComponent(serverUrl);

    var iframe = document.createElement("iframe");
    iframe.src = src;
    iframe.title = "NeoConference meeting";
    iframe.allow = "camera; microphone; fullscreen; display-capture; autoplay";
    iframe.setAttribute("allowfullscreen", "true");
    iframe.style.border = "0";
    iframe.style.width = "100%";
    iframe.style.height = height;
    iframe.style.borderRadius = "12px";
    iframe.style.background = "#03050a";

    el.innerHTML = "";
    el.appendChild(iframe);
    el.setAttribute("data-neo-mounted", "1");
  }

  function scan() {
    var nodes = document.querySelectorAll(SELECTOR);
    for (var i = 0; i < nodes.length; i++) mount(nodes[i]);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scan);
  } else {
    scan();
  }

  // Expose a manual hook for SPA / dynamic insertion.
  window.NeoConference = window.NeoConference || {};
  window.NeoConference.mountEmbeds = scan;
})();
