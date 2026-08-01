/**
 * Member portal boot — customer session + /api/v1/me/* status.
 */
(function () {
  function $(id) {
    return document.getElementById(id);
  }

  function show(el, on) {
    if (!el) return;
    el.classList.toggle("hidden", !on);
  }

  async function me() {
    const r = await fetch("/auth/me", { credentials: "same-origin" });
    if (!r.ok) return null;
    return r.json();
  }

  async function customerLogin(accountId, password) {
    const r = await fetch("/auth/lab-customer-login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        password: password,
        account_id: accountId,
        router_id: accountId === "A-10428" ? "cpe-lab" : ""
      })
    });
    return r.json();
  }

  async function loadStatus() {
    const r = await fetch("/api/v1/me/status", { credentials: "same-origin" });
    if (r.status === 404) {
      return { error: "FEATURE_DISABLED" };
    }
    if (!r.ok) return null;
    return r.json();
  }

  function paintStatus(d, auth) {
    const svc = (d && d.service) || {};
    const ont = svc.ont || {};
    const cpe = svc.cpe || {};
    const st = svc.status || "unknown";
    const pill = $("statusPill");
    if (pill) {
      pill.textContent =
        st === "ok" ? "Service OK" : st === "down" ? "Service down" : st === "degraded" ? "Degraded" : "Status unknown";
      pill.className = "status-pill " + (st === "ok" ? "ok" : st === "down" ? "down" : st === "degraded" ? "degraded" : "");
    }
    if ($("ontStatus")) $("ontStatus").textContent = ont.status || "—";
    if ($("ontMeta")) {
      const rx = ont.rx_dbm != null ? ont.rx_dbm + " dBm" : "rx —";
      $("ontMeta").textContent = rx + " · PON " + (ont.pon_state || "—");
    }
    if ($("cpeId")) $("cpeId").textContent = cpe.router_id || "—";
    if ($("cpeOnline")) {
      $("cpeOnline").textContent = cpe.online ? "online" : "offline / unknown";
    }
    if ($("accountLine") && auth) {
      $("accountLine").textContent =
        "Signed in as " + (auth.account_id || auth.sub || "member");
    }
  }

  async function boot() {
    const Shell = window.EdgeShell;
    if (Shell && typeof Shell.mount === "function") {
      /* member nav injected via data attributes; operator shell may still mount */
    }

    let auth = await me();
    const isCustomer =
      auth &&
      (auth.account_id ||
        (Array.isArray(auth.roles) && auth.roles.indexOf("customer") >= 0));

    if (!isCustomer) {
      show($("loginGate"), true);
      show($("portalRoot"), false);
      const btn = $("btnLogin");
      if (btn) {
        btn.addEventListener("click", async function () {
          const acct = ($("acctId") && $("acctId").value) || "";
          const pw = ($("labPw") && $("labPw").value) || "";
          const out = $("authOut");
          try {
            const res = await customerLogin(acct, pw);
            if (out) {
              out.classList.remove("hidden");
              out.textContent = JSON.stringify(res, null, 2);
            }
            if (res && res.ok) {
              location.reload();
            }
          } catch (e) {
            if (out) {
              out.classList.remove("hidden");
              out.textContent = String(e);
            }
          }
        });
      }
      return;
    }

    show($("loginGate"), false);
    show($("portalRoot"), true);

    if (Shell && typeof Shell.mount === "function") {
      try {
        Shell.mount();
      } catch (e) {
        /* optional */
      }
    }

    const st = await loadStatus();
    if (st && st.error === "FEATURE_DISABLED") {
      if ($("statusPill")) {
        $("statusPill").textContent = "Customer API off (enable features.customer_api)";
      }
      return;
    }
    paintStatus(st, auth);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
