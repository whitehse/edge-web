(function () {
  function $(id) { return document.getElementById(id); }

  async function jfetch(path, opts) {
    opts = opts || {};
    const r = await fetch(path, {
      method: opts.method || "GET",
      credentials: "same-origin",
      headers: opts.body ? { "Content-Type": "application/json" } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { json = { raw: text }; }
    return { ok: r.ok, status: r.status, json: json, text: text };
  }

  function paintSummary(d) {
    const el = $("summaryCards");
    if (!d || !d.ok) {
      el.textContent = "Unavailable (" + (d && d.error ? d.error : "error") + ")";
      return;
    }
    const gw = d.gateway || {};
    const wifi = d.wifi || {};
    el.innerHTML =
      "<p><strong>" + (gw.model || "Gateway") + "</strong> · " +
      (gw.online ? "<span class=\"pill ok\">online</span>" : "<span class=\"pill down\">offline</span>") +
      "</p>" +
      "<p class=\"hint\">Subscriber <code>" + (d.subscriber_id || "—") +
      "</code> · device <code>" + (d.device_id || "—") +
      "</code> · source " + (d.source || "—") + "</p>" +
      "<p>Primary SSID <strong>" + (wifi.primary_ssid || "—") + "</strong> · " +
      (d.device_count != null ? d.device_count + " clients" : "") + "</p>";
  }

  function paintDevices(d) {
    const el = $("deviceList");
    const list = (d && d.devices) || [];
    if (!list.length) {
      el.innerHTML = "<p class=\"hint\">No devices.</p>";
      return;
    }
    el.innerHTML = list.map(function (dev) {
      const paused = !!dev.paused;
      const online = !!dev.online;
      return (
        "<div class=\"dev-row\" data-id=\"" + dev.id + "\">" +
        "<span class=\"name\">" + (dev.name || dev.id) + "</span>" +
        "<span class=\"meta\">" +
        (online ? "<span class=\"pill ok\">online</span> " : "<span class=\"pill down\">offline</span> ") +
        (paused ? "<span class=\"pill paused\">paused</span>" : "") +
        " · <code>" + dev.id + "</code></span>" +
        "<button type=\"button\" class=\"btn secondary btn-pause\" data-id=\"" + dev.id +
        "\" data-pause=\"" + (paused ? "0" : "1") + "\">" +
        (paused ? "Unpause" : "Pause") + "</button></div>"
      );
    }).join("");
    el.querySelectorAll(".btn-pause").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        const id = btn.getAttribute("data-id");
        const pause = btn.getAttribute("data-pause") === "1";
        const path = "/api/v1/me/home/devices/" + encodeURIComponent(id) +
          (pause ? "/pause" : "/unpause");
        $("devMsg").textContent = "…";
        const res = await jfetch(path, { method: "POST" });
        $("devMsg").textContent = res.status + " " + (res.json && res.json.ok ? "ok" : JSON.stringify(res.json));
        await loadDevices();
      });
    });
  }

  function paintWifi(d) {
    const st = $("wifiStatus");
    if (!d || !d.ok) {
      st.textContent = "Wi‑Fi status unavailable";
      return;
    }
    const p = d.primary || {};
    const g = d.guest || {};
    st.innerHTML =
      "Primary <strong>" + (p.ssid || "—") + "</strong>" +
      (p.passphrase_set ? " (passphrase set)" : "") +
      " · Guest " + (g.enabled ? "on" : "off") +
      (g.ssid ? " · " + g.ssid : "");
    if (p.ssid) $("primarySsid").value = p.ssid;
    if (g.ssid) $("guestSsid").value = g.ssid;
    $("guestEn").checked = !!g.enabled;
  }

  async function loadDevices() {
    const res = await jfetch("/api/v1/me/home/devices");
    paintDevices(res.json);
  }

  async function boot() {
    const me = await jfetch("/auth/me");
    if (!me.ok) {
      location.href = "/portal/";
      return;
    }
    const sum = await jfetch("/api/v1/me/home");
    paintSummary(sum.json);
    await loadDevices();
    const wifi = await jfetch("/api/v1/me/home/wifi");
    paintWifi(wifi.json);

    $("primaryForm").addEventListener("submit", async function (e) {
      e.preventDefault();
      const body = { ssid: $("primarySsid").value };
      const psk = $("primaryPsk").value;
      if (psk) body.passphrase = psk;
      $("wifiMsg").textContent = "Saving…";
      const res = await jfetch("/api/v1/me/home/wifi/primary", {
        method: "PUT",
        body: body
      });
      $("wifiMsg").textContent = res.status + " " +
        (res.json && res.json.ok ? "primary saved" : JSON.stringify(res.json));
      $("primaryPsk").value = "";
      const wifi2 = await jfetch("/api/v1/me/home/wifi");
      paintWifi(wifi2.json);
      const sum2 = await jfetch("/api/v1/me/home");
      paintSummary(sum2.json);
    });

    $("guestForm").addEventListener("submit", async function (e) {
      e.preventDefault();
      const body = {
        enabled: $("guestEn").checked,
        ssid: $("guestSsid").value
      };
      const psk = $("guestPsk").value;
      if (psk) body.passphrase = psk;
      $("wifiMsg").textContent = "Saving guest…";
      const res = await jfetch("/api/v1/me/home/wifi/guest", {
        method: "PUT",
        body: body
      });
      $("wifiMsg").textContent = res.status + " " +
        (res.json && res.json.ok ? "guest saved" : JSON.stringify(res.json));
      $("guestPsk").value = "";
      const wifi2 = await jfetch("/api/v1/me/home/wifi");
      paintWifi(wifi2.json);
    });
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
