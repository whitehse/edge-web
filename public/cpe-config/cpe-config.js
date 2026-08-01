/**
 * CPE configuration SPA — help-desk load / edit / safe-apply over TR-369.
 *
 * Safe apply = Apply (uci set) + CommitConfirmed (snapshot + commit + timer).
 * Confirm keeps; Rollback / timeout / lost callhome reverts on the agent.
 */
(function () {
  "use strict";

  var state = {
    routerId: "",
    model: null,
    packages: {},
    wifi: [],
    firewall: [],
    access: { hostname: "", passAuth: "", rootPassAuth: "", sections: {} },
    network: { lanIp: "", lanMask: "", lanSection: "" },
    baseline: null,
    dirty: {},
    busy: false,
    confirmTimer: 0,
    pollTimer: 0
  };

  function $(id) {
    return document.getElementById(id);
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function http(url, opts) {
    if (typeof window.edgehostFetch === "function") {
      return window.edgehostFetch(url, opts);
    }
    return fetch(url, Object.assign({ credentials: "same-origin" }, opts || {})).then(
      function (r) {
        return r.text().then(function (body) {
          return { status: r.status, body: body, ok: r.ok };
        });
      }
    );
  }

  function parseJson(r) {
    var j = null;
    try {
      j = JSON.parse(r && r.body != null ? r.body : "");
    } catch (e) {
      j = { ok: false, err: "bad json" };
    }
    if (!j || typeof j !== "object") j = { ok: false, err: "bad json" };
    j._http = r ? r.status : 0;
    return j;
  }

  function setStatus(st, msg) {
    var el = $("cfgStatus");
    if (!el) return;
    el.textContent = msg || st || "";
    el.setAttribute("data-st", st || "idle");
  }

  function routerId() {
    var el = $("filterRouter");
    return el && el.value ? String(el.value).trim() : "";
  }

  /* ── UCI text parser (minimal OpenWrt config dialect) ───── */

  function parseUci(text) {
    var sections = [];
    var cur = null;
    var lines = String(text || "").split(/\r?\n/);
    var i;
    for (i = 0; i < lines.length; i++) {
      var line = lines[i].replace(/^\s+/, "").replace(/\s+$/, "");
      if (!line || line.charAt(0) === "#") continue;
      var m = line.match(/^config\s+(\S+)(?:\s+'([^']*)'|\s+"([^"]*)"|\s+(\S+))?/);
      if (m) {
        cur = {
          type: m[1],
          name: m[2] || m[3] || m[4] || "",
          options: {},
          lists: {}
        };
        sections.push(cur);
        continue;
      }
      if (!cur) continue;
      m = line.match(/^option\s+(\S+)\s+'([^']*)'/);
      if (!m) m = line.match(/^option\s+(\S+)\s+"([^"]*)"/);
      if (!m) m = line.match(/^option\s+(\S+)\s+(\S+)/);
      if (m) {
        cur.options[m[1]] = m[2];
        continue;
      }
      m = line.match(/^list\s+(\S+)\s+'([^']*)'/);
      if (!m) m = line.match(/^list\s+(\S+)\s+"([^"]*)"/);
      if (!m) m = line.match(/^list\s+(\S+)\s+(\S+)/);
      if (m) {
        if (!cur.lists[m[1]]) cur.lists[m[1]] = [];
        cur.lists[m[1]].push(m[2]);
      }
    }
    return sections;
  }

  function sectionRef(sec, indexByType) {
    /* UCI @type[n] counts all sections of that type (named or not). */
    var t = sec.type;
    var n = indexByType[t] || 0;
    indexByType[t] = n + 1;
    if (sec.name) return sec.name;
    return "@" + t + "[" + n + "]";
  }

  function buildWifiModel(wirelessText) {
    var sections = parseUci(wirelessText);
    var devices = {};
    var ifaces = [];
    var idx = {};
    var i;
    for (i = 0; i < sections.length; i++) {
      var s = sections[i];
      var ref = sectionRef(s, idx);
      if (s.type === "wifi-device") {
        devices[ref] = {
          ref: ref,
          channel: s.options.channel || "",
          hwmode: s.options.hwmode || s.options.band || "",
          disabled: s.options.disabled === "1"
        };
      }
      if (s.type === "wifi-iface") {
        ifaces.push({
          ref: ref,
          device: s.options.device || "",
          ssid: s.options.ssid || "",
          key: s.options.key || "",
          encryption: s.options.encryption || "",
          network: s.options.network || "",
          mode: s.options.mode || "ap",
          disabled: s.options.disabled === "1",
          hidden: s.options.hidden === "1"
        });
      }
    }
    return { devices: devices, ifaces: ifaces };
  }

  function buildFirewallModel(fwText) {
    var sections = parseUci(fwText);
    var rules = [];
    var idx = {};
    var i;
    for (i = 0; i < sections.length; i++) {
      var s = sections[i];
      if (s.type !== "rule") continue;
      var ref = sectionRef(s, idx);
      rules.push({
        ref: ref,
        name: s.options.name || ref,
        src: s.options.src || "",
        dest: s.options.dest || "",
        dest_port: s.options.dest_port || s.options.port || "",
        proto: s.options.proto || "",
        target: s.options.target || "",
        enabled: s.options.enabled !== "0"
      });
    }
    return rules;
  }

  function buildAccessModel(systemText, dropbearText) {
    var sys = parseUci(systemText);
    var db = parseUci(dropbearText);
    var hostname = "";
    var sysRef = "";
    var passAuth = "";
    var rootPassAuth = "";
    var dbRef = "";
    var idx = {};
    var i;
    for (i = 0; i < sys.length; i++) {
      if (sys[i].type === "system") {
        sysRef = sectionRef(sys[i], idx);
        hostname = sys[i].options.hostname || "";
        break;
      }
    }
    idx = {};
    for (i = 0; i < db.length; i++) {
      if (db[i].type === "dropbear") {
        dbRef = sectionRef(db[i], idx);
        passAuth = db[i].options.PasswordAuth || "";
        rootPassAuth = db[i].options.RootPasswordAuth || "";
        break;
      }
    }
    return {
      hostname: hostname,
      sysRef: sysRef,
      passAuth: passAuth,
      rootPassAuth: rootPassAuth,
      dbRef: dbRef
    };
  }

  function buildNetworkModel(netText) {
    var sections = parseUci(netText);
    var idx = {};
    var i;
    for (i = 0; i < sections.length; i++) {
      var s = sections[i];
      var ref = sectionRef(s, idx);
      if (s.type === "interface" && (ref === "lan" || s.name === "lan")) {
        return {
          lanSection: ref,
          lanIp: s.options.ipaddr || "",
          lanMask: s.options.netmask || ""
        };
      }
    }
    return { lanSection: "lan", lanIp: "", lanMask: "" };
  }

  /* ── Render ─────────────────────────────────────────────── */

  function renderDeviceStrip(model) {
    var di = (model && model.device_info) || {};
    var strip = $("deviceStrip");
    if (strip) strip.hidden = false;
    if ($("devSerial")) {
      $("devSerial").textContent = di.SerialNumber || state.routerId || "—";
    }
    if ($("devModel")) {
      $("devModel").textContent =
        [di.Manufacturer, di.ModelName].filter(Boolean).join(" ") || "—";
    }
    if ($("devSw")) {
      $("devSw").textContent = di.SoftwareVersion || "—";
    }
  }

  function setCommitPill(status) {
    var el = $("devCommit");
    if (!el) return;
    el.textContent = "commit: " + (status || "idle");
    el.setAttribute("data-st", status || "idle");
  }

  function renderWifi() {
    var wrap = $("wifiList");
    var empty = $("wifiEmpty");
    if (!wrap) return;
    var html = "";
    var i;
    for (i = 0; i < state.wifi.length; i++) {
      var w = state.wifi[i];
      var dev = state.wifiDevices[w.device] || {};
      var band = dev.hwmode || w.device || "";
      html +=
        '<div class="cfg-wifi-card" data-ref="' +
        esc(w.ref) +
        '">' +
        "<h3>" +
        esc(w.ssid || w.ref) +
        ' <span class="cfg-band">' +
        esc(band) +
        (w.mode && w.mode !== "ap" ? " · " + esc(w.mode) : "") +
        "</span></h3>" +
        '<div class="cfg-wifi-fields">' +
        "<label>Network name (SSID)" +
        '<input type="text" data-k="ssid" data-ref="' +
        esc(w.ref) +
        '" value="' +
        esc(w.ssid) +
        '"/>' +
        "</label>" +
        "<label>Password (leave blank to keep)" +
        '<input type="password" data-k="key" data-ref="' +
        esc(w.ref) +
        '" value="" placeholder="••••••••" autocomplete="new-password"/>' +
        "</label>" +
        "<label>Enabled" +
        '<select data-k="enabled" data-ref="' +
        esc(w.ref) +
        '">' +
        '<option value="1"' +
        (!w.disabled ? " selected" : "") +
        ">On</option>" +
        '<option value="0"' +
        (w.disabled ? " selected" : "") +
        ">Off</option>" +
        "</select></label>" +
        "<label>Encryption" +
        '<select data-k="encryption" data-ref="' +
        esc(w.ref) +
        '">' +
        optEnc(w.encryption) +
        "</select></label>" +
        "</div></div>";
    }
    wrap.innerHTML = html;
    if (empty) empty.hidden = state.wifi.length > 0;
    bindDirtyInputs(wrap);
  }

  function optEnc(cur) {
    var opts = [
      ["", "— keep —"],
      ["psk2", "WPA2-PSK (recommended)"],
      ["sae", "WPA3-SAE"],
      ["sae-mixed", "WPA2/WPA3 mixed"],
      ["psk-mixed", "WPA/WPA2 mixed"],
      ["none", "Open (no password)"]
    ];
    var h = "";
    var i;
    var found = false;
    for (i = 0; i < opts.length; i++) {
      var sel = opts[i][0] && opts[i][0] === cur;
      if (sel) found = true;
      h +=
        '<option value="' +
        esc(opts[i][0]) +
        '"' +
        (sel ? " selected" : "") +
        ">" +
        esc(opts[i][1]) +
        "</option>";
    }
    if (cur && !found) {
      h =
        '<option value="' +
        esc(cur) +
        '" selected>' +
        esc(cur) +
        "</option>" +
        h;
    }
    return h;
  }

  function renderFirewall() {
    var body = $("fwBody");
    if (!body) return;
    var rows = "";
    var i;
    for (i = 0; i < state.firewall.length; i++) {
      var r = state.firewall[i];
      rows +=
        "<tr data-ref=\"" +
        esc(r.ref) +
        '"><td>' +
        esc(r.name) +
        "</td><td>" +
        esc(r.src || "—") +
        "</td><td>" +
        esc(r.dest || "—") +
        "</td><td>" +
        esc(r.dest_port || "—") +
        "</td><td>" +
        esc(r.target || "—") +
        '</td><td><select data-k="fw_en" data-ref="' +
        esc(r.ref) +
        '"><option value="1"' +
        (r.enabled ? " selected" : "") +
        ">Yes</option><option value=\"0\"" +
        (!r.enabled ? " selected" : "") +
        ">No</option></select></td></tr>";
    }
    body.innerHTML =
      rows || '<tr><td colspan="6" class="hint">No named rules found</td></tr>';
    bindDirtyInputs(body);
  }

  function renderAccess() {
    if ($("accHostname")) $("accHostname").value = state.access.hostname || "";
    if ($("accPassAuth")) {
      $("accPassAuth").value =
        state.access.passAuth === "on" || state.access.passAuth === "1"
          ? "on"
          : state.access.passAuth === "off" || state.access.passAuth === "0"
            ? "off"
            : "";
    }
    if ($("accRootPassAuth")) {
      $("accRootPassAuth").value =
        state.access.rootPassAuth === "on" || state.access.rootPassAuth === "1"
          ? "on"
          : state.access.rootPassAuth === "off" ||
              state.access.rootPassAuth === "0"
            ? "off"
            : "";
    }
    bindDirtyInputs($("panel-access"));
  }

  function renderNetwork() {
    if ($("netLanIp")) $("netLanIp").value = state.network.lanIp || "";
    if ($("netLanMask")) $("netLanMask").value = state.network.lanMask || "";
    if ($("netPkgPre")) {
      $("netPkgPre").textContent = state.packages.network || "—";
    }
    bindDirtyInputs($("panel-network"));
  }

  function renderAdvanced() {
    var wrap = $("advPackages");
    if (!wrap) return;
    var names = Object.keys(state.packages).sort();
    var html = "";
    var i;
    for (i = 0; i < names.length; i++) {
      var n = names[i];
      var t = state.packages[n] || "";
      html +=
        "<details><summary><code>" +
        esc(n) +
        "</code> <span class=\"hint\">" +
        t.length +
        " B</span></summary><pre class=\"cfg-pre\">" +
        esc(t) +
        "</pre></details>";
    }
    wrap.innerHTML = html || '<p class="hint">No packages</p>';
  }

  function bindDirtyInputs(root) {
    if (!root) return;
    var nodes = root.querySelectorAll("input, select");
    var i;
    for (i = 0; i < nodes.length; i++) {
      nodes[i].addEventListener("input", onFieldEdit);
      nodes[i].addEventListener("change", onFieldEdit);
    }
  }

  function onFieldEdit(ev) {
    var el = ev.target;
    if (!el) return;
    var k = el.getAttribute("data-k");
    var ref = el.getAttribute("data-ref");
    var key;
    if (k && ref) {
      key = k + ":" + ref;
    } else if (el.id) {
      key = "id:" + el.id;
    } else {
      return;
    }
    state.dirty[key] = el.value;
    el.classList.add("cfg-dirty");
    updateChangeBar();
  }

  function countDirty() {
    return Object.keys(state.dirty).length;
  }

  function updateChangeBar() {
    var n = countDirty();
    if ($("changeSummary")) {
      $("changeSummary").textContent =
        n === 0
          ? "No edits yet"
          : n + " change" + (n === 1 ? "" : "s") + " ready";
    }
    if ($("changeHint")) {
      $("changeHint").textContent =
        n === 0
          ? "Edit a field above, then review and apply."
          : "Review the list, then apply with the safety timer.";
    }
    if ($("btnReview")) $("btnReview").disabled = n === 0 || state.busy;
    if ($("btnDiscard")) $("btnDiscard").disabled = n === 0 || state.busy;
  }

  /* ── Collect Apply lines ────────────────────────────────── */

  function collectChanges() {
    var changes = [];
    var keys = Object.keys(state.dirty);
    var i;
    for (i = 0; i < keys.length; i++) {
      var key = keys[i];
      var val = state.dirty[key];
      var parts = key.split(":");
      var kind = parts[0];
      var ref = parts.slice(1).join(":");

      if (kind === "ssid" || kind === "key" || kind === "encryption" ||
          kind === "enabled") {
        var iface = null;
        var j;
        for (j = 0; j < state.wifi.length; j++) {
          if (state.wifi[j].ref === ref) {
            iface = state.wifi[j];
            break;
          }
        }
        if (!iface) continue;
        if (kind === "ssid" && val !== iface.ssid) {
          changes.push({
            label: "Wi‑Fi “" + (iface.ssid || ref) + "” name → " + val,
            apply: "wireless." + ref + ".ssid=" + val
          });
        }
        if (kind === "key" && val) {
          changes.push({
            label: "Wi‑Fi “" + (iface.ssid || ref) + "” password updated",
            apply: "wireless." + ref + ".key=" + val
          });
        }
        if (kind === "encryption" && val && val !== iface.encryption) {
          changes.push({
            label: "Wi‑Fi “" + (iface.ssid || ref) + "” security → " + val,
            apply: "wireless." + ref + ".encryption=" + val
          });
        }
        if (kind === "enabled") {
          var wantOff = val === "0";
          if (wantOff !== iface.disabled) {
            changes.push({
              label:
                "Wi‑Fi “" +
                (iface.ssid || ref) +
                "” " +
                (wantOff ? "turned off" : "turned on"),
              apply: "wireless." + ref + ".disabled=" + (wantOff ? "1" : "0")
            });
          }
        }
      }

      if (kind === "fw_en") {
        var rule = null;
        for (j = 0; j < state.firewall.length; j++) {
          if (state.firewall[j].ref === ref) {
            rule = state.firewall[j];
            break;
          }
        }
        if (!rule) continue;
        var en = val === "1";
        if (en !== rule.enabled) {
          changes.push({
            label:
              "Firewall “" +
              rule.name +
              "” " +
              (en ? "enabled" : "disabled"),
            apply: "firewall." + ref + ".enabled=" + (en ? "1" : "0")
          });
        }
      }

      if (key === "id:accHostname") {
        if (val !== state.access.hostname && state.access.sysRef) {
          changes.push({
            label: "Hostname → " + val,
            apply: "system." + state.access.sysRef + ".hostname=" + val
          });
        }
      }
      if (key === "id:accPassAuth" && val && state.access.dbRef) {
        changes.push({
          label: "SSH password login → " + val,
          apply: "dropbear." + state.access.dbRef + ".PasswordAuth=" + val
        });
      }
      if (key === "id:accRootPassAuth" && val && state.access.dbRef) {
        changes.push({
          label: "SSH root password login → " + val,
          apply: "dropbear." + state.access.dbRef + ".RootPasswordAuth=" + val
        });
      }
      if (key === "id:netLanIp" && val && val !== state.network.lanIp) {
        changes.push({
          label: "LAN IP → " + val,
          apply: "network." + state.network.lanSection + ".ipaddr=" + val
        });
      }
      if (key === "id:netLanMask" && val && val !== state.network.lanMask) {
        changes.push({
          label: "LAN netmask → " + val,
          apply: "network." + state.network.lanSection + ".netmask=" + val
        });
      }
    }
    return changes;
  }

  /* ── API ────────────────────────────────────────────────── */

  function capture(profile) {
    var rid = routerId();
    if (!rid) {
      setStatus("error", "Enter a router id");
      return Promise.resolve(null);
    }
    var url =
      "/api/v1/cpe/usp/config/capture?router_id=" +
      encodeURIComponent(rid) +
      "&profile=" +
      encodeURIComponent(profile || "all");
    setStatus(
      "pending",
      "Fetching configuration from router (may take up to a minute)…"
    );
    state.busy = true;
    return http(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: profile || "all" })
    })
      .then(function (r) {
        var j = parseJson(r);
        if (r.status === 202 || (j && j.status === "pending")) {
          /* UCI dump can take 30–60s on reverse tunnel (chunked Gets). */
          return pollUntilDone(profile === "commit_status" ? 40 : 300);
        }
        state.busy = false;
        setStatus(
          "error",
          (j && (j.error || j.err || j.hint)) || "HTTP " + r.status
        );
        return null;
      })
      .catch(function (err) {
        state.busy = false;
        setStatus("error", String(err && err.message ? err.message : err));
        return null;
      });
  }

  function pollUntilDone(tries) {
    tries = tries == null ? 180 : tries;
    var rid = routerId();
    var url =
      "/api/v1/cpe/usp/config?router_id=" + encodeURIComponent(rid);
    return http(url, { credentials: "same-origin" }).then(function (r) {
      var j = parseJson(r);
      if (!j) {
        state.busy = false;
        return null;
      }
      if (j.status === "pending" && tries > 0) {
        return new Promise(function (resolve) {
          state.pollTimer = setTimeout(function () {
            resolve(pollUntilDone(tries - 1));
          }, 250);
        });
      }
      state.busy = false;
      if (j.status === "pending") {
        setStatus("error", "Timed out waiting for the router");
        return null;
      }
      if (j.status === "error") {
        setStatus("error", j.err || j.error || "capture error");
        return j;
      }
      return j;
    });
  }

  function uspSet(params) {
    var rid = routerId();
    if (!rid) return Promise.resolve(null);
    var url =
      "/api/v1/cpe/usp/config/set?router_id=" + encodeURIComponent(rid);
    state.busy = true;
    return http(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ params: params })
    })
      .then(function (r) {
        var j = parseJson(r);
        if (r.status === 202 || (j && j.status === "pending")) {
          return pollUntilDone(60);
        }
        state.busy = false;
        return j;
      })
      .catch(function (err) {
        state.busy = false;
        setStatus("error", String(err && err.message ? err.message : err));
        return null;
      });
  }

  function applyModel(j) {
    state.model = (j && j.model) || {};
    state.packages =
      (state.model.openwrt_uci && state.model.openwrt_uci.packages) || {};
    state.routerId = routerId();

    var w = buildWifiModel(state.packages.wireless || "");
    state.wifi = w.ifaces;
    state.wifiDevices = w.devices;
    state.firewall = buildFirewallModel(state.packages.firewall || "");
    state.access = buildAccessModel(
      state.packages.system || "",
      state.packages.dropbear || ""
    );
    state.network = buildNetworkModel(state.packages.network || "");
    state.dirty = {};

    renderDeviceStrip(state.model);
    renderWifi();
    renderFirewall();
    renderAccess();
    renderNetwork();
    renderAdvanced();
    updateChangeBar();

    if ($("cfgMain")) $("cfgMain").hidden = false;
    if ($("btnReload")) $("btnReload").disabled = false;
    setStatus("ok", "Configuration loaded");
    setCommitPill("idle");
  }

  function loadConfig() {
    /* helpdesk = DeviceInfo/Wi‑Fi + wireless/network/firewall/system/… */
    return capture("helpdesk").then(function (j) {
      if (!j || j.status !== "ok") {
        if (j && j.status === "error") {
          setStatus(
            "error",
            (j.err || "Could not load configuration") +
              " — is the router online with USP?"
          );
        }
        return;
      }
      var pkgs =
        j.model && j.model.openwrt_uci && j.model.openwrt_uci.packages;
      if (!pkgs || !Object.keys(pkgs).length) {
        /* Older agent without UCI map — still show DeviceInfo/Wi‑Fi. */
        applyModel(j);
        setStatus(
          "ok",
          "Loaded device/Wi‑Fi only (OpenWrt UCI packages empty)"
        );
        return;
      }
      applyModel(j);
    });
  }

  /* ── Confirm banner / countdown ─────────────────────────── */

  function showConfirmBanner(secs) {
    var ban = $("confirmBanner");
    if (ban) ban.hidden = false;
    setCommitPill("pending_confirm");
    if (state.confirmTimer) clearInterval(state.confirmTimer);
    var left = secs || 120;
    function tick() {
      if ($("confirmCountdown")) {
        var m = Math.floor(left / 60);
        var s = left % 60;
        $("confirmCountdown").textContent =
          m + ":" + (s < 10 ? "0" : "") + s;
      }
      if (left <= 0) {
        clearInterval(state.confirmTimer);
        state.confirmTimer = 0;
        setStatus("error", "Safety timer expired — router may have reverted");
        if (ban) ban.hidden = true;
        setCommitPill("reverted");
        loadConfig();
        return;
      }
      left--;
    }
    tick();
    state.confirmTimer = setInterval(tick, 1000);
    /* Background poll agent commit status */
    pollCommitStatusLoop(secs + 5);
  }

  function hideConfirmBanner() {
    if (state.confirmTimer) {
      clearInterval(state.confirmTimer);
      state.confirmTimer = 0;
    }
    if ($("confirmBanner")) $("confirmBanner").hidden = true;
  }

  function pollCommitStatusLoop(budgetSec) {
    var end = Date.now() + budgetSec * 1000;
    function once() {
      if (Date.now() > end) return;
      capture("commit_status").then(function (j) {
        if (!j || !j.params) {
          setTimeout(once, 4000);
          return;
        }
        var st = "";
        var left = "";
        var reason = "";
        var i;
        for (i = 0; i < j.params.length; i++) {
          var p = j.params[i];
          if (p.path && p.path.indexOf("CommitStatus") >= 0) st = p.value;
          if (p.path && p.path.indexOf("ConfirmRemainingSec") >= 0)
            left = p.value;
          if (p.path && p.path.indexOf("LastRollbackReason") >= 0)
            reason = p.value;
        }
        setCommitPill(st || "idle");
        if (st === "reverted" || st === "error") {
          hideConfirmBanner();
          setStatus(
            "error",
            "Changes were undone" + (reason ? ": " + reason : "")
          );
          loadConfig();
          return;
        }
        if (st === "idle" || st === "candidate") {
          /* confirmed or clean */
          if ($("confirmBanner") && !$("confirmBanner").hidden && st === "idle") {
            hideConfirmBanner();
          }
        }
        if (left && $("confirmCountdown") && st === "pending_confirm") {
          var sec = parseInt(left, 10);
          if (isFinite(sec) && sec >= 0) {
            var m = Math.floor(sec / 60);
            var s = sec % 60;
            $("confirmCountdown").textContent =
              m + ":" + (s < 10 ? "0" : "") + s;
          }
        }
        if (st === "pending_confirm") setTimeout(once, 3000);
      });
    }
    setTimeout(once, 2000);
  }

  function openReview() {
    var changes = collectChanges();
    var list = $("reviewList");
    var modal = $("reviewModal");
    if (!list || !modal) return;
    if (!changes.length) {
      setStatus("error", "No effective changes to apply");
      return;
    }
    list.innerHTML = changes
      .map(function (c) {
        return "<li>" + esc(c.label) + "</li>";
      })
      .join("");
    if ($("reviewStatus")) $("reviewStatus").textContent = "";
    modal.hidden = false;
  }

  function closeReview() {
    if ($("reviewModal")) $("reviewModal").hidden = true;
  }

  function doApplyConfirmed() {
    var changes = collectChanges();
    if (!changes.length) return;
    var secs = ($("confirmSecs") && $("confirmSecs").value) || "120";
    var applyLines = changes
      .map(function (c) {
        return c.apply;
      })
      .join("\n");
    /* Batch into Apply chunks if needed (value limit ~1536). */
    var params = [];
    var chunk = "";
    var lines = applyLines.split("\n");
    var i;
    for (i = 0; i < lines.length; i++) {
      var line = lines[i];
      if ((chunk + "\n" + line).length > 1400) {
        if (chunk) {
          params.push({
            path: "Device.X_ECOEC_OpenWrt.UCI.Apply",
            value: chunk
          });
        }
        chunk = line;
      } else {
        chunk = chunk ? chunk + "\n" + line : line;
      }
    }
    if (chunk) {
      params.push({
        path: "Device.X_ECOEC_OpenWrt.UCI.Apply",
        value: chunk
      });
    }
    params.push({
      path: "Device.X_ECOEC_OpenWrt.UCI.CommitConfirmed",
      value: String(secs)
    });
    if ($("reviewStatus")) {
      $("reviewStatus").textContent = "Applying safely…";
    }
    setStatus("pending", "Applying changes with safety timer…");
    uspSet(params).then(function (j) {
      closeReview();
      if (!j || j.status === "error") {
        setStatus(
          "error",
          (j && (j.err || j.error)) || "Apply failed"
        );
        return;
      }
      /* Check SetResp errors */
      var bad = false;
      if (j.params) {
        var k;
        for (k = 0; k < j.params.length; k++) {
          if (j.params[k].err && j.params[k].err !== 0) {
            bad = true;
            setStatus(
              "error",
              j.params[k].err_msg || "Apply error on router"
            );
            break;
          }
        }
      }
      if (bad) return;
      state.dirty = {};
      updateChangeBar();
      showConfirmBanner(parseInt(secs, 10) || 120);
      setStatus(
        "pending",
        "Changes are live — confirm within the timer or they undo"
      );
    });
  }

  function doConfirm() {
    setStatus("pending", "Confirming changes…");
    uspSet([
      { path: "Device.X_ECOEC_OpenWrt.UCI.Confirm", value: "1" }
    ]).then(function (j) {
      if (j && j.status === "ok") {
        hideConfirmBanner();
        setCommitPill("idle");
        setStatus("ok", "Changes kept");
        loadConfig();
      } else {
        setStatus("error", (j && (j.err || j.error)) || "Confirm failed");
      }
    });
  }

  function doRollback() {
    setStatus("pending", "Undoing changes…");
    uspSet([
      {
        path: "Device.X_ECOEC_OpenWrt.UCI.Rollback",
        value: "operator"
      }
    ]).then(function (j) {
      hideConfirmBanner();
      setCommitPill("reverted");
      setStatus(
        j && j.status === "ok" ? "ok" : "error",
        j && j.status === "ok" ? "Changes undone" : "Rollback failed"
      );
      loadConfig();
    });
  }

  function discardEdits() {
    state.dirty = {};
    renderWifi();
    renderFirewall();
    renderAccess();
    renderNetwork();
    updateChangeBar();
    setStatus("ok", "Edits discarded");
  }

  /* ── Tabs ───────────────────────────────────────────────── */

  function switchTab(id) {
    var tabs = document.querySelectorAll(".cfg-tab");
    var i;
    for (i = 0; i < tabs.length; i++) {
      var t = tabs[i];
      var on = t.getAttribute("data-tab") === id;
      t.classList.toggle("active", on);
    }
    var panels = ["wifi", "firewall", "access", "network", "advanced"];
    for (i = 0; i < panels.length; i++) {
      var p = $("panel-" + panels[i]);
      if (p) {
        p.hidden = panels[i] !== id;
        p.classList.toggle("active", panels[i] === id);
      }
    }
  }

  /* ── Boot ───────────────────────────────────────────────── */

  function bootLive() {
    if (window.EdgeContext && EdgeContext.get) {
      var c = EdgeContext.get();
      if (c && c.router_id && $("filterRouter")) {
        $("filterRouter").value = c.router_id;
      }
    }
    if ($("filterRouter")) {
      $("filterRouter").addEventListener("change", function () {
        if (window.EdgeContext && EdgeContext.setRouter) {
          EdgeContext.setRouter($("filterRouter").value, { source: "user" });
        }
        if ($("openShellLink")) {
          $("openShellLink").href =
            "/terminal/?router_id=" +
            encodeURIComponent(routerId() || "cpe-lab") +
            (routerId() ? "&auto=1" : "");
        }
        if ($("openHostLink")) {
          $("openHostLink").href =
            "/host/?router_id=" + encodeURIComponent(routerId() || "");
        }
      });
    }
    if ($("btnLoad")) $("btnLoad").addEventListener("click", loadConfig);
    if ($("btnReload")) $("btnReload").addEventListener("click", loadConfig);
    if ($("btnReview")) $("btnReview").addEventListener("click", openReview);
    if ($("btnDiscard")) $("btnDiscard").addEventListener("click", discardEdits);
    if ($("btnReviewCancel"))
      $("btnReviewCancel").addEventListener("click", closeReview);
    if ($("btnApplyConfirmed"))
      $("btnApplyConfirmed").addEventListener("click", doApplyConfirmed);
    if ($("btnConfirm")) $("btnConfirm").addEventListener("click", doConfirm);
    if ($("btnRollback")) $("btnRollback").addEventListener("click", doRollback);

    var tabs = document.querySelectorAll(".cfg-tab");
    var i;
    for (i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener("click", function (ev) {
        switchTab(ev.currentTarget.getAttribute("data-tab"));
      });
    }

    if (window.EdgeContext && EdgeContext.onChange) {
      EdgeContext.onChange(function (ctx) {
        if (ctx && ctx.router_id && $("filterRouter")) {
          $("filterRouter").value = ctx.router_id;
        }
      });
    }

    /* Deep link ?router_id= */
    try {
      var q = new URLSearchParams(location.search);
      var rid = q.get("router_id");
      if (rid && $("filterRouter")) $("filterRouter").value = rid;
    } catch (e) {
      /* ignore */
    }
    if (routerId()) {
      if ($("openShellLink")) {
        $("openShellLink").href =
          "/terminal/?router_id=" + encodeURIComponent(routerId()) + "&auto=1";
      }
    }
  }

  function boot() {
    if (window.EdgeShell && EdgeShell.requireAuth) {
      EdgeShell.requireAuth().then(function (ok) {
        if (ok) bootLive();
      });
    } else {
      fetch("/auth/me", { credentials: "same-origin" })
        .then(function (r) {
          if (r.ok) bootLive();
          else
            location.replace(
              "/?next=" + encodeURIComponent("/cpe-config/")
            );
        })
        .catch(function () {
          location.replace(
            "/?next=" + encodeURIComponent("/cpe-config/")
          );
        });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
