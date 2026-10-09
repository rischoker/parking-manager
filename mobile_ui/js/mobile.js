/* ParkingManager -- customer-facing mobile pages. Vanilla JS, no CDN. */
const PM = (() => {
  "use strict";

  const TOKEN_KEY = "pm_session_token";

  function qs(name) {
    return new URLSearchParams(window.location.search).get(name);
  }

  function currentLocale() {
    return getLang() === "es" ? "es-CO" : "en-US";
  }

  function money(amount, currency) {
    const n = Math.round(Number(amount) || 0);
    return "$" + n.toLocaleString("en-US") + " " + (currency || "COP");
  }

  function fmtMinutes(min) {
    min = Math.max(0, Math.round(min));
    const h = Math.floor(min / 60), m = min % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  // The server sends naive timestamps that already represent the parking
  // booth's LOCAL time -- a date-time string with no "Z"/offset is parsed
  // by the browser as local time already, so no manual UTC shift here.
  function fmtClock(iso) {
    if (!iso) return "--";
    const d = new Date(iso);
    return d.toLocaleTimeString(currentLocale(), { hour: "2-digit", minute: "2-digit" });
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---------------- Registration page ----------------
  function initRegisterPage() {
    applyStaticTranslations(document);
    document.documentElement.setAttribute("lang", getLang());
    wireLanguageToggle(); // static-only page -- no dynamic session data to re-render

    const btn = document.getElementById("submit-btn");
    const errBox = document.getElementById("error-box");

    async function submit() {
      const name = document.getElementById("f-name").value.trim();
      const plate = document.getElementById("f-plate").value.trim();
      const phone = document.getElementById("f-phone").value.trim();
      errBox.classList.remove("show");

      if (name.length < 2) { showError(t("error.enter_name")); return; }
      if (plate.length < 2) { showError(t("error.enter_plate")); return; }
      // Same rules the server enforces (app/schemas.py), so a typo is caught
      // here with a clear message instead of after a round trip.
      if (!/^[A-Za-z0-9-]{2,12}$/.test(plate.replace(/\s+/g, ""))) { showError(t("error.plate_format")); return; }
      if (phone && !/^\+?\(?[0-9][0-9 ()-]{5,28}$/.test(phone)) { showError(t("error.phone_format")); return; }

      btn.disabled = true;
      btn.textContent = t("btn.registering");
      try {
        const res = await fetch("/api/customer/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, plate, phone: phone || null }),
        });
        const data = await res.json();
        // FastAPI answers validation failures (HTTP 422) with a LIST in
        // `detail`; passing that to Error() used to show "[object Object]".
        if (!res.ok) throw new Error(typeof data.detail === "string" ? data.detail : t("err.invalid_data"));
        localStorage.setItem(TOKEN_KEY, data.session_token);
        window.location.href = data.session_url;
      } catch (e) {
        showError(translateServerMessage(e.message));
        btn.disabled = false;
        btn.textContent = t("btn.register_vehicle");
      }
    }

    function showError(msg) {
      errBox.textContent = msg;
      errBox.classList.add("show");
    }

    btn.addEventListener("click", submit);
    document.querySelectorAll(".field input").forEach(inp =>
      inp.addEventListener("keydown", e => { if (e.key === "Enter") submit(); }));
  }

  // ---------------- Session view page ----------------
  function initSessionPage() {
    applyStaticTranslations(document);
    document.documentElement.setAttribute("lang", getLang());

    let token = qs("token") || localStorage.getItem(TOKEN_KEY);
    const content = document.getElementById("content");
    let lastData = null;
    let lastErrorState = null; // {title, sub} when showing an error/empty state

    wireLanguageToggle(() => {
      // Re-render in place with whatever we last fetched -- no need to
      // hit the network again just because the language changed.
      if (lastData) render(lastData);
      else if (lastErrorState) content.innerHTML = emptyStateHtml(t(lastErrorState.titleKey), t(lastErrorState.subKey));
    });

    if (!token) {
      lastErrorState = { titleKey: "no_session.title", subKey: "no_session.sub" };
      content.innerHTML = emptyStateHtml(t("no_session.title"), t("no_session.sub"));
      return;
    }
    localStorage.setItem(TOKEN_KEY, token);

    let pollTimer = null;

    async function load() {
      try {
        const res = await fetch(`/api/customer/session/${token}`);
        const data = await res.json();
        if (!res.ok) {
          clearInterval(pollTimer);
          const titleKey = res.status === 410 ? "session_gone.title" : "session_not_found.title";
          lastErrorState = { titleKey, subKey: "session_default.sub" };
          lastData = null;
          content.innerHTML = emptyStateHtml(t(titleKey), translateServerMessage(data.detail) || t("session_default.sub"));
          return;
        }
        lastData = data;
        lastErrorState = null;
        render(data);
        if (data.is_final) clearInterval(pollTimer);
      } catch (e) {
        lastErrorState = { titleKey: "connection_problem.title", subKey: "connection_problem.sub" };
        lastData = null;
        content.innerHTML = emptyStateHtml(t("connection_problem.title"), t("connection_problem.sub"));
      }
    }

    function render(s) {
      const statusNote = s.message
        ? `<div class="status-note${s.is_final ? " final" : ""}">${escapeHtml(translateServerMessage(s.message))}</div>`
        : "";

      content.innerHTML = `
        <div class="session-header">
          <div class="eyebrow">${t("session.eyebrow")}</div>
          <div class="plate-badge">${escapeHtml(s.plate)}</div>
        </div>
        <div class="space-line">${t("session.space_label")} <strong>${s.space_number || t("session.awaiting")}</strong></div>
        ${statusNote}
        <div class="stat-grid">
          <div class="stat-box"><div class="label">${t("session.entry")}</div><div class="value">${fmtClock(s.entry_timestamp)}</div></div>
          <div class="stat-box"><div class="label">${s.is_final ? t("session.exit") : t("session.elapsed")}</div><div class="value">${s.is_final ? fmtClock(s.exit_timestamp) : fmtMinutes(s.elapsed_minutes)}</div></div>
        </div>
        <div class="charge-box">
          <div class="label">${s.is_final ? t("session.final_charge") : t("session.current_charge")}</div>
          <div class="amount">${money(s.estimated_amount, s.currency)}</div>
          <div class="footnote">${s.is_final ? t("session.footnote_final") : t("session.footnote_active")}</div>
        </div>
        ${s.is_final ? "" : `<button class="refresh-btn" id="manual-refresh">${t("btn.refresh_now")}</button>`}
        ${s.status_page_url ? `<a class="status-page-link" href="${escapeHtml(s.status_page_url)}" target="_blank" rel="noopener">${t("session.check_anywhere")}</a>` : ""}
      `;
      const rb = document.getElementById("manual-refresh");
      if (rb) rb.addEventListener("click", load);
    }

    function emptyStateHtml(title, sub) {
      return `<h1 style="text-align:center">${escapeHtml(title)}</h1>
        <p class="hint" style="text-align:center">${escapeHtml(sub)}</p>
        <button class="refresh-btn" onclick="location.reload()">${t("btn.retry")}</button>`;
    }

    load();
    pollTimer = setInterval(load, 15000);
  }

  return { initRegisterPage, initSessionPage };
})();
