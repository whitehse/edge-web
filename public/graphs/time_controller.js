/**
 * Shared time window for the graphs workspace: live, pan, zoom, scrub.
 *
 * Live mode scrolls like a hospital strip: right edge follows wall clock but
 * may only lead the latest sample by LIVE_LEAD_MS (same model as /host/).
 * That keeps history on screen when the feed lags a bucket, instead of
 * scrolling away into a flat empty hold.
 */

const MIN_DUR = 15_000;
const MAX_DUR = 48 * 3600_000;
/** How far the right edge may lead the latest sample (ms). */
const LIVE_LEAD_MS = 2500;
/** No feed for this long → pin window to last sample (don't empty the chart). */
const FEED_STALE_MS = 15000;

export function createTimeController(opts) {
  opts = opts || {};
  let durationMs = opts.durationMs || 10 * 60 * 1000;
  let t1 = opts.t1 != null ? opts.t1 : Date.now();
  let live = opts.live !== false;
  let scrubMs = null; /* absolute cursor; null = follow live edge */
  let dataEndMs = 0;
  let feedAgeMs = 0;
  const listeners = [];

  function clampDur(d) {
    if (d < MIN_DUR) return MIN_DUR;
    if (d > MAX_DUR) return MAX_DUR;
    return d;
  }

  function notify() {
    const snap = snapshot();
    for (let i = 0; i < listeners.length; i++) {
      try {
        listeners[i](snap);
      } catch (e) {
        console.error(e);
      }
    }
  }

  function snapshot() {
    const now = Date.now();
    let end = t1;
    if (live) {
      if (feedAgeMs > FEED_STALE_MS && dataEndMs > 0) {
        /* Feed stalled — pin to last sample so the chart doesn't empty. */
        end = dataEndMs + LIVE_LEAD_MS;
      } else {
        /* Fresh feed: scroll with wall clock, cap lead past last sample. */
        end = now;
        if (dataEndMs > 0) {
          const leadCap = dataEndMs + LIVE_LEAD_MS;
          if (end > leadCap) end = leadCap;
        }
      }
      t1 = end;
    }
    const dur = clampDur(durationMs);
    durationMs = dur;
    return {
      t0: end - dur,
      t1: end,
      durationMs: dur,
      live: live,
      scrubMs: scrubMs,
      cursorMs: scrubMs != null ? scrubMs : end,
      dataEndMs: dataEndMs,
      feedAgeMs: feedAgeMs,
      minutes: Math.max(1, Math.ceil(dur / 60000)),
      hours: Math.max(1, Math.ceil(dur / 3600000))
    };
  }

  return {
    onChange: function (fn) {
      listeners.push(fn);
      return function () {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    get: snapshot,
    setDuration: function (ms, keepLive) {
      durationMs = clampDur(ms);
      if (keepLive === false) live = false;
      notify();
    },
    setLive: function (on) {
      live = !!on;
      if (live) {
        scrubMs = null;
        t1 = Date.now();
      }
      notify();
    },
    goLive: function () {
      live = true;
      scrubMs = null;
      t1 = Date.now();
      notify();
    },
    panTo: function (newT0, newT1) {
      live = false;
      if (newT1 > newT0) {
        durationMs = clampDur(newT1 - newT0);
        t1 = newT1;
      }
      notify();
    },
    panBy: function (dtMs) {
      live = false;
      t1 = t1 + dtMs;
      notify();
    },
    zoomAt: function (factor, anchorFrac) {
      const s = snapshot();
      const dur = clampDur(s.durationMs * factor);
      const anchorT = s.t0 + s.durationMs * (anchorFrac != null ? anchorFrac : 0.5);
      /* keep anchor fixed */
      live = false;
      durationMs = dur;
      t1 = anchorT + dur * (1 - (anchorFrac != null ? anchorFrac : 0.5));
      notify();
    },
    setScrub: function (ms) {
      const s = snapshot();
      if (ms == null) {
        scrubMs = null;
      } else {
        scrubMs = Math.max(s.t0, Math.min(s.t1, ms));
      }
      notify();
    },
    clearScrub: function () {
      scrubMs = null;
      notify();
    },
    setDataEnd: function (ms, feedAge) {
      dataEndMs = ms || 0;
      feedAgeMs = feedAge || 0;
      /* do not notify — live tick drives redraws */
    },
    /** Call from rAF while live so the strip advances. */
    tick: function () {
      if (live) notify();
    },
    MIN_DUR: MIN_DUR,
    MAX_DUR: MAX_DUR,
    LIVE_LEAD_MS: LIVE_LEAD_MS
  };
}
