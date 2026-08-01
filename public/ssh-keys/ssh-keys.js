/* SSH public-key inventory SPA (PR-6 / ADR-033) */
(function () {
  function $(id) {
    return document.getElementById(id);
  }

  async function fetchText(url, opts) {
    var r = await fetch(
      url,
      Object.assign({ credentials: "same-origin" }, opts || {})
    );
    var body = await r.text();
    return { status: r.status, body: body, ok: r.ok };
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  async function refreshStatus() {
    var r = await fetchText("/api/v1/ssh-keys/status");
    $("statusOut").textContent = "HTTP " + r.status + "\n" + r.body;
  }

  async function listKeys() {
    var q = [];
    var p = $("purposeFilter").value;
    var e = $("enabledFilter").value;
    if (p) q.push("purpose=" + encodeURIComponent(p));
    if (e) q.push("enabled=" + encodeURIComponent(e));
    var url = "/api/v1/ssh-keys" + (q.length ? "?" + q.join("&") : "");
    var r = await fetchText(url);
    var tbody = $("keyBody");
    tbody.innerHTML = "";
    if (!r.ok) {
      $("keyDetail").textContent = "HTTP " + r.status + "\n" + r.body;
      return;
    }
    try {
      var j = JSON.parse(r.body);
      (j.keys || []).forEach(function (k) {
        var tr = document.createElement("tr");
        tr.innerHTML =
          "<td>" +
          k.id +
          "</td>" +
          "<td class=\"kind\">" +
          esc(k.name) +
          "</td>" +
          "<td>" +
          esc(k.purpose) +
          "</td>" +
          "<td>" +
          esc(k.algorithm) +
          "</td>" +
          "<td class=\"mono\">" +
          esc(k.fingerprint_sha256) +
          "</td>" +
          "<td>" +
          (k.enabled ? "yes" : "no") +
          "</td>" +
          "<td>" +
          esc(k.material_status) +
          "</td>" +
          "<td></td>";
        var td = tr.querySelector("td:last-child");
        var b1 = document.createElement("button");
        b1.type = "button";
        b1.className = "ghost";
        b1.textContent = "View";
        b1.onclick = function () {
          viewKey(k.id);
        };
        td.appendChild(b1);
        if (!k.revoked) {
          var b2 = document.createElement("button");
          b2.type = "button";
          b2.textContent = "Revoke";
          b2.onclick = function () {
            revokeKey(k.id);
          };
          td.appendChild(b2);
        }
        var b3 = document.createElement("button");
        b3.type = "button";
        b3.className = "ghost";
        b3.textContent = "Bindings";
        b3.onclick = function () {
          $("bindKeyId").value = String(k.id);
          listBindings();
        };
        td.appendChild(b3);
        tbody.appendChild(tr);
      });
      if (!(j.keys || []).length) {
        tbody.innerHTML =
          "<tr><td colspan=\"8\" class=\"muted-cell\">No keys (or plugin disabled)</td></tr>";
      }
    } catch (err) {
      $("keyDetail").textContent = r.body;
    }
  }

  async function viewKey(id) {
    var r = await fetchText("/api/v1/ssh-keys/" + id);
    $("keyDetail").textContent = "HTTP " + r.status + "\n" + r.body;
    $("bindKeyId").value = String(id);
  }

  async function revokeKey(id) {
    if (!confirm("Revoke key " + id + " and unbind?")) return;
    var r = await fetchText("/api/v1/ssh-keys/" + id + "/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unbind: true, reason: "admin" })
    });
    $("keyDetail").textContent = "HTTP " + r.status + "\n" + r.body;
    await listKeys();
    await refreshStatus();
  }

  async function listPending() {
    var r = await fetchText("/api/v1/ssh-keys/pending-pins");
    var tbody = $("pendingBody");
    tbody.innerHTML = "";
    $("pendingOut").textContent = "";
    if (!r.ok) {
      $("pendingOut").textContent = "HTTP " + r.status + "\n" + r.body;
      return;
    }
    try {
      var j = JSON.parse(r.body);
      (j.pending_pins || []).forEach(function (k) {
        var tr = document.createElement("tr");
        tr.innerHTML =
          "<td>" +
          k.id +
          "</td>" +
          "<td>" +
          esc(k.name) +
          "</td>" +
          "<td class=\"mono\">" +
          esc(k.fingerprint_sha256) +
          "</td>" +
          "<td>" +
          esc(k.comment) +
          "</td>" +
          "<td></td>";
        var td = tr.querySelector("td:last-child");
        var b1 = document.createElement("button");
        b1.type = "button";
        b1.textContent = "Confirm";
        b1.onclick = function () {
          confirmPin(k.id);
        };
        var b2 = document.createElement("button");
        b2.type = "button";
        b2.className = "ghost";
        b2.textContent = "Reject";
        b2.onclick = function () {
          rejectPin(k.id);
        };
        td.appendChild(b1);
        td.appendChild(b2);
        tbody.appendChild(tr);
      });
      if (!(j.pending_pins || []).length) {
        tbody.innerHTML =
          "<tr><td colspan=\"5\" class=\"muted-cell\">No pending pins</td></tr>";
      }
    } catch (err) {
      $("pendingOut").textContent = r.body;
    }
  }

  async function confirmPin(id) {
    var r = await fetchText(
      "/api/v1/ssh-keys/pending-pins/" + id + "/confirm",
      { method: "POST" }
    );
    $("pendingOut").textContent = "HTTP " + r.status + "\n" + r.body;
    await listPending();
    await listKeys();
  }

  async function rejectPin(id) {
    if (!confirm("Delete pending pin " + id + "?")) return;
    var r = await fetchText(
      "/api/v1/ssh-keys/pending-pins/" + id + "/reject",
      { method: "POST" }
    );
    $("pendingOut").textContent = "HTTP " + r.status + "\n" + r.body;
    await listPending();
  }

  async function generateKey() {
    var body = {
      name: $("genName").value,
      purpose: $("genPurpose").value
    };
    if ($("genAlgo").value) body.algorithm = $("genAlgo").value;
    var r = await fetchText("/api/v1/ssh-keys/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    $("genOut").textContent = "HTTP " + r.status + "\n" + r.body;
    await listKeys();
    await refreshStatus();
  }

  async function importKey() {
    var body = {
      name: $("impName").value,
      purpose: $("impPurpose").value,
      public_key: $("impPub").value.trim(),
      enabled: true,
      password_allowed: $("impPwAllowed").checked
    };
    if ($("impEntityType").value) {
      body.entity_type = $("impEntityType").value;
      body.entity_id = $("impEntityId").value || "*";
    }
    var r = await fetchText("/api/v1/ssh-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    $("impOut").textContent = "HTTP " + r.status + "\n" + r.body;
    await listKeys();
  }

  async function listBindings() {
    var id = parseInt($("bindKeyId").value, 10);
    if (!id) {
      $("bindOut").textContent = "set key id";
      return;
    }
    var r = await fetchText("/api/v1/ssh-keys/" + id + "/bindings");
    $("bindOut").textContent = "HTTP " + r.status + "\n" + r.body;
  }

  async function addBinding() {
    var id = parseInt($("bindKeyId").value, 10);
    if (!id) {
      $("bindOut").textContent = "set key id";
      return;
    }
    var r = await fetchText("/api/v1/ssh-keys/" + id + "/bindings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entity_type: $("bindEntityType").value,
        entity_id: $("bindEntityId").value,
        priority: parseInt($("bindPri").value, 10) || 100,
        password_allowed: $("bindPw").checked,
        enabled: true
      })
    });
    $("bindOut").textContent = "HTTP " + r.status + "\n" + r.body;
    await listBindings();
  }

  async function listEvents() {
    var q = [];
    if ($("evEntity").value)
      q.push("entity_id=" + encodeURIComponent($("evEntity").value));
    if ($("evPath").value)
      q.push("path=" + encodeURIComponent($("evPath").value));
    var url =
      "/api/v1/ssh-keys/auth-events" + (q.length ? "?" + q.join("&") : "");
    var r = await fetchText(url);
    $("eventsOut").textContent = "HTTP " + r.status + "\n" + r.body;
  }

  async function refreshAll() {
    await refreshStatus();
    await listPending();
    await listKeys();
  }

  if ($("btnStatus")) $("btnStatus").addEventListener("click", refreshStatus);
  if ($("btnList")) $("btnList").addEventListener("click", listKeys);
  if ($("purposeFilter"))
    $("purposeFilter").addEventListener("change", listKeys);
  if ($("enabledFilter"))
    $("enabledFilter").addEventListener("change", listKeys);
  if ($("btnPending")) $("btnPending").addEventListener("click", listPending);
  if ($("btnGenerate")) $("btnGenerate").addEventListener("click", generateKey);
  if ($("btnImport")) $("btnImport").addEventListener("click", importKey);
  if ($("btnBindList")) $("btnBindList").addEventListener("click", listBindings);
  if ($("btnBindAdd")) $("btnBindAdd").addEventListener("click", addBinding);
  if ($("btnEvents")) $("btnEvents").addEventListener("click", listEvents);

  refreshAll();
})();
