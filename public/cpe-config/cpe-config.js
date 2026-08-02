/**
 * CPE configuration SPA — full OpenWrt/prplOS load / edit / safe-apply over TR-369.
 *
 * Safe apply = Apply (uci set/add/delete/list) + CommitConfirmed (snapshot + timer).
 * Confirm keeps; Rollback / timeout / lost callhome reverts on the agent.
 */
(function () {
  "use strict";

  var state = {
    routerId: "",
    model: null,
    packages: {},
    wifi: [],
    wifiDevices: {},
    fw: {
      defaults: null,
      defaultsRef: "",
      zones: [],
      rules: [],
      redirects: [],
      helpers: [],
      forwardings: []
    },
    access: {
      hostname: "",
      timezone: "",
      zonename: "",
      sysRef: "",
      passAuth: "",
      rootPassAuth: "",
      sshPort: "",
      gwPorts: "",
      sshIface: "",
      dbRef: ""
    },
    users: [],
    sysUsers: [],
    network: { interfaces: [] },
    dhcp: { pools: [], hosts: [], dnsmasq: null, dnsmasqRef: "" },
    algServices: {},
    dirty: {},
    newSeq: 0,
    busy: false,
    confirmTimer: 0,
    pollTimer: 0
  };

  var TAB_IDS = ["wifi", "firewall", "alg", "access", "network", "advanced"];

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

  function nextNewName(prefix) {
    state.newSeq += 1;
    return prefix + "_" + Date.now().toString(36) + "_" + state.newSeq;
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
    var t = sec.type;
    var n = indexByType[t] || 0;
    indexByType[t] = n + 1;
    if (sec.name) return sec.name;
    return "@" + t + "[" + n + "]";
  }

  function opt(sec, key, def) {
    if (!sec || !sec.options) return def || "";
    var v = sec.options[key];
    return v == null || v === "" ? def || "" : v;
  }

  function listJoin(sec, key) {
    if (!sec || !sec.lists || !sec.lists[key]) return "";
    return sec.lists[key].join(" ");
  }

  /* ── Model builders ─────────────────────────────────────── */

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
          channel: opt(s, "channel"),
          hwmode: opt(s, "hwmode") || opt(s, "band"),
          htmode: opt(s, "htmode"),
          country: opt(s, "country"),
          txpower: opt(s, "txpower"),
          disabled: opt(s, "disabled") === "1"
        };
      }
      if (s.type === "wifi-iface") {
        ifaces.push({
          ref: ref,
          device: opt(s, "device"),
          ssid: opt(s, "ssid"),
          key: opt(s, "key"),
          encryption: opt(s, "encryption"),
          network: opt(s, "network"),
          mode: opt(s, "mode", "ap"),
          disabled: opt(s, "disabled") === "1",
          hidden: opt(s, "hidden") === "1",
          isolate: opt(s, "isolate") === "1",
          wmm: opt(s, "wmm")
        });
      }
    }
    return { devices: devices, ifaces: ifaces };
  }

  function buildFirewallModel(fwText) {
    var sections = parseUci(fwText);
    var out = {
      defaults: null,
      defaultsRef: "",
      zones: [],
      rules: [],
      redirects: [],
      helpers: [],
      forwardings: []
    };
    var idx = {};
    var i;
    for (i = 0; i < sections.length; i++) {
      var s = sections[i];
      var ref = sectionRef(s, idx);
      if (s.type === "defaults") {
        out.defaultsRef = ref;
        out.defaults = {
          ref: ref,
          input: opt(s, "input", "REJECT"),
          output: opt(s, "output", "ACCEPT"),
          forward: opt(s, "forward", "REJECT"),
          synflood_protect: opt(s, "synflood_protect", "1"),
          drop_invalid: opt(s, "drop_invalid"),
          auto_helper: opt(s, "auto_helper", "1"),
          flow_offloading: opt(s, "flow_offloading"),
          flow_offloading_hw: opt(s, "flow_offloading_hw")
        };
      } else if (s.type === "zone") {
        out.zones.push({
          ref: ref,
          name: opt(s, "name", ref),
          input: opt(s, "input"),
          output: opt(s, "output"),
          forward: opt(s, "forward"),
          masq: opt(s, "masq") === "1",
          mtu_fix: opt(s, "mtu_fix") === "1",
          network: listJoin(s, "network") || opt(s, "network"),
          auto_helper: opt(s, "auto_helper"),
          helper: listJoin(s, "helper")
        });
      } else if (s.type === "rule") {
        out.rules.push({
          ref: ref,
          name: opt(s, "name", ref),
          src: opt(s, "src"),
          dest: opt(s, "dest"),
          dest_port: opt(s, "dest_port") || opt(s, "port"),
          src_port: opt(s, "src_port"),
          src_ip: opt(s, "src_ip"),
          dest_ip: opt(s, "dest_ip"),
          proto: opt(s, "proto"),
          family: opt(s, "family"),
          target: opt(s, "target"),
          enabled: opt(s, "enabled") !== "0",
          extra: opt(s, "extra"),
          isNew: false
        });
      } else if (s.type === "redirect") {
        out.redirects.push({
          ref: ref,
          name: opt(s, "name", ref),
          src: opt(s, "src"),
          src_dport: opt(s, "src_dport"),
          dest: opt(s, "dest"),
          dest_ip: opt(s, "dest_ip"),
          dest_port: opt(s, "dest_port"),
          proto: opt(s, "proto"),
          target: opt(s, "target", "DNAT"),
          enabled: opt(s, "enabled") !== "0",
          reflection: opt(s, "reflection"),
          isNew: false
        });
      } else if (s.type === "helper") {
        out.helpers.push({
          ref: ref,
          name: opt(s, "name", ref),
          module: opt(s, "module"),
          family: opt(s, "family"),
          proto: opt(s, "proto"),
          port: opt(s, "port"),
          enabled: opt(s, "enabled") !== "0"
        });
      } else if (s.type === "forwarding") {
        out.forwardings.push({
          ref: ref,
          src: opt(s, "src"),
          dest: opt(s, "dest")
        });
      }
    }
    return out;
  }

  function buildAccessModel(systemText, dropbearText) {
    var sys = parseUci(systemText);
    var db = parseUci(dropbearText);
    var o = {
      hostname: "",
      timezone: "",
      zonename: "",
      sysRef: "",
      passAuth: "",
      rootPassAuth: "",
      sshPort: "",
      gwPorts: "",
      sshIface: "",
      dbRef: ""
    };
    var idx = {};
    var i;
    for (i = 0; i < sys.length; i++) {
      if (sys[i].type === "system") {
        o.sysRef = sectionRef(sys[i], idx);
        o.hostname = opt(sys[i], "hostname");
        o.timezone = opt(sys[i], "timezone");
        o.zonename = opt(sys[i], "zonename");
        break;
      }
    }
    idx = {};
    for (i = 0; i < db.length; i++) {
      if (db[i].type === "dropbear") {
        o.dbRef = sectionRef(db[i], idx);
        o.passAuth = opt(db[i], "PasswordAuth");
        o.rootPassAuth = opt(db[i], "RootPasswordAuth");
        o.sshPort = opt(db[i], "Port");
        o.gwPorts = opt(db[i], "GatewayPorts");
        o.sshIface = opt(db[i], "Interface");
        break;
      }
    }
    return o;
  }

  function buildUsersModel(rpcdText, usersText) {
    var rpcd = parseUci(rpcdText);
    var users = parseUci(usersText);
    var list = [];
    var sysUsers = [];
    var idx = {};
    var i;
    for (i = 0; i < rpcd.length; i++) {
      if (rpcd[i].type !== "login") continue;
      var ref = sectionRef(rpcd[i], idx);
      list.push({
        ref: ref,
        username: opt(rpcd[i], "username"),
        password: opt(rpcd[i], "password"),
        read: listJoin(rpcd[i], "read"),
        write: listJoin(rpcd[i], "write"),
        isNew: false
      });
    }
    idx = {};
    for (i = 0; i < users.length; i++) {
      var s = users[i];
      var r = sectionRef(s, idx);
      sysUsers.push({
        ref: r,
        type: s.type,
        name: opt(s, "name") || opt(s, "username") || r,
        options: s.options,
        lists: s.lists
      });
    }
    return { rpcd: list, sysUsers: sysUsers };
  }

  function buildNetworkModel(netText) {
    var sections = parseUci(netText);
    var ifaces = [];
    var idx = {};
    var i;
    for (i = 0; i < sections.length; i++) {
      var s = sections[i];
      if (s.type !== "interface") continue;
      var ref = sectionRef(s, idx);
      ifaces.push({
        ref: ref,
        proto: opt(s, "proto"),
        device: opt(s, "device") || opt(s, "ifname"),
        ipaddr: opt(s, "ipaddr"),
        netmask: opt(s, "netmask"),
        gateway: opt(s, "gateway"),
        dns: listJoin(s, "dns") || opt(s, "dns"),
        disabled: opt(s, "disabled") === "1",
        type: opt(s, "type"),
        metric: opt(s, "metric")
      });
    }
    return { interfaces: ifaces };
  }

  function buildDhcpModel(dhcpText) {
    var sections = parseUci(dhcpText);
    var pools = [];
    var hosts = [];
    var dnsmasq = null;
    var dnsmasqRef = "";
    var idx = {};
    var i;
    for (i = 0; i < sections.length; i++) {
      var s = sections[i];
      var ref = sectionRef(s, idx);
      if (s.type === "dnsmasq") {
        dnsmasqRef = ref;
        dnsmasq = {
          ref: ref,
          domainneeded: opt(s, "domainneeded"),
          localise_queries: opt(s, "localise_queries"),
          rebind_protection: opt(s, "rebind_protection"),
          localservice: opt(s, "localservice"),
          domain: opt(s, "domain"),
          authoritative: opt(s, "authoritative"),
          readethers: opt(s, "readethers"),
          leasefile: opt(s, "leasefile"),
          resolvfile: opt(s, "resolvfile"),
          nonwildcard: opt(s, "nonwildcard"),
          localservice_only: opt(s, "localservice")
        };
      } else if (s.type === "dhcp") {
        pools.push({
          ref: ref,
          interface: opt(s, "interface", ref),
          start: opt(s, "start"),
          limit: opt(s, "limit"),
          leasetime: opt(s, "leasetime"),
          ignore: opt(s, "ignore") === "1",
          force: opt(s, "force") === "1",
          dhcpv4: opt(s, "dhcpv4"),
          dhcpv6: opt(s, "dhcpv6"),
          ra: opt(s, "ra")
        });
      } else if (s.type === "host") {
        hosts.push({
          ref: ref,
          name: opt(s, "name"),
          mac: opt(s, "mac"),
          ip: opt(s, "ip"),
          hostid: opt(s, "hostid") || opt(s, "duid"),
          enabled: opt(s, "enabled") !== "0",
          isNew: false
        });
      }
    }
    return {
      pools: pools,
      hosts: hosts,
      dnsmasq: dnsmasq,
      dnsmasqRef: dnsmasqRef
    };
  }

  function buildAlgServices(packages) {
    var svc = {};
    var upnp = packages.upnpd || packages.miniupnpd || "";
    if (upnp) {
      var secs = parseUci(upnp);
      var i;
      for (i = 0; i < secs.length; i++) {
        if (secs[i].type === "upnpd" || secs[i].type === "config") {
          svc.upnp_enabled = opt(secs[i], "enabled", "1");
          svc.upnp_ref = sectionRef(secs[i], {});
          svc.upnp_pkg = packages.upnpd ? "upnpd" : "miniupnpd";
          break;
        }
      }
    }
    return svc;
  }

  /* ── Dirty tracking ─────────────────────────────────────── */

  function dirtyKey(kind, ref, field) {
    return kind + ":" + ref + ":" + field;
  }

  function setDirty(key, val, el) {
    state.dirty[key] = val;
    if (el) el.classList.add("cfg-dirty");
    updateChangeBar();
  }

  function onFieldEdit(ev) {
    var el = ev.target;
    if (!el) return;
    var k = el.getAttribute("data-k");
    var ref = el.getAttribute("data-ref");
    var kind = el.getAttribute("data-kind");
    var field = el.getAttribute("data-field");
    var key;
    if (kind && ref != null && field) {
      key = dirtyKey(kind, ref, field);
    } else if (k && ref != null) {
      key = k + ":" + ref;
    } else if (el.id) {
      key = "id:" + el.id;
    } else if (el.getAttribute("data-k-id")) {
      key = "id:" + el.getAttribute("data-k-id");
    } else {
      return;
    }
    var val = el.type === "checkbox" ? (el.checked ? "1" : "0") : el.value;
    setDirty(key, val, el);
  }

  function bindDirtyInputs(root) {
    if (!root) return;
    var nodes = root.querySelectorAll("input, select, textarea");
    var i;
    for (i = 0; i < nodes.length; i++) {
      nodes[i].removeEventListener("input", onFieldEdit);
      nodes[i].removeEventListener("change", onFieldEdit);
      nodes[i].addEventListener("input", onFieldEdit);
      nodes[i].addEventListener("change", onFieldEdit);
    }
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

  /* ── Render helpers ─────────────────────────────────────── */

  function selBool(cur, trueVal, falseVal) {
    trueVal = trueVal == null ? "1" : trueVal;
    falseVal = falseVal == null ? "0" : falseVal;
    var on =
      cur === true ||
      cur === trueVal ||
      cur === "on" ||
      cur === "1" ||
      cur === "yes";
    return (
      '<option value="' +
      esc(trueVal) +
      '"' +
      (on ? " selected" : "") +
      ">Yes</option>" +
      '<option value="' +
      esc(falseVal) +
      '"' +
      (!on ? " selected" : "") +
      ">No</option>"
    );
  }

  function inputCell(kind, ref, field, val, opts) {
    opts = opts || {};
    var type = opts.type || "text";
    var ph = opts.placeholder || "";
    var cls = opts.cls || "";
    if (type === "select") {
      return (
        '<select data-kind="' +
        esc(kind) +
        '" data-ref="' +
        esc(ref) +
        '" data-field="' +
        esc(field) +
        '"' +
        (cls ? ' class="' + esc(cls) + '"' : "") +
        ">" +
        (opts.optionsHtml || "") +
        "</select>"
      );
    }
    return (
      '<input type="' +
      esc(type) +
      '" data-kind="' +
      esc(kind) +
      '" data-ref="' +
      esc(ref) +
      '" data-field="' +
      esc(field) +
      '" value="' +
      esc(val) +
      '"' +
      (ph ? ' placeholder="' + esc(ph) + '"' : "") +
      (cls ? ' class="' + esc(cls) + '"' : "") +
      "/>"
    );
  }

  function policyOpts(cur) {
    var opts = ["", "ACCEPT", "REJECT", "DROP", "NOTRACK"];
    var h = "";
    var i;
    var found = false;
    for (i = 0; i < opts.length; i++) {
      var lab = opts[i] || "—";
      var sel = opts[i] === cur;
      if (sel) found = true;
      h +=
        '<option value="' +
        esc(opts[i]) +
        '"' +
        (sel ? " selected" : "") +
        ">" +
        esc(lab) +
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

  function protoOpts(cur) {
    var opts = [
      ["", "—"],
      ["all", "all"],
      ["tcp", "tcp"],
      ["udp", "udp"],
      ["tcp udp", "tcp+udp"],
      ["icmp", "icmp"],
      ["igmp", "igmp"]
    ];
    var h = "";
    var i;
    var found = false;
    for (i = 0; i < opts.length; i++) {
      var sel = opts[i][0] === cur;
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

  /* ── Render panels ──────────────────────────────────────── */

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
    if ($("devPkgs")) {
      $("devPkgs").textContent =
        "packages: " + Object.keys(state.packages).length;
    }
  }

  function setCommitPill(status) {
    var el = $("devCommit");
    if (!el) return;
    el.textContent = "commit: " + (status || "idle");
    el.setAttribute("data-st", status || "idle");
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
        inputCell("wifi", w.ref, "ssid", w.ssid) +
        "</label>" +
        "<label>Password (leave blank to keep)" +
        inputCell("wifi", w.ref, "key", "", {
          type: "password",
          placeholder: "••••••••"
        }) +
        "</label>" +
        "<label>Enabled" +
        inputCell("wifi", w.ref, "enabled", "", {
          type: "select",
          optionsHtml: selBool(!w.disabled, "1", "0")
        }) +
        "</label>" +
        "<label>Encryption" +
        inputCell("wifi", w.ref, "encryption", w.encryption, {
          type: "select",
          optionsHtml: optEnc(w.encryption)
        }) +
        "</label>" +
        "<label>Hide SSID" +
        inputCell("wifi", w.ref, "hidden", "", {
          type: "select",
          optionsHtml: selBool(w.hidden, "1", "0")
        }) +
        "</label>" +
        "<label>Client isolation" +
        inputCell("wifi", w.ref, "isolate", "", {
          type: "select",
          optionsHtml: selBool(w.isolate, "1", "0")
        }) +
        "</label>" +
        "<label>Network (bridge)" +
        inputCell("wifi", w.ref, "network", w.network) +
        "</label>" +
        (dev.ref
          ? "<label>Radio channel (" +
            esc(dev.ref) +
            ")" +
            inputCell("wifi-dev", dev.ref, "channel", dev.channel, {
              placeholder: "auto"
            }) +
            "</label>" +
            "<label>Country (" +
            esc(dev.ref) +
            ")" +
            inputCell("wifi-dev", dev.ref, "country", dev.country) +
            "</label>"
          : "") +
        "</div></div>";
    }
    wrap.innerHTML = html;
    if (empty) empty.hidden = state.wifi.length > 0;
    bindDirtyInputs(wrap);
  }

  function renderFwDefaults() {
    var form = $("fwDefaultsForm");
    if (!form) return;
    var d = state.fw.defaults;
    if (!d) {
      form.innerHTML = '<p class="hint">No firewall defaults section.</p>';
      return;
    }
    var r = d.ref;
    form.innerHTML =
      "<label>Input policy" +
      inputCell("fw-def", r, "input", d.input, {
        type: "select",
        optionsHtml: policyOpts(d.input)
      }) +
      "</label>" +
      "<label>Output policy" +
      inputCell("fw-def", r, "output", d.output, {
        type: "select",
        optionsHtml: policyOpts(d.output)
      }) +
      "</label>" +
      "<label>Forward policy" +
      inputCell("fw-def", r, "forward", d.forward, {
        type: "select",
        optionsHtml: policyOpts(d.forward)
      }) +
      "</label>" +
      "<label>SYN-flood protect" +
      inputCell("fw-def", r, "synflood_protect", d.synflood_protect, {
        type: "select",
        optionsHtml: selBool(d.synflood_protect === "1" || d.synflood_protect === "on", "1", "0")
      }) +
      "</label>" +
      "<label>Drop invalid" +
      inputCell("fw-def", r, "drop_invalid", d.drop_invalid, {
        type: "select",
        optionsHtml:
          '<option value="">—</option>' +
          selBool(d.drop_invalid === "1", "1", "0")
      }) +
      "</label>" +
      "<label>Flow offloading" +
      inputCell("fw-def", r, "flow_offloading", d.flow_offloading, {
        type: "select",
        optionsHtml:
          '<option value="">—</option>' +
          selBool(d.flow_offloading === "1", "1", "0")
      }) +
      "</label>";
    bindDirtyInputs(form);
  }

  function renderFwZones() {
    var body = $("fwZoneBody");
    if (!body) return;
    var rows = "";
    var i;
    for (i = 0; i < state.fw.zones.length; i++) {
      var z = state.fw.zones[i];
      rows +=
        "<tr data-ref=\"" +
        esc(z.ref) +
        '"><td><strong>' +
        esc(z.name) +
        "</strong><div class=\"hint\">" +
        esc(z.ref) +
        "</div></td><td>" +
        inputCell("fw-zone", z.ref, "input", z.input, {
          type: "select",
          optionsHtml: policyOpts(z.input)
        }) +
        "</td><td>" +
        inputCell("fw-zone", z.ref, "output", z.output, {
          type: "select",
          optionsHtml: policyOpts(z.output)
        }) +
        "</td><td>" +
        inputCell("fw-zone", z.ref, "forward", z.forward, {
          type: "select",
          optionsHtml: policyOpts(z.forward)
        }) +
        "</td><td>" +
        inputCell("fw-zone", z.ref, "masq", "", {
          type: "select",
          optionsHtml: selBool(z.masq, "1", "0")
        }) +
        "</td><td>" +
        inputCell("fw-zone", z.ref, "mtu_fix", "", {
          type: "select",
          optionsHtml: selBool(z.mtu_fix, "1", "0")
        }) +
        "</td><td>" +
        esc(z.network || "—") +
        "</td></tr>";
    }
    body.innerHTML =
      rows || '<tr><td colspan="7" class="hint">No zones</td></tr>';
    bindDirtyInputs(body);
  }

  function renderFirewallRules() {
    var body = $("fwBody");
    if (!body) return;
    var rows = "";
    var i;
    for (i = 0; i < state.fw.rules.length; i++) {
      var r = state.fw.rules[i];
      if (r._deleted) continue;
      rows +=
        "<tr data-ref=\"" +
        esc(r.ref) +
        '"><td>' +
        inputCell("fw-rule", r.ref, "name", r.name) +
        "</td><td>" +
        inputCell("fw-rule", r.ref, "src", r.src, { placeholder: "lan/wan/*" }) +
        "</td><td>" +
        inputCell("fw-rule", r.ref, "dest", r.dest) +
        "</td><td>" +
        inputCell("fw-rule", r.ref, "proto", r.proto, {
          type: "select",
          optionsHtml: protoOpts(r.proto)
        }) +
        "</td><td>" +
        inputCell("fw-rule", r.ref, "dest_port", r.dest_port, {
          placeholder: "port"
        }) +
        "</td><td>" +
        inputCell("fw-rule", r.ref, "src_ip", r.src_ip) +
        "</td><td>" +
        inputCell("fw-rule", r.ref, "dest_ip", r.dest_ip) +
        "</td><td>" +
        inputCell("fw-rule", r.ref, "target", r.target, {
          type: "select",
          optionsHtml: policyOpts(r.target)
        }) +
        "</td><td>" +
        inputCell("fw-rule", r.ref, "enabled", "", {
          type: "select",
          optionsHtml: selBool(r.enabled, "1", "0")
        }) +
        '</td><td><button type="button" class="btn secondary ghost cfg-row-del" data-del-kind="fw-rule" data-ref="' +
        esc(r.ref) +
        '">✕</button></td></tr>';
    }
    body.innerHTML =
      rows || '<tr><td colspan="10" class="hint">No rules — add one</td></tr>';
    bindDirtyInputs(body);
    bindDeleteButtons(body);
  }

  function renderFirewallRedirects() {
    var body = $("fwRedirBody");
    if (!body) return;
    var rows = "";
    var i;
    for (i = 0; i < state.fw.redirects.length; i++) {
      var r = state.fw.redirects[i];
      if (r._deleted) continue;
      rows +=
        "<tr data-ref=\"" +
        esc(r.ref) +
        '"><td>' +
        inputCell("fw-redir", r.ref, "name", r.name) +
        "</td><td>" +
        inputCell("fw-redir", r.ref, "src", r.src, { placeholder: "wan" }) +
        "</td><td>" +
        inputCell("fw-redir", r.ref, "src_dport", r.src_dport) +
        "</td><td>" +
        inputCell("fw-redir", r.ref, "dest", r.dest, { placeholder: "lan" }) +
        "</td><td>" +
        inputCell("fw-redir", r.ref, "dest_ip", r.dest_ip) +
        "</td><td>" +
        inputCell("fw-redir", r.ref, "dest_port", r.dest_port) +
        "</td><td>" +
        inputCell("fw-redir", r.ref, "proto", r.proto, {
          type: "select",
          optionsHtml: protoOpts(r.proto)
        }) +
        "</td><td>" +
        inputCell("fw-redir", r.ref, "enabled", "", {
          type: "select",
          optionsHtml: selBool(r.enabled, "1", "0")
        }) +
        '</td><td><button type="button" class="btn secondary ghost cfg-row-del" data-del-kind="fw-redir" data-ref="' +
        esc(r.ref) +
        '">✕</button></td></tr>';
    }
    body.innerHTML =
      rows ||
      '<tr><td colspan="9" class="hint">No port forwards — add one</td></tr>';
    bindDirtyInputs(body);
    bindDeleteButtons(body);
  }

  function renderFirewallFwd() {
    var body = $("fwFwdBody");
    if (!body) return;
    var rows = "";
    var i;
    for (i = 0; i < state.fw.forwardings.length; i++) {
      var f = state.fw.forwardings[i];
      rows +=
        "<tr><td>" +
        esc(f.src || "—") +
        "</td><td>" +
        esc(f.dest || "—") +
        "</td><td class=\"hint\">" +
        esc(f.ref) +
        "</td></tr>";
    }
    body.innerHTML =
      rows || '<tr><td colspan="3" class="hint">No zone forwarding</td></tr>';
  }

  function renderFirewall() {
    renderFwDefaults();
    renderFwZones();
    renderFirewallRules();
    renderFirewallRedirects();
    renderFirewallFwd();
  }

  function renderAlg() {
    var dform = $("algDefaultsForm");
    var d = state.fw.defaults;
    if (dform) {
      if (!d) {
        dform.innerHTML = '<p class="hint">No firewall defaults.</p>';
      } else {
        dform.innerHTML =
          "<label>Global auto_helper (ALG)" +
          inputCell("fw-def", d.ref, "auto_helper", d.auto_helper, {
            type: "select",
            optionsHtml:
              '<option value="">—</option>' +
              '<option value="1"' +
              (d.auto_helper !== "0" ? " selected" : "") +
              ">Enabled (default)</option>" +
              '<option value="0"' +
              (d.auto_helper === "0" ? " selected" : "") +
              ">Disabled</option>"
          }) +
          "</label>" +
          "<label>SYN-flood protect" +
          inputCell("fw-def", d.ref, "synflood_protect", d.synflood_protect, {
            type: "select",
            optionsHtml: selBool(
              d.synflood_protect === "1" || d.synflood_protect === "on",
              "1",
              "0"
            )
          }) +
          "</label>" +
          "<label>Hardware flow offload" +
          inputCell("fw-def", d.ref, "flow_offloading_hw", d.flow_offloading_hw, {
            type: "select",
            optionsHtml:
              '<option value="">—</option>' +
              selBool(d.flow_offloading_hw === "1", "1", "0")
          }) +
          "</label>";
        bindDirtyInputs(dform);
      }
    }

    var zbody = $("algZoneBody");
    if (zbody) {
      var rows = "";
      var i;
      for (i = 0; i < state.fw.zones.length; i++) {
        var z = state.fw.zones[i];
        rows +=
          "<tr><td><strong>" +
          esc(z.name) +
          "</strong></td><td>" +
          inputCell("fw-zone", z.ref, "auto_helper", z.auto_helper, {
            type: "select",
            optionsHtml:
              '<option value="">— default —</option>' +
              '<option value="1"' +
              (z.auto_helper === "1" ? " selected" : "") +
              ">On</option>" +
              '<option value="0"' +
              (z.auto_helper === "0" ? " selected" : "") +
              ">Off</option>"
          }) +
          "</td><td>" +
          inputCell("fw-zone", z.ref, "helper", z.helper, {
            placeholder: "ftp sip pptp …"
          }) +
          "</td></tr>";
      }
      zbody.innerHTML =
        rows || '<tr><td colspan="3" class="hint">No zones</td></tr>';
      bindDirtyInputs(zbody);
    }

    var hlist = $("algHelperList");
    var hempty = $("algHelperEmpty");
    if (hlist) {
      var html = "";
      for (i = 0; i < state.fw.helpers.length; i++) {
        var h = state.fw.helpers[i];
        html +=
          '<div class="cfg-mini-card"><h4>' +
          esc(h.name || h.ref) +
          '</h4><div class="cfg-wifi-fields">' +
          "<label>Module" +
          inputCell("fw-helper", h.ref, "module", h.module) +
          "</label>" +
          "<label>Proto" +
          inputCell("fw-helper", h.ref, "proto", h.proto) +
          "</label>" +
          "<label>Port" +
          inputCell("fw-helper", h.ref, "port", h.port) +
          "</label>" +
          "<label>Enabled" +
          inputCell("fw-helper", h.ref, "enabled", "", {
            type: "select",
            optionsHtml: selBool(h.enabled, "1", "0")
          }) +
          "</label></div></div>";
      }
      hlist.innerHTML = html;
      if (hempty) hempty.hidden = state.fw.helpers.length > 0;
      bindDirtyInputs(hlist);
    }

    var sform = $("algServicesForm");
    if (sform) {
      var svc = state.algServices || {};
      if (svc.upnp_ref) {
        sform.innerHTML =
          "<label>UPnP / miniupnpd" +
          inputCell("upnp", svc.upnp_ref, "enabled", svc.upnp_enabled, {
            type: "select",
            optionsHtml: selBool(svc.upnp_enabled !== "0", "1", "0")
          }) +
          "</label>" +
          '<p class="hint">Package: ' +
          esc(svc.upnp_pkg || "upnpd") +
          "</p>";
        bindDirtyInputs(sform);
      } else {
        sform.innerHTML =
          '<p class="hint">No UPnP package present on this router.</p>';
      }
    }
  }

  function ynSelect(id, cur) {
    var el = $(id);
    if (!el) return;
    if (cur === "on" || cur === "1") el.value = "on";
    else if (cur === "off" || cur === "0") el.value = "off";
    else el.value = "";
  }

  function renderAccess() {
    if ($("accHostname")) $("accHostname").value = state.access.hostname || "";
    if ($("accTimezone")) $("accTimezone").value = state.access.timezone || "";
    if ($("accZonename")) $("accZonename").value = state.access.zonename || "";
    ynSelect("accPassAuth", state.access.passAuth);
    ynSelect("accRootPassAuth", state.access.rootPassAuth);
    if ($("accSshPort")) $("accSshPort").value = state.access.sshPort || "";
    ynSelect("accGwPorts", state.access.gwPorts);
    if ($("accSshIface")) $("accSshIface").value = state.access.sshIface || "";
    bindDirtyInputs($("panel-access"));

    var ul = $("userList");
    var empty = $("userEmpty");
    if (ul) {
      var html = "";
      var i;
      for (i = 0; i < state.users.length; i++) {
        var u = state.users[i];
        if (u._deleted) continue;
        html +=
          '<div class="cfg-mini-card" data-ref="' +
          esc(u.ref) +
          '"><div class="cfg-card-head"><h4>' +
          esc(u.username || u.ref) +
          '</h4><button type="button" class="btn secondary ghost cfg-row-del" data-del-kind="user" data-ref="' +
          esc(u.ref) +
          '">Remove</button></div><div class="cfg-wifi-fields">' +
          "<label>Username" +
          inputCell("user", u.ref, "username", u.username) +
          "</label>" +
          "<label>Password / hash (blank = keep)" +
          inputCell("user", u.ref, "password", "", {
            type: "password",
            placeholder: u.password ? "••••••••" : ""
          }) +
          "</label>" +
          "<label>Read ACLs (space-separated)" +
          inputCell("user", u.ref, "read", u.read, {
            placeholder: "uci ubus …"
          }) +
          "</label>" +
          "<label>Write ACLs" +
          inputCell("user", u.ref, "write", u.write) +
          "</label></div></div>";
      }
      ul.innerHTML = html;
      if (empty) empty.hidden = state.users.filter(function (x) {
        return !x._deleted;
      }).length > 0;
      bindDirtyInputs(ul);
      bindDeleteButtons(ul);
    }

    var sul = $("sysUserList");
    var sempty = $("sysUserEmpty");
    if (sul) {
      html = "";
      for (i = 0; i < state.sysUsers.length; i++) {
        var su = state.sysUsers[i];
        var keys = Object.keys(su.options || {});
        html +=
          '<div class="cfg-mini-card"><h4>' +
          esc(su.name) +
          ' <span class="hint">' +
          esc(su.type) +
          " · " +
          esc(su.ref) +
          "</span></h4><div class=\"cfg-wifi-fields\">";
        var k;
        for (k = 0; k < keys.length; k++) {
          html +=
            "<label>" +
            esc(keys[k]) +
            inputCell(
              "sysuser",
              su.ref,
              keys[k],
              su.options[keys[k]]
            ) +
            "</label>";
        }
        html += "</div></div>";
      }
      sul.innerHTML = html;
      if (sempty) sempty.hidden = state.sysUsers.length > 0;
      bindDirtyInputs(sul);
    }
  }

  function renderNetwork() {
    var body = $("netIfBody");
    if (body) {
      var rows = "";
      var i;
      for (i = 0; i < state.network.interfaces.length; i++) {
        var n = state.network.interfaces[i];
        rows +=
          "<tr><td><strong>" +
          esc(n.ref) +
          "</strong></td><td>" +
          inputCell("net-if", n.ref, "proto", n.proto) +
          "</td><td>" +
          inputCell("net-if", n.ref, "device", n.device) +
          "</td><td>" +
          inputCell("net-if", n.ref, "ipaddr", n.ipaddr) +
          "</td><td>" +
          inputCell("net-if", n.ref, "netmask", n.netmask) +
          "</td><td>" +
          inputCell("net-if", n.ref, "gateway", n.gateway) +
          "</td><td>" +
          inputCell("net-if", n.ref, "dns", n.dns) +
          "</td><td>" +
          inputCell("net-if", n.ref, "disabled", "", {
            type: "select",
            optionsHtml: selBool(n.disabled, "1", "0")
          }) +
          "</td></tr>";
      }
      body.innerHTML =
        rows || '<tr><td colspan="8" class="hint">No interfaces</td></tr>';
      bindDirtyInputs(body);
    }

    var pbody = $("dhcpPoolBody");
    if (pbody) {
      rows = "";
      for (i = 0; i < state.dhcp.pools.length; i++) {
        var p = state.dhcp.pools[i];
        rows +=
          "<tr><td>" +
          esc(p.ref) +
          "</td><td>" +
          esc(p.interface) +
          "</td><td>" +
          inputCell("dhcp-pool", p.ref, "start", p.start) +
          "</td><td>" +
          inputCell("dhcp-pool", p.ref, "limit", p.limit) +
          "</td><td>" +
          inputCell("dhcp-pool", p.ref, "leasetime", p.leasetime) +
          "</td><td>" +
          inputCell("dhcp-pool", p.ref, "ignore", "", {
            type: "select",
            optionsHtml: selBool(p.ignore, "1", "0")
          }) +
          "</td><td>" +
          inputCell("dhcp-pool", p.ref, "force", "", {
            type: "select",
            optionsHtml: selBool(p.force, "1", "0")
          }) +
          "</td></tr>";
      }
      pbody.innerHTML =
        rows || '<tr><td colspan="7" class="hint">No DHCP pools</td></tr>';
      bindDirtyInputs(pbody);
    }

    var hbody = $("dhcpHostBody");
    if (hbody) {
      rows = "";
      for (i = 0; i < state.dhcp.hosts.length; i++) {
        var h = state.dhcp.hosts[i];
        if (h._deleted) continue;
        rows +=
          "<tr><td>" +
          inputCell("dhcp-host", h.ref, "name", h.name) +
          "</td><td>" +
          inputCell("dhcp-host", h.ref, "mac", h.mac) +
          "</td><td>" +
          inputCell("dhcp-host", h.ref, "ip", h.ip) +
          "</td><td>" +
          inputCell("dhcp-host", h.ref, "hostid", h.hostid) +
          "</td><td>" +
          inputCell("dhcp-host", h.ref, "enabled", "", {
            type: "select",
            optionsHtml: selBool(h.enabled, "1", "0")
          }) +
          '</td><td><button type="button" class="btn secondary ghost cfg-row-del" data-del-kind="dhcp-host" data-ref="' +
          esc(h.ref) +
          '">✕</button></td></tr>';
      }
      hbody.innerHTML =
        rows ||
        '<tr><td colspan="6" class="hint">No static leases — add one</td></tr>';
      bindDirtyInputs(hbody);
      bindDeleteButtons(hbody);
    }

    var dform = $("dnsmasqForm");
    if (dform) {
      var d = state.dhcp.dnsmasq;
      if (!d) {
        dform.innerHTML = '<p class="hint">No dnsmasq section.</p>';
      } else {
        dform.innerHTML =
          "<label>Domain" +
          inputCell("dnsmasq", d.ref, "domain", d.domain) +
          "</label>" +
          "<label>Domain needed" +
          inputCell("dnsmasq", d.ref, "domainneeded", d.domainneeded, {
            type: "select",
            optionsHtml:
              '<option value="">—</option>' +
              selBool(d.domainneeded === "1", "1", "0")
          }) +
          "</label>" +
          "<label>Rebind protection" +
          inputCell("dnsmasq", d.ref, "rebind_protection", d.rebind_protection, {
            type: "select",
            optionsHtml:
              '<option value="">—</option>' +
              selBool(d.rebind_protection === "1", "1", "0")
          }) +
          "</label>" +
          "<label>Local service only" +
          inputCell("dnsmasq", d.ref, "localservice", d.localservice, {
            type: "select",
            optionsHtml:
              '<option value="">—</option>' +
              selBool(d.localservice === "1", "1", "0")
          }) +
          "</label>" +
          "<label>Authoritative" +
          inputCell("dnsmasq", d.ref, "authoritative", d.authoritative, {
            type: "select",
            optionsHtml:
              '<option value="">—</option>' +
              selBool(d.authoritative === "1", "1", "0")
          }) +
          "</label>";
        bindDirtyInputs(dform);
      }
    }
  }

  function renderAdvanced() {
    var wrap = $("advPackages");
    if (!wrap) return;
    var filter = ($("advFilter") && $("advFilter").value) || "";
    filter = filter.toLowerCase().trim();
    var names = Object.keys(state.packages).sort();
    var html = "";
    var shown = 0;
    var i;
    for (i = 0; i < names.length; i++) {
      var n = names[i];
      if (filter && n.toLowerCase().indexOf(filter) < 0) continue;
      shown++;
      var t = state.packages[n] || "";
      var dirtyKeyPkg = "pkgtext:" + n;
      var edited =
        state.dirty[dirtyKeyPkg] != null ? state.dirty[dirtyKeyPkg] : t;
      html +=
        "<details" +
        (filter ? " open" : "") +
        "><summary><code>" +
        esc(n) +
        '</code> <span class="hint">' +
        t.length +
        " B</span></summary>" +
        '<textarea class="cfg-pkg-edit" data-kind="pkgtext" data-ref="' +
        esc(n) +
        '" data-field="text" rows="14" spellcheck="false">' +
        esc(edited) +
        "</textarea>" +
        '<p class="hint">Edits replace the whole package via UCI.&lt;pkg&gt;.Text on apply.</p>' +
        "</details>";
    }
    wrap.innerHTML = html || '<p class="hint">No packages loaded</p>';
    if ($("advCount")) {
      $("advCount").textContent =
        shown + " of " + names.length + " package(s)";
    }
    bindDirtyInputs(wrap);
  }

  function bindDeleteButtons(root) {
    if (!root) return;
    var btns = root.querySelectorAll(".cfg-row-del");
    var i;
    for (i = 0; i < btns.length; i++) {
      btns[i].addEventListener("click", onDeleteRow);
    }
  }

  function onDeleteRow(ev) {
    var btn = ev.currentTarget;
    var kind = btn.getAttribute("data-del-kind");
    var ref = btn.getAttribute("data-ref");
    var list;
    var i;
    if (kind === "fw-rule") list = state.fw.rules;
    else if (kind === "fw-redir") list = state.fw.redirects;
    else if (kind === "user") list = state.users;
    else if (kind === "dhcp-host") list = state.dhcp.hosts;
    else return;
    for (i = 0; i < list.length; i++) {
      if (list[i].ref === ref) {
        if (list[i].isNew) {
          list.splice(i, 1);
          /* drop dirty keys for this ref */
          Object.keys(state.dirty).forEach(function (k) {
            if (k.indexOf(":" + ref + ":") >= 0) delete state.dirty[k];
          });
        } else {
          list[i]._deleted = true;
          setDirty(dirtyKey(kind, ref, "_delete"), "1");
        }
        break;
      }
    }
    if (kind === "fw-rule" || kind === "fw-redir") renderFirewall();
    else if (kind === "user") renderAccess();
    else if (kind === "dhcp-host") renderNetwork();
    updateChangeBar();
  }

  function addFirewallRule() {
    var ref = nextNewName("ecoec_rule");
    state.fw.rules.push({
      ref: ref,
      name: "New rule",
      src: "wan",
      dest: "",
      dest_port: "",
      src_port: "",
      src_ip: "",
      dest_ip: "",
      proto: "tcp",
      family: "",
      target: "ACCEPT",
      enabled: true,
      isNew: true
    });
    setDirty(dirtyKey("fw-rule", ref, "_create"), "1");
    setDirty(dirtyKey("fw-rule", ref, "name"), "New rule");
    setDirty(dirtyKey("fw-rule", ref, "src"), "wan");
    setDirty(dirtyKey("fw-rule", ref, "proto"), "tcp");
    setDirty(dirtyKey("fw-rule", ref, "target"), "ACCEPT");
    setDirty(dirtyKey("fw-rule", ref, "enabled"), "1");
    renderFirewallRules();
  }

  function addFirewallRedirect() {
    var ref = nextNewName("ecoec_fwd");
    state.fw.redirects.push({
      ref: ref,
      name: "New forward",
      src: "wan",
      src_dport: "",
      dest: "lan",
      dest_ip: "",
      dest_port: "",
      proto: "tcp",
      target: "DNAT",
      enabled: true,
      isNew: true
    });
    setDirty(dirtyKey("fw-redir", ref, "_create"), "1");
    setDirty(dirtyKey("fw-redir", ref, "name"), "New forward");
    setDirty(dirtyKey("fw-redir", ref, "src"), "wan");
    setDirty(dirtyKey("fw-redir", ref, "dest"), "lan");
    setDirty(dirtyKey("fw-redir", ref, "proto"), "tcp");
    setDirty(dirtyKey("fw-redir", ref, "enabled"), "1");
    renderFirewallRedirects();
  }

  function addUser() {
    var ref = nextNewName("ecoec_login");
    state.users.push({
      ref: ref,
      username: "newuser",
      password: "",
      read: "*",
      write: "*",
      isNew: true
    });
    setDirty(dirtyKey("user", ref, "_create"), "1");
    setDirty(dirtyKey("user", ref, "username"), "newuser");
    setDirty(dirtyKey("user", ref, "read"), "*");
    setDirty(dirtyKey("user", ref, "write"), "*");
    renderAccess();
  }

  function addLease() {
    var ref = nextNewName("ecoec_host");
    state.dhcp.hosts.push({
      ref: ref,
      name: "",
      mac: "",
      ip: "",
      hostid: "",
      enabled: true,
      isNew: true
    });
    setDirty(dirtyKey("dhcp-host", ref, "_create"), "1");
    setDirty(dirtyKey("dhcp-host", ref, "enabled"), "1");
    renderNetwork();
  }

  /* ── Collect Apply lines ────────────────────────────────── */

  function findByRef(list, ref) {
    var i;
    for (i = 0; i < list.length; i++) {
      if (list[i].ref === ref) return list[i];
    }
    return null;
  }

  function pushSet(changes, label, path, val) {
    if (val == null) return;
    changes.push({
      label: label,
      apply: "set " + path + "=" + val
    });
  }

  function pushDelete(changes, label, path) {
    changes.push({
      label: label,
      apply: "delete " + path
    });
  }

  function pushAdd(changes, label, pkg, type, name) {
    changes.push({
      label: label,
      apply: "add " + pkg + " " + type + (name ? " " + name : "")
    });
  }

  function collectListReplace(changes, label, path, oldSpace, newSpace) {
    /* Simple strategy: delete list then re-add each token. */
    var oldT = String(oldSpace || "")
      .split(/\s+/)
      .filter(Boolean);
    var newT = String(newSpace || "")
      .split(/\s+/)
      .filter(Boolean);
    var i;
    if (oldT.join(" ") === newT.join(" ")) return;
    for (i = 0; i < oldT.length; i++) {
      changes.push({
        label: label + " (remove " + oldT[i] + ")",
        apply: "del_list " + path + "=" + oldT[i]
      });
    }
    for (i = 0; i < newT.length; i++) {
      changes.push({
        label: label + " (add " + newT[i] + ")",
        apply: "add_list " + path + "=" + newT[i]
      });
    }
  }

  function baselineField(obj, field) {
    if (!obj) return "";
    var v = obj[field];
    if (v === true) return "1";
    if (v === false) return "0";
    return v == null ? "" : String(v);
  }

  function collectChanges() {
    var changes = [];
    var keys = Object.keys(state.dirty);
    var handled = {};
    var i;

    /* Package text replacements first */
    for (i = 0; i < keys.length; i++) {
      var key = keys[i];
      var val = state.dirty[key];
      if (key.indexOf("pkgtext:") === 0 || key.indexOf("pkgtext:") >= 0) {
        /* dirtyKey("pkgtext", name, "text") => pkgtext:name:text */
        var parts = key.split(":");
        if (parts[0] === "pkgtext" && parts.length >= 2) {
          var pkg = parts[1];
          var orig = state.packages[pkg] || "";
          if (val !== orig) {
            changes.push({
              label: "Replace package “" + pkg + "” (" + val.length + " B)",
              pkgText: { pkg: pkg, text: val }
            });
          }
          handled[key] = 1;
        }
      }
    }

    /* Group dirty keys by kind:ref */
    var groups = {};
    for (i = 0; i < keys.length; i++) {
      key = keys[i];
      if (handled[key]) continue;
      if (key.indexOf("id:") === 0) continue;
      parts = key.split(":");
      if (parts.length < 3) continue;
      var kind = parts[0];
      var ref = parts[1];
      var field = parts.slice(2).join(":");
      var gkey = kind + ":" + ref;
      if (!groups[gkey]) groups[gkey] = { kind: kind, ref: ref, fields: {} };
      groups[gkey].fields[field] = state.dirty[key];
    }

    /* Access id: fields */
    function accessChange(id, label, path, baseline) {
      var k = "id:" + id;
      if (state.dirty[k] == null) return;
      val = state.dirty[k];
      if (val === "" && (id === "accPassAuth" || id === "accRootPassAuth" ||
          id === "accGwPorts")) {
        return;
      }
      if (String(val) !== String(baseline || "")) {
        pushSet(changes, label, path, val);
      }
    }
    if (state.access.sysRef) {
      accessChange(
        "accHostname",
        "Hostname → " + state.dirty["id:accHostname"],
        "system." + state.access.sysRef + ".hostname",
        state.access.hostname
      );
      accessChange(
        "accTimezone",
        "Timezone → " + state.dirty["id:accTimezone"],
        "system." + state.access.sysRef + ".timezone",
        state.access.timezone
      );
      accessChange(
        "accZonename",
        "Zonename → " + state.dirty["id:accZonename"],
        "system." + state.access.sysRef + ".zonename",
        state.access.zonename
      );
    }
    if (state.access.dbRef) {
      accessChange(
        "accPassAuth",
        "SSH password login → " + state.dirty["id:accPassAuth"],
        "dropbear." + state.access.dbRef + ".PasswordAuth",
        state.access.passAuth
      );
      accessChange(
        "accRootPassAuth",
        "SSH root password login → " + state.dirty["id:accRootPassAuth"],
        "dropbear." + state.access.dbRef + ".RootPasswordAuth",
        state.access.rootPassAuth
      );
      accessChange(
        "accSshPort",
        "SSH port → " + state.dirty["id:accSshPort"],
        "dropbear." + state.access.dbRef + ".Port",
        state.access.sshPort
      );
      accessChange(
        "accGwPorts",
        "SSH gateway ports → " + state.dirty["id:accGwPorts"],
        "dropbear." + state.access.dbRef + ".GatewayPorts",
        state.access.gwPorts
      );
      accessChange(
        "accSshIface",
        "SSH interface → " + state.dirty["id:accSshIface"],
        "dropbear." + state.access.dbRef + ".Interface",
        state.access.sshIface
      );
    }

    var gkeys = Object.keys(groups);
    for (i = 0; i < gkeys.length; i++) {
      var g = groups[gkeys[i]];
      kind = g.kind;
      ref = g.ref;
      var fields = g.fields;

      if (kind === "wifi") {
        var iface = findByRef(state.wifi, ref);
        if (!iface) continue;
        if (fields.ssid != null && fields.ssid !== iface.ssid) {
          pushSet(
            changes,
            "Wi‑Fi “" + (iface.ssid || ref) + "” name → " + fields.ssid,
            "wireless." + ref + ".ssid",
            fields.ssid
          );
        }
        if (fields.key) {
          pushSet(
            changes,
            "Wi‑Fi “" + (iface.ssid || ref) + "” password updated",
            "wireless." + ref + ".key",
            fields.key
          );
        }
        if (fields.encryption && fields.encryption !== iface.encryption) {
          pushSet(
            changes,
            "Wi‑Fi “" + (iface.ssid || ref) + "” security → " + fields.encryption,
            "wireless." + ref + ".encryption",
            fields.encryption
          );
        }
        if (fields.enabled != null) {
          var wantOff = fields.enabled === "0";
          if (wantOff !== iface.disabled) {
            pushSet(
              changes,
              "Wi‑Fi “" +
                (iface.ssid || ref) +
                "” " +
                (wantOff ? "off" : "on"),
              "wireless." + ref + ".disabled",
              wantOff ? "1" : "0"
            );
          }
        }
        if (fields.hidden != null) {
          var h = fields.hidden === "1";
          if (h !== iface.hidden) {
            pushSet(
              changes,
              "Wi‑Fi “" + (iface.ssid || ref) + "” hidden → " + fields.hidden,
              "wireless." + ref + ".hidden",
              fields.hidden
            );
          }
        }
        if (fields.isolate != null) {
          var iso = fields.isolate === "1";
          if (iso !== iface.isolate) {
            pushSet(
              changes,
              "Wi‑Fi “" + (iface.ssid || ref) + "” isolate → " + fields.isolate,
              "wireless." + ref + ".isolate",
              fields.isolate
            );
          }
        }
        if (fields.network != null && fields.network !== iface.network) {
          pushSet(
            changes,
            "Wi‑Fi “" + (iface.ssid || ref) + "” network → " + fields.network,
            "wireless." + ref + ".network",
            fields.network
          );
        }
        continue;
      }

      if (kind === "wifi-dev") {
        var dev = state.wifiDevices[ref];
        if (!dev) continue;
        ["channel", "country", "txpower", "htmode"].forEach(function (f) {
          if (fields[f] != null && fields[f] !== baselineField(dev, f)) {
            pushSet(
              changes,
              "Radio " + ref + " " + f + " → " + fields[f],
              "wireless." + ref + "." + f,
              fields[f]
            );
          }
        });
        continue;
      }

      if (kind === "fw-def") {
        var def = state.fw.defaults;
        if (!def) continue;
        Object.keys(fields).forEach(function (f) {
          if (fields[f] === "" || fields[f] == null) return;
          if (String(fields[f]) !== baselineField(def, f)) {
            pushSet(
              changes,
              "Firewall defaults." + f + " → " + fields[f],
              "firewall." + ref + "." + f,
              fields[f]
            );
          }
        });
        continue;
      }

      if (kind === "fw-zone") {
        var zone = findByRef(state.fw.zones, ref);
        if (!zone) continue;
        Object.keys(fields).forEach(function (f) {
          if (f === "helper") {
            collectListReplace(
              changes,
              "Zone " + zone.name + " helpers",
              "firewall." + ref + ".helper",
              zone.helper,
              fields.helper
            );
            return;
          }
          if (fields[f] === "" || fields[f] == null) return;
          var base = baselineField(zone, f);
          if (f === "masq" || f === "mtu_fix") {
            base = zone[f] ? "1" : "0";
          }
          if (String(fields[f]) !== String(base)) {
            pushSet(
              changes,
              "Zone “" + zone.name + "”." + f + " → " + fields[f],
              "firewall." + ref + "." + f,
              fields[f]
            );
          }
        });
        continue;
      }

      if (kind === "fw-rule") {
        var rule = findByRef(state.fw.rules, ref);
        if (!rule) continue;
        if (fields._delete === "1") {
          pushDelete(changes, "Delete firewall rule “" + rule.name + "”", "firewall." + ref);
          continue;
        }
        if (fields._create === "1" || rule.isNew) {
          pushAdd(
            changes,
            "Create firewall rule “" + (fields.name || rule.name) + "”",
            "firewall",
            "rule",
            ref
          );
        }
        ["name", "src", "dest", "proto", "dest_port", "src_port", "src_ip",
          "dest_ip", "target", "family", "enabled"].forEach(function (f) {
          var v = fields[f];
          if (v == null) {
            if ((fields._create === "1" || rule.isNew) && baselineField(rule, f) !== "") {
              v = baselineField(rule, f);
              if (f === "enabled") v = rule.enabled ? "1" : "0";
            } else return;
          }
          if (fields._create === "1" || rule.isNew) {
            if (v === "" && f !== "enabled") return;
            pushSet(
              changes,
              "Rule “" + (fields.name || rule.name) + "”." + f + " → " + v,
              "firewall." + ref + "." + f,
              v
            );
          } else {
            var b = f === "enabled" ? (rule.enabled ? "1" : "0") : baselineField(rule, f);
            if (String(v) !== String(b)) {
              pushSet(
                changes,
                "Rule “" + rule.name + "”." + f + " → " + v,
                "firewall." + ref + "." + f,
                v
              );
            }
          }
        });
        continue;
      }

      if (kind === "fw-redir") {
        var redir = findByRef(state.fw.redirects, ref);
        if (!redir) continue;
        if (fields._delete === "1") {
          pushDelete(
            changes,
            "Delete port forward “" + redir.name + "”",
            "firewall." + ref
          );
          continue;
        }
        if (fields._create === "1" || redir.isNew) {
          pushAdd(
            changes,
            "Create port forward “" + (fields.name || redir.name) + "”",
            "firewall",
            "redirect",
            ref
          );
        }
        ["name", "src", "src_dport", "dest", "dest_ip", "dest_port", "proto",
          "target", "enabled", "reflection"].forEach(function (f) {
          var v = fields[f];
          if (v == null) {
            if ((fields._create === "1" || redir.isNew) &&
                baselineField(redir, f) !== "" &&
                f !== "enabled") {
              v = baselineField(redir, f);
            } else if ((fields._create === "1" || redir.isNew) && f === "enabled") {
              v = redir.enabled ? "1" : "0";
            } else return;
          }
          if (fields._create === "1" || redir.isNew) {
            if (v === "" && f !== "enabled") return;
            pushSet(
              changes,
              "Forward “" + (fields.name || redir.name) + "”." + f + " → " + v,
              "firewall." + ref + "." + f,
              v
            );
          } else {
            var b = f === "enabled" ? (redir.enabled ? "1" : "0") : baselineField(redir, f);
            if (String(v) !== String(b)) {
              pushSet(
                changes,
                "Forward “" + redir.name + "”." + f + " → " + v,
                "firewall." + ref + "." + f,
                v
              );
            }
          }
        });
        continue;
      }

      if (kind === "fw-helper") {
        var helper = findByRef(state.fw.helpers, ref);
        if (!helper) continue;
        Object.keys(fields).forEach(function (f) {
          var b = f === "enabled" ? (helper.enabled ? "1" : "0") : baselineField(helper, f);
          if (String(fields[f]) !== String(b)) {
            pushSet(
              changes,
              "Helper “" + helper.name + "”." + f + " → " + fields[f],
              "firewall." + ref + "." + f,
              fields[f]
            );
          }
        });
        continue;
      }

      if (kind === "user") {
        var user = findByRef(state.users, ref);
        if (!user) continue;
        if (fields._delete === "1") {
          pushDelete(
            changes,
            "Remove user “" + user.username + "”",
            "rpcd." + ref
          );
          continue;
        }
        if (fields._create === "1" || user.isNew) {
          pushAdd(
            changes,
            "Add management user “" + (fields.username || user.username) + "”",
            "rpcd",
            "login",
            ref
          );
        }
        if (fields.username != null || fields._create === "1" || user.isNew) {
          var un = fields.username != null ? fields.username : user.username;
          if (fields._create === "1" || user.isNew || un !== user.username) {
            pushSet(
              changes,
              "User " + ref + " username → " + un,
              "rpcd." + ref + ".username",
              un
            );
          }
        }
        if (fields.password) {
          pushSet(
            changes,
            "User “" + (fields.username || user.username) + "” password updated",
            "rpcd." + ref + ".password",
            fields.password
          );
        }
        if (fields.read != null) {
          collectListReplace(
            changes,
            "User “" + (fields.username || user.username) + "” read ACL",
            "rpcd." + ref + ".read",
            user.read,
            fields.read
          );
        } else if (fields._create === "1" || user.isNew) {
          collectListReplace(
            changes,
            "User read ACL",
            "rpcd." + ref + ".read",
            "",
            user.read || "*"
          );
        }
        if (fields.write != null) {
          collectListReplace(
            changes,
            "User “" + (fields.username || user.username) + "” write ACL",
            "rpcd." + ref + ".write",
            user.write,
            fields.write
          );
        } else if (fields._create === "1" || user.isNew) {
          collectListReplace(
            changes,
            "User write ACL",
            "rpcd." + ref + ".write",
            "",
            user.write || "*"
          );
        }
        continue;
      }

      if (kind === "sysuser") {
        Object.keys(fields).forEach(function (f) {
          pushSet(
            changes,
            "users." + ref + "." + f + " → " + fields[f],
            "users." + ref + "." + f,
            fields[f]
          );
        });
        continue;
      }

      if (kind === "net-if") {
        var nif = findByRef(state.network.interfaces, ref);
        if (!nif) continue;
        Object.keys(fields).forEach(function (f) {
          var b =
            f === "disabled" ? (nif.disabled ? "1" : "0") : baselineField(nif, f);
          if (String(fields[f]) !== String(b)) {
            if (f === "dns") {
              collectListReplace(
                changes,
                "Interface " + ref + " DNS",
                "network." + ref + ".dns",
                nif.dns,
                fields.dns
              );
            } else if (f === "device") {
              /* Prefer device; fall back ifname if that was the source field name */
              pushSet(
                changes,
                "Interface " + ref + ".device → " + fields[f],
                "network." + ref + ".device",
                fields[f]
              );
            } else {
              pushSet(
                changes,
                "Interface " + ref + "." + f + " → " + fields[f],
                "network." + ref + "." + f,
                fields[f]
              );
            }
          }
        });
        continue;
      }

      if (kind === "dhcp-pool") {
        var pool = findByRef(state.dhcp.pools, ref);
        if (!pool) continue;
        Object.keys(fields).forEach(function (f) {
          var b =
            f === "ignore" || f === "force"
              ? pool[f] ? "1" : "0"
              : baselineField(pool, f);
          if (String(fields[f]) !== String(b)) {
            pushSet(
              changes,
              "DHCP " + ref + "." + f + " → " + fields[f],
              "dhcp." + ref + "." + f,
              fields[f]
            );
          }
        });
        continue;
      }

      if (kind === "dhcp-host") {
        var host = findByRef(state.dhcp.hosts, ref);
        if (!host) continue;
        if (fields._delete === "1") {
          pushDelete(changes, "Delete static lease “" + (host.name || ref) + "”", "dhcp." + ref);
          continue;
        }
        if (fields._create === "1" || host.isNew) {
          pushAdd(
            changes,
            "Create static lease “" + (fields.name || host.name || ref) + "”",
            "dhcp",
            "host",
            ref
          );
        }
        ["name", "mac", "ip", "hostid", "enabled"].forEach(function (f) {
          var v = fields[f];
          if (v == null) {
            if ((fields._create === "1" || host.isNew) && f !== "enabled") {
              v = baselineField(host, f);
            } else if ((fields._create === "1" || host.isNew) && f === "enabled") {
              v = "1";
            } else return;
          }
          if (v === "" && f !== "enabled") return;
          if (fields._create === "1" || host.isNew) {
            pushSet(
              changes,
              "Lease " + ref + "." + f + " → " + v,
              "dhcp." + ref + "." + f,
              v
            );
          } else {
            var b = f === "enabled" ? (host.enabled ? "1" : "0") : baselineField(host, f);
            if (String(v) !== String(b)) {
              pushSet(
                changes,
                "Lease “" + (host.name || ref) + "”." + f + " → " + v,
                "dhcp." + ref + "." + f,
                v
              );
            }
          }
        });
        continue;
      }

      if (kind === "dnsmasq") {
        var dns = state.dhcp.dnsmasq;
        if (!dns) continue;
        Object.keys(fields).forEach(function (f) {
          if (String(fields[f]) !== baselineField(dns, f) && fields[f] !== "") {
            pushSet(
              changes,
              "dnsmasq." + f + " → " + fields[f],
              "dhcp." + ref + "." + f,
              fields[f]
            );
          }
        });
        continue;
      }

      if (kind === "upnp") {
        var svc = state.algServices;
        if (!svc || !svc.upnp_pkg) continue;
        Object.keys(fields).forEach(function (f) {
          if (String(fields[f]) !== String(svc["upnp_" + f] || svc.upnp_enabled)) {
            pushSet(
              changes,
              "UPnP." + f + " → " + fields[f],
              svc.upnp_pkg + "." + ref + "." + f,
              fields[f]
            );
          }
        });
        continue;
      }
    }

    return changes;
  }

  /* ── API ────────────────────────────────────────────────── */

  /**
   * Poll budget: helpdesk ~15–40s over reverse tunnel; full dump of 30–40
   * packages at 1 chunk/Get can take several minutes. 250ms × tries.
   */
  function pollBudget(profile) {
    if (profile === "commit_status") return 40;
    if (profile === "all" || profile === "full" || profile === "openwrt_uci") {
      return 1200; /* 5 minutes */
    }
    return 480; /* helpdesk / host_wifi ≈ 2 minutes */
  }

  function capture(profile) {
    var rid = routerId();
    var prof = profile || "helpdesk";
    if (!rid) {
      setStatus("error", "Enter a router id");
      return Promise.resolve(null);
    }
    var url =
      "/api/v1/cpe/usp/config/capture?router_id=" +
      encodeURIComponent(rid) +
      "&profile=" +
      encodeURIComponent(prof);
    setStatus(
      "pending",
      prof === "all" || prof === "full"
        ? "Fetching full configuration (all packages — may take several minutes)…"
        : "Fetching configuration from router…"
    );
    state.busy = true;
    state.captureProfile = prof;
    return http(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: prof })
    })
      .then(function (r) {
        var j = parseJson(r);
        if (r.status === 202 || (j && j.status === "pending")) {
          return pollUntilDone(pollBudget(prof));
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

  function formatProgress(j) {
    if (!j) return "";
    var p = j.progress || {};
    var pkg = p.current_package || "";
    var pi = j.uci_pkg_i != null ? j.uci_pkg_i : p.uci_pkg_i;
    var n = j.uci_pkgs != null ? j.uci_pkgs : p.uci_pkgs;
    var phase = j.phase != null ? j.phase : p.phase;
    var phaseName =
      phase === 1
        ? "device/Wi‑Fi"
        : phase === 2
          ? "package list"
          : phase === 3
            ? "package sizes"
            : phase === 4
              ? "package data"
              : phase === 5
                ? "applying"
                : "working";
    if (n > 0 && pi != null) {
      return (
        "Fetching " +
        phaseName +
        (pkg ? " · " + pkg : "") +
        " (" +
        Math.min(pi + 1, n) +
        "/" +
        n +
        ")…"
      );
    }
    return "Fetching " + phaseName + "…";
  }

  function pollUntilDone(tries) {
    tries = tries == null ? 480 : tries;
    var rid = routerId();
    var url =
      "/api/v1/cpe/usp/config?router_id=" + encodeURIComponent(rid);
    return http(url, { credentials: "same-origin" }).then(function (r) {
      var j = parseJson(r);
      if (!j) {
        state.busy = false;
        setStatus("error", "Empty response from server");
        return null;
      }
      /* Auth expired mid-poll */
      if (r.status === 401 || r.status === 403) {
        state.busy = false;
        setStatus("error", "Session expired — reload the page and sign in");
        return null;
      }
      if (j.status === "pending" && tries > 0) {
        setStatus("pending", formatProgress(j));
        return new Promise(function (resolve) {
          state.pollTimer = setTimeout(function () {
            resolve(pollUntilDone(tries - 1));
          }, 250);
        });
      }
      state.busy = false;
      if (j.status === "pending") {
        setStatus(
          "error",
          "Timed out waiting for the router" +
            (j.uci_pkgs
              ? " (was at package " +
                (j.uci_pkg_i || 0) +
                "/" +
                j.uci_pkgs +
                "). Try “Load configuration” (help-desk set) or check Call Home."
              : ". Is the router online with edge-usp?")
        );
        return null;
      }
      if (j.status === "error" || j.ok === false) {
        setStatus(
          "error",
          j.err || j.error || "capture error"
        );
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
    state.fw = buildFirewallModel(state.packages.firewall || "");
    state.access = buildAccessModel(
      state.packages.system || "",
      state.packages.dropbear || ""
    );
    var um = buildUsersModel(
      state.packages.rpcd || "",
      state.packages.users || ""
    );
    state.users = um.rpcd;
    state.sysUsers = um.sysUsers;
    state.network = buildNetworkModel(state.packages.network || "");
    state.dhcp = buildDhcpModel(state.packages.dhcp || "");
    state.algServices = buildAlgServices(state.packages);
    state.dirty = {};
    state.newSeq = 0;

    renderDeviceStrip(state.model);
    renderWifi();
    renderFirewall();
    renderAlg();
    renderAccess();
    renderNetwork();
    renderAdvanced();
    updateChangeBar();

    if ($("cfgMain")) $("cfgMain").hidden = false;
    if ($("btnReload")) $("btnReload").disabled = false;
    var n = Object.keys(state.packages).length;
    setStatus(
      "ok",
      "Configuration loaded (" + n + " UCI package" + (n === 1 ? "" : "s") + ")"
    );
    setCommitPill("idle");
  }

  function loadConfig(profile) {
    /*
     * Default: helpdesk (wireless/firewall/dhcp/system/… — enough for form
     * tabs). Use profile "all" for every /etc/config package (slower).
     */
    var prof = profile || "helpdesk";
    return capture(prof).then(function (j) {
      if (!j || j.status !== "ok") {
        if (j && (j.status === "error" || j.ok === false)) {
          setStatus(
            "error",
            (j.err || j.error || "Could not load configuration") +
              " — is the router online with USP?"
          );
        } else if (!j) {
          /* pollUntilDone already set a timeout/error status */
        } else {
          setStatus(
            "error",
            "Unexpected status “" +
              (j.status || "?") +
              "” from router"
          );
        }
        return;
      }
      var pkgs =
        j.model && j.model.openwrt_uci && j.model.openwrt_uci.packages;
      if (!pkgs || !Object.keys(pkgs).length) {
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
    var params = [];
    var applyLines = [];
    var i;

    for (i = 0; i < changes.length; i++) {
      var c = changes[i];
      if (c.pkgText) {
        /* Flush pending apply lines first, then Text set. */
        if (applyLines.length) {
          flushApplyChunks(params, applyLines);
          applyLines = [];
        }
        params.push({
          path: "Device.X_ECOEC_OpenWrt.UCI." + c.pkgText.pkg + ".Text",
          value: c.pkgText.text
        });
      } else if (c.apply) {
        applyLines.push(c.apply);
      }
    }
    if (applyLines.length) {
      flushApplyChunks(params, applyLines);
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

  function flushApplyChunks(params, lines) {
    var chunk = "";
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
    /* Reload model from last packages snapshot without re-fetch. */
    applyModel({ model: state.model, status: "ok" });
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
    for (i = 0; i < TAB_IDS.length; i++) {
      var p = $("panel-" + TAB_IDS[i]);
      if (p) {
        p.hidden = TAB_IDS[i] !== id;
        p.classList.toggle("active", TAB_IDS[i] === id);
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
    if ($("btnLoad"))
      $("btnLoad").addEventListener("click", function () {
        loadConfig("helpdesk");
      });
    if ($("btnLoadAll"))
      $("btnLoadAll").addEventListener("click", function () {
        loadConfig("all");
      });
    if ($("btnReload"))
      $("btnReload").addEventListener("click", function () {
        loadConfig(state.captureProfile || "helpdesk");
      });
    if ($("btnReview")) $("btnReview").addEventListener("click", openReview);
    if ($("btnDiscard")) $("btnDiscard").addEventListener("click", discardEdits);
    if ($("btnReviewCancel"))
      $("btnReviewCancel").addEventListener("click", closeReview);
    if ($("btnApplyConfirmed"))
      $("btnApplyConfirmed").addEventListener("click", doApplyConfirmed);
    if ($("btnConfirm")) $("btnConfirm").addEventListener("click", doConfirm);
    if ($("btnRollback")) $("btnRollback").addEventListener("click", doRollback);
    if ($("btnFwAddRule"))
      $("btnFwAddRule").addEventListener("click", addFirewallRule);
    if ($("btnFwAddRedir"))
      $("btnFwAddRedir").addEventListener("click", addFirewallRedirect);
    if ($("btnAddUser")) $("btnAddUser").addEventListener("click", addUser);
    if ($("btnAddLease")) $("btnAddLease").addEventListener("click", addLease);
    if ($("advFilter")) {
      $("advFilter").addEventListener("input", function () {
        renderAdvanced();
      });
    }

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
