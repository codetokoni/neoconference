/*
 * examples/prayerclouds/prayer-reports.js — prayer time and zone reports on
 * PrayerClouds' zone page (sample). No dependencies.
 *
 *   <div id="prayer-reports"></div>
 *   <script src="/prayer-reports.js"></script>
 *   <script>
 *     const reports = PrayerReports.mount({ el: "#prayer-reports", zone: "FALF", signedIn: true });
 *     widget.on("prayer-time", (e) => reports.liveTimer(e));   // the meeting's own timer, mirrored
 *   </script>
 *
 * It only talks to YOUR server (/api/prayer-meeting/reports/...), which
 * adds the secret key and says who is looking. What each person sees is
 * decided by NeoLinguaMeet from its lists of zone leaders and
 * administrators: a leader's report appears only for the zones they lead,
 * everyone else sees their own time and the zone's public figures (if the
 * zone shows any). Reports refresh every 15 s; an unchanged report costs a
 * 304.
 */
(function () {
  "use strict";

  var REFRESH_MS = 15000;

  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === "text") el.textContent = attrs[k];
      else if (k === "onclick") el.addEventListener("click", attrs[k]);
      else if (attrs[k] != null) el.setAttribute(k, attrs[k]);
    }
    (children || []).forEach(function (c) {
      if (c != null) el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return el;
  }

  function hms(total) {
    total = Math.max(0, Math.floor(total || 0));
    var p = function (n) { return (n < 10 ? "0" : "") + n; };
    return p(Math.floor(total / 3600)) + ":" + p(Math.floor((total % 3600) / 60)) + ":" + p(total % 60);
  }

  function when(ms, tz) {
    if (ms == null) return "—";
    try {
      return new Intl.DateTimeFormat("en-GB", { timeZone: tz, dateStyle: "medium", timeStyle: "medium" }).format(new Date(ms));
    } catch (e) {
      return new Date(ms).toISOString();
    }
  }

  /** GET with the last ETag; 304 keeps what we had. */
  function getter(base) {
    var tags = {};
    var cache = {};
    return function (path) {
      var headers = { accept: "application/json" };
      if (tags[path]) headers["if-none-match"] = tags[path];
      return fetch(base + path, { credentials: "same-origin", headers: headers, cache: "no-store" }).then(function (res) {
        if (res.status === 304) return { status: 200, body: cache[path], fresh: false };
        return res.json().then(
          function (body) {
            if (res.ok) {
              tags[path] = res.headers.get("etag");
              cache[path] = body;
            }
            return { status: res.status, body: body, fresh: true };
          },
          function () { return { status: res.status, body: null, fresh: true }; }
        );
      });
    };
  }

  function mount(opts) {
    var root = typeof opts.el === "string" ? document.querySelector(opts.el) : opts.el;
    if (!root) throw new Error("PrayerReports.mount: el not found");
    var zone = encodeURIComponent(opts.zone);
    var base = opts.base || "/api/prayer-meeting/reports";
    var get = getter(base);
    var state = { period: "today", from: "", to: "", page: 1, pageSize: 25, session: null };
    var checkedAt = null;

    var publicBox = h("section", { class: "pr-public" });
    var mineBox = h("section", { class: "pr-mine" });
    var reportBox = h("section", { class: "pr-report", hidden: "" });
    var footer = h("p", { class: "pr-updated" });
    root.appendChild(publicBox);
    root.appendChild(mineBox);
    root.appendChild(reportBox);
    root.appendChild(footer);

    function query(extra) {
      var q = "zone=" + zone + "&period=" + state.period;
      if (state.period === "custom") q += "&from=" + encodeURIComponent(state.from) + "&to=" + encodeURIComponent(state.to);
      return q + (extra || "");
    }

    var LABELS = {
      sessions: "Prayer sessions",
      uniqueParticipants: "Participants",
      connectedNow: "Praying now",
      totalPrayerSeconds: "Total prayer time",
      averagePrayerSeconds: "Average per person",
    };
    function stat(label, value) {
      return h("div", { class: "pr-stat" }, [h("div", { class: "pr-stat-label", text: label }), h("div", { class: "pr-stat-value", text: value })]);
    }
    function fmtStat(k, v) {
      return /Seconds$/.test(k) ? hms(v) : String(v);
    }

    function renderPublic(r) {
      publicBox.textContent = "";
      if (!r || r.status !== 200 || !r.body || !Object.keys(r.body.stats || {}).length) return;
      publicBox.appendChild(h("h2", { text: "Today in " + r.body.zone.name }));
      var row = h("div", { class: "pr-stats" });
      Object.keys(r.body.stats).forEach(function (k) { row.appendChild(stat(LABELS[k] || k, fmtStat(k, r.body.stats[k]))); });
      publicBox.appendChild(row);
    }

    var liveEl = h("span", { class: "pr-live", text: "" });
    function renderMine(r) {
      mineBox.textContent = "";
      if (!opts.signedIn || !r || r.status !== 200 || !r.body) return;
      var a = r.body.attendance;
      mineBox.appendChild(h("h2", { text: "My prayer time" }));
      mineBox.appendChild(h("p", {}, ["Now: ", liveEl]));
      var row = h("div", { class: "pr-stats" }, [
        stat("Today", hms(a.prayerSeconds)),
        stat("Sessions today", String(a.sessionsAttended)),
        stat("First joined", when(a.firstJoined, r.body.period.timezone)),
      ]);
      mineBox.appendChild(row);
    }

    function table(headers, rows) {
      var t = h("table", { class: "pr-table" });
      t.appendChild(h("thead", {}, [h("tr", {}, headers.map(function (x) { return h("th", { text: x }); }))]));
      var body = h("tbody");
      rows.forEach(function (r) { body.appendChild(h("tr", {}, r.map(function (c) { return typeof c === "string" ? h("td", { text: c }) : h("td", {}, [c]); }))); });
      t.appendChild(body);
      return t;
    }

    function periodPicker() {
      var bar = h("div", { class: "pr-periods" });
      [["current", "Current session"], ["today", "Today"], ["week", "This week"], ["month", "This month"], ["custom", "Custom"]].forEach(function (p) {
        bar.appendChild(h("button", { type: "button", "aria-pressed": String(state.period === p[0]), onclick: function () {
          state.period = p[0];
          state.page = 1;
          state.session = null;
          // A custom range starts as the last seven days, so it never asks without dates.
          if (p[0] === "custom" && (!state.from || !state.to)) {
            var day = function (d) { return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2); };
            var today = new Date();
            state.to = day(today);
            state.from = day(new Date(today.getTime() - 6 * 86400000));
          }
          refresh(true);
        }, text: p[1] }));
      });
      if (state.period === "custom") {
        var from = h("input", { type: "date", value: state.from });
        var to = h("input", { type: "date", value: state.to });
        bar.appendChild(from);
        bar.appendChild(to);
        bar.appendChild(h("button", { type: "button", text: "Show", onclick: function () { state.from = from.value; state.to = to.value; state.page = 1; refresh(true); } }));
      }
      return bar;
    }

    function renderReport(summary, people, detail) {
      reportBox.textContent = "";
      if (!summary || summary.status === 403 || summary.status === 401) {
        reportBox.setAttribute("hidden", "");
        return;
      }
      reportBox.removeAttribute("hidden");
      var s = summary.body;
      if (summary.status !== 200 || !s) {
        reportBox.appendChild(h("p", { text: (s && s.error && s.error.message) || "The report could not be loaded." }));
        reportBox.insertBefore(periodPicker(), reportBox.firstChild);
        return;
      }
      var tz = s.period.timezone;
      reportBox.appendChild(h("h2", { text: s.zone.name + " — prayer report" }));
      reportBox.appendChild(periodPicker());
      reportBox.appendChild(h("p", { class: "pr-period", text: s.period.label + " · times in " + tz }));
      var row = h("div", { class: "pr-stats" });
      ["sessions", "uniqueParticipants", "connectedNow", "totalPrayerSeconds", "averagePrayerSeconds"].forEach(function (k) {
        row.appendChild(stat(LABELS[k], fmtStat(k, s.summary[k])));
      });
      reportBox.appendChild(row);

      reportBox.appendChild(h("h3", { text: "Sessions" }));
      reportBox.appendChild(table(
        ["Started", "Ended", "Session duration", "Participants", "Prayer time (everyone)", ""],
        s.sessions.map(function (x) {
          return [when(x.startedAt, tz), x.endedAt ? when(x.endedAt, tz) : "running", hms(x.durationSeconds), String(x.participants), hms(x.prayerSeconds),
            h("button", { type: "button", text: "Details", onclick: function () { state.session = x.id; refresh(true); } })];
        })
      ));

      if (detail && detail.status === 200 && detail.body && detail.body.session) {
        var d = detail.body;
        reportBox.appendChild(h("h3", { text: "Session from " + when(d.session.startedAt, tz) }));
        reportBox.appendChild(table(
          ["Participant", "Prayer time", "Connected"],
          d.participants.map(function (p) {
            return [p.name, hms(p.prayerSeconds), p.intervals.map(function (i) { return when(i.start, tz).split(", ").pop() + "–" + when(i.end, tz).split(", ").pop(); }).join(", ")];
          })
        ));
      }

      if (people && people.status === 200 && people.body) {
        var pb = people.body;
        reportBox.appendChild(h("h3", { text: "Participants (" + pb.total + ")" }));
        reportBox.appendChild(table(
          ["Participant", "First joined", "Last left", "Sessions", "Prayer time"],
          pb.participants.map(function (p) {
            return [p.name + (p.guest ? " (guest)" : ""), when(p.firstJoined, tz), p.connected ? "praying now" : when(p.lastLeft, tz), String(p.sessionsAttended), hms(p.prayerSeconds)];
          })
        ));
        var nav = h("div", { class: "pr-pages" }, [
          h("button", { type: "button", text: "Previous", disabled: pb.page <= 1 ? "" : null, onclick: function () { state.page--; refresh(true); } }),
          " Page " + pb.page + " of " + pb.pages + " ",
          h("button", { type: "button", text: "Next", disabled: pb.page >= pb.pages ? "" : null, onclick: function () { state.page++; refresh(true); } }),
          " ",
          h("a", { href: base + "/export?" + query(), text: "Download CSV" }),
        ]);
        reportBox.appendChild(nav);
      }
    }

    var busy = false;
    function refresh(force) {
      if (busy && !force) return;
      busy = true;
      var jobs = [
        get("/public?zone=" + zone + "&period=today"),
        opts.signedIn ? get("/me?zone=" + zone + "&period=today") : Promise.resolve(null),
        opts.signedIn ? get("/zone?" + query()) : Promise.resolve(null),
      ];
      Promise.all(jobs)
        .then(function (r) {
          renderPublic(r[0]);
          renderMine(r[1]);
          var summary = r[2];
          if (!summary || summary.status !== 200) return renderReport(summary, null, null);
          return Promise.all([
            get("/participants?" + query("&page=" + state.page + "&pageSize=" + state.pageSize)),
            state.session ? get("/session?" + query("&session=" + state.session)) : Promise.resolve(null),
          ]).then(function (more) { renderReport(summary, more[0], more[1]); });
        })
        .catch(function () { /* the next refresh tries again */ })
        .then(function () {
          busy = false;
          checkedAt = new Date();
          footer.textContent = "Last updated " + checkedAt.toLocaleTimeString();
        });
    }

    refresh(true);
    var timer = setInterval(function () { if (!document.hidden) refresh(false); }, REFRESH_MS);
    document.addEventListener("visibilitychange", function () { if (!document.hidden) refresh(false); });

    return {
      refresh: function () { refresh(true); },
      /** Mirror of the meeting's own timer: widget.on("prayer-time", reports.liveTimer). */
      liveTimer: function (e) {
        liveEl.textContent = hms(e.seconds) + (e.connected ? "" : " (paused)");
      },
      destroy: function () {
        clearInterval(timer);
        root.textContent = "";
      },
    };
  }

  window.PrayerReports = { mount: mount };
})();
