/**
 * Shared live-strip + series-feed helpers for host / graphs / flows.
 *
 * Rules (hospital-strip model):
 *  1. Merge series by timestamp — never replace a dense buffer with a short WS tip.
 *  2. Live right edge may only lead the latest sample by LIVE_LEAD_MS.
 *  3. Stale = no WS/REST push for FEED_STALE_MS (not sample bucket age).
 *  4. On every WS open: re-watch + REST bootstrap (server drops watches).
 *  5. Host/wifi series limit 120 (server frame cap).
 *
 * Classic script: window.LiveFeed
 * ES modules: import not supported from this file — use window.LiveFeed or
 * the re-export path below after the classic script is loaded.
 */
(function (global) {
  var LIVE_LEAD_MS = 2500;
  var FEED_STALE_MS = 15000;
  var LIVE_MORPH_MS = 1600;
  var HOST_SERIES_LIMIT = 120;
  var REST_SAFETY_MS = 8000;

  function pointTime(p, parseTsFn) {
    if (!p) return NaN;
    if (p.t != null && isFinite(Number(p.t))) return Number(p.t);
    if (typeof parseTsFn === "function") return parseTsFn(p.ts);
    /* Minimal ISO / CH DateTime parser when no helper is passed */
    if (p.ts == null || p.ts === "") return NaN;
    if (typeof p.ts === "number") {
      return p.ts > 0 && p.ts < 1e12 ? p.ts * 1000 : p.ts;
    }
    var s = String(p.ts).trim();
    if (/^\d+(\.\d+)?$/.test(s)) {
      var n = Number(s);
      return n > 0 && n < 1e12 ? n * 1000 : n;
    }
    /*
     * ClickHouse DateTime is UTC without zone. Force …T…Z before bare
     * Date.parse (space form is local in most browsers — empty live charts).
     */
    if (
      /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(s) &&
      !/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)
    ) {
      var iso = s.indexOf("T") >= 0 ? s : s.replace(" ", "T");
      var tCh = Date.parse(iso + "Z");
      if (!isNaN(tCh)) return tCh;
    }
    var t = Date.parse(s);
    return isNaN(t) ? NaN : t;
  }

  /**
   * Merge series by timestamp bucket. ALWAYS accumulate — never replace a
   * longer history with a short WS snapshot (2–4 tip points).
   *
   * @param {Array} prev previous buffer
   * @param {Array} next new points (WS push or REST)
   * @param {number} lookbackMs keep window relative to newest point
   * @param {object} [opts] { limit, parseTs }
   */
  function mergeByTimestamp(prev, next, lookbackMs, opts) {
    opts = opts || {};
    var parseTsFn = opts.parseTs;
    var limit =
      opts.limit > 0 ? opts.limit : HOST_SERIES_LIMIT * 3;
    var byT = Object.create(null);

    function ingest(list) {
      if (!list) return;
      for (var i = 0; i < list.length; i++) {
        var p = list[i];
        var t = pointTime(p, parseTsFn);
        if (!isFinite(t)) continue;
        byT[String(Math.round(t))] = p;
      }
    }
    ingest(prev);
    ingest(next);

    var keys = Object.keys(byT);
    if (!keys.length) return [];
    keys.sort(function (a, b) {
      return Number(a) - Number(b);
    });

    var latest = Number(keys[keys.length - 1]);
    var cutoff = Math.max(
      0,
      latest - (lookbackMs > 0 ? lookbackMs : 10 * 60 * 1000)
    );
    var out = [];
    for (var j = 0; j < keys.length; j++) {
      var tk = Number(keys[j]);
      if (tk < cutoff) continue;
      out.push(byT[keys[j]]);
    }
    if (out.length > limit) return out.slice(out.length - limit);
    return out;
  }

  /**
   * Live window [t0,t1] given wall clock, data end, and last push age.
   * Matches host plotSeries + graphs TimeController.
   */
  function liveWindow(opts) {
    opts = opts || {};
    var nowMs = opts.nowMs != null ? opts.nowMs : Date.now();
    var durationMs = opts.durationMs > 0 ? opts.durationMs : 10 * 60 * 1000;
    var dataEndMs = opts.dataEndMs > 0 ? opts.dataEndMs : 0;
    var lastPushMs = opts.lastPushMs > 0 ? opts.lastPushMs : 0;
    var leadMs = opts.leadMs != null ? opts.leadMs : LIVE_LEAD_MS;
    var staleMs = opts.staleMs != null ? opts.staleMs : FEED_STALE_MS;

    var feedAge = lastPushMs > 0 ? nowMs - lastPushMs : 0;
    var stale = lastPushMs > 0 && feedAge > staleMs;
    var t1 = nowMs;
    if (dataEndMs > 0) {
      if (stale) {
        t1 = dataEndMs + leadMs;
      } else {
        var leadCap = dataEndMs + leadMs;
        if (t1 > leadCap) t1 = leadCap;
      }
    }
    return {
      t0: t1 - durationMs,
      t1: t1,
      durationMs: durationMs,
      dataEndMs: dataEndMs,
      feedAgeMs: feedAge,
      stale: stale,
      live: true
    };
  }

  function isPushStale(lastPushMs, nowMs, staleMs) {
    nowMs = nowMs != null ? nowMs : Date.now();
    staleMs = staleMs != null ? staleMs : FEED_STALE_MS;
    if (!(lastPushMs > 0)) return false;
    return nowMs - lastPushMs > staleMs;
  }

  function fmtAge(ms) {
    if (!isFinite(ms) || ms < 0) return "—";
    if (ms < 1000) return "<1s";
    if (ms < 60000) return Math.round(ms / 1000) + "s";
    return Math.round(ms / 60000) + "m";
  }

  /**
   * Feed chip label for UI.
   * @returns {{ text, kind: "idle"|"receiving"|"stalled"|"waiting" }}
   */
  function feedChip(opts) {
    opts = opts || {};
    var lastPushMs = opts.lastPushMs || 0;
    var dataEndMs = opts.dataEndMs || 0;
    var sampleCount = opts.sampleCount || 0;
    var routerId = opts.routerId || "";
    var nowMs = opts.nowMs != null ? opts.nowMs : Date.now();
    var live = opts.live !== false;

    if (!routerId && opts.requireRouter) {
      return { text: "No CPE selected", kind: "waiting" };
    }
    if (!live) {
      return { text: "History", kind: "idle" };
    }
    if (!(lastPushMs > 0) && sampleCount === 0) {
      return { text: "Waiting for samples…", kind: "waiting" };
    }
    var pushAge = lastPushMs > 0 ? nowMs - lastPushMs : NaN;
    if (isPushStale(lastPushMs, nowMs)) {
      return {
        text: "Stalled · last push " + fmtAge(pushAge) + " ago",
        kind: "stalled"
      };
    }
    if (lastPushMs > 0) {
      return {
        text:
          "Receiving" +
          (sampleCount ? " · " + sampleCount + " pts" : "") +
          (isFinite(pushAge) ? " · " + fmtAge(pushAge) : ""),
        kind: "receiving"
      };
    }
    if (dataEndMs > 0) {
      return {
        text: "Samples · " + sampleCount + " pts",
        kind: "receiving"
      };
    }
    return { text: "Waiting for samples…", kind: "waiting" };
  }

  /**
   * Bind mux status → resubscribe on every open (server drops watches).
   * Returns unsubscribe function.
   */
  function onMuxOpen(mux, fn) {
    if (!mux || typeof mux.onStatus !== "function" || typeof fn !== "function") {
      return function () {};
    }
    var wrapped = function (st) {
      if (st === "open") {
        try {
          fn(st);
        } catch (e) {
          console.error("LiveFeed.onMuxOpen", e);
        }
      }
    };
    mux.onStatus(wrapped);
    return function () {
      /* EdgeMux has no offStatus; leave listener (pages are long-lived). */
    };
  }

  function lookbackFromMinutes(minutes) {
    var m = Number(minutes) || 10;
    return Math.max(60_000, m * 60_000);
  }

  var LiveFeed = {
    LIVE_LEAD_MS: LIVE_LEAD_MS,
    FEED_STALE_MS: FEED_STALE_MS,
    LIVE_MORPH_MS: LIVE_MORPH_MS,
    HOST_SERIES_LIMIT: HOST_SERIES_LIMIT,
    REST_SAFETY_MS: REST_SAFETY_MS,
    pointTime: pointTime,
    mergeByTimestamp: mergeByTimestamp,
    liveWindow: liveWindow,
    isPushStale: isPushStale,
    fmtAge: fmtAge,
    feedChip: feedChip,
    onMuxOpen: onMuxOpen,
    lookbackFromMinutes: lookbackFromMinutes
  };

  global.LiveFeed = LiveFeed;
})(typeof window !== "undefined" ? window : globalThis);
