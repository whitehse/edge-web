(function () {
  function $(id) { return document.getElementById(id); }

  async function load() {
    const r = await fetch("/api/v1/outages", { credentials: "same-origin" });
    const d = await r.json();
    const el = $("list");
    if (!r.ok) {
      el.textContent = "Failed: " + (d && d.error ? d.error : r.status);
      return;
    }
    const items = (d && d.outages) || [];
    if (!items.length) {
      el.innerHTML = "<p class=\"hint\">No outages.</p>";
      return;
    }
    el.innerHTML = items.map(function (o) {
      var sev = o.severity || "info";
      var sevCls =
        sev === "critical" || sev === "major"
          ? "badge bad"
          : sev === "minor"
            ? "badge warn"
            : "badge";
      var member = o.member_label
        ? " <span class=\"hint\">(" + esc(o.member_label) + ")</span>"
        : "";
      return (
        "<div class=\"panel-list-item\" style=\"display:block;padding:0.75rem 0;border-bottom:1px solid var(--border)\">" +
        "<strong>" + esc(o.title) + "</strong> " +
        "<span class=\"" + sevCls + "\">" + esc(sev) + " · " + esc(o.status) + "</span>" +
        member +
        "<div class=\"hint\">" + esc(o.summary || "") + "</div>" +
        "<div class=\"hint\">scope " + esc(o.scope_type) + " " +
        esc((o.scope_ids || []).join(", ")) + "</div></div>"
      );
    }).join("");
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  async function create() {
    const body = {
      title: $("title").value,
      severity: $("severity").value,
      status: "open",
      summary: $("summary").value,
      scope_type: $("scopeType").value,
      scope_id: $("scopeId").value
    };
    const r = await fetch("/api/v1/outages", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const d = await r.json();
    $("out").textContent = JSON.stringify(d, null, 2);
    await load();
  }

  document.addEventListener("DOMContentLoaded", async function () {
    if (window.EdgeShell && EdgeShell.requireAuth) {
      if (!(await EdgeShell.requireAuth())) return;
    }
    $("btnCreate").addEventListener("click", create);
    load();
  });
})();
