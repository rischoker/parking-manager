/* ParkingManager -- "check my status from anywhere" page.
 * Fully static: no backend of its own. Reads a session's current state
 * directly from a Google Sheet via the Apps Script deployed alongside
 * Cloud Backup (see CLOUD_BACKUP.md), and computes the live fare estimate
 * right here in the browser using pricing_engine.js. */
(() => {
  "use strict";

  // ---------------------------------------------------------------------
  // CONFIGURE THIS before deploying to GitHub Pages: paste the Web App
  // URL from your Apps Script deployment (Deploy -> Manage deployments in
  // the Apps Script editor -- the same URL used in ParkingManager's
  // Settings -> Cloud Backup). See GITHUB_PAGES_STATUS.md.
  // ---------------------------------------------------------------------
  const APPS_SCRIPT_URL = "PASTE_YOUR_APPS_SCRIPT_WEB_APP_URL_HERE";

  // When this same page is served by the Cloudflare service (cloud_worker/),
  // a generated js/config.js sets window.PARKING_STATUS_ENDPOINT = "/api/session"
  // and the page reads from there instead of from Google. On GitHub Pages
  // that file does not exist and nothing changes.
  const ENDPOINT = window.PARKING_STATUS_ENDPOINT || APPS_SCRIPT_URL;

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

  function fmtClock(iso) {
    if (!iso) return "--";
    const d = new Date(iso);
    return d.toLocaleTimeString(currentLocale(), { hour: "2-digit", minute: "2-digit" });
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function emptyStateHtml(title, sub) {
    return `<h1 style="text-align:center">${escapeHtml(title)}</h1>
      <p class="hint" style="text-align:center">${escapeHtml(sub)}</p>
      <button class="refresh-btn" data-reload>${t("btn.retry")}</button>`;
  }

  function init() {
    // No inline event handlers (the page may be served with a strict Content-Security-Policy).
    document.addEventListener("click", e => { if (e.target.closest("[data-reload]")) location.reload(); });
    applyStaticTranslations(document);
    document.documentElement.setAttribute("lang", getLang());

    const content = document.getElementById("content");
    let lastRecord = null;
    let pollTimer = null;

    wireLanguageToggle(() => { if (lastRecord) render(lastRecord); });

    if (!ENDPOINT || ENDPOINT.indexOf("PASTE_YOUR") === 0) {
      content.innerHTML = emptyStateHtml(t("status_page.eyebrow"), t("status_page.not_configured"));
      return;
    }

    const token = qs("token");
    if (!token) {
      content.innerHTML = emptyStateHtml(t("no_session.title"), t("status_page.no_token"));
      return;
    }

    async function load() {
      try {
        const url = ENDPOINT + (ENDPOINT.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token);
        const res = await fetch(url);
        const data = await res.json();
        if (!data.ok) {
          clearInterval(pollTimer);
          content.innerHTML = emptyStateHtml(t("session_not_found.title"), data.error || t("session_default.sub"));
          return;
        }
        lastRecord = data.record;
        render(lastRecord);
        if (lastRecord.status === "COMPLETED" || lastRecord.status === "CANCELLED") {
          clearInterval(pollTimer);
        }
      } catch (e) {
        content.innerHTML = emptyStateHtml(t("connection_problem.title"), t("status_page.fetch_error"));
      }
    }

    function render(r) {
      const isFinal = r.status === "COMPLETED";
      const isCancelled = r.status === "CANCELLED";
      const entry = r.entry_timestamp ? new Date(r.entry_timestamp) : null;

      let minutes, amount;
      if (isFinal && r.final_amount != null) {
        minutes = null;
        amount = Number(r.final_amount);
      } else if (entry) {
        const referenceEnd = r.exit_timestamp ? new Date(r.exit_timestamp) : new Date();
        const priced = priceSession(entry, referenceEnd, r.pricing_type, r.pricing_config_json);
        minutes = priced.minutes;
        amount = priced.amount;
      } else {
        minutes = 0; amount = 0;
      }

      if (isCancelled) {
        content.innerHTML = emptyStateHtml(t("session_gone.title"), "");
        return;
      }

      const statusNote = r.status === "PENDING_ASSIGNMENT"
        ? `<div class="status-note">${escapeHtml(t("session.waiting_msg"))}</div>`
        : (isFinal ? `<div class="status-note final">${escapeHtml(t("session.complete"))}</div>` : "");

      content.innerHTML = `
        <div class="session-header">
          <div class="eyebrow">${t("status_page.eyebrow")}</div>
          <div class="plate-badge">${escapeHtml(r.plate || "")}</div>
        </div>
        <div class="space-line">${t("session.space_label")} <strong>${r.space_number ? escapeHtml(r.space_number) : t("session.awaiting")}</strong></div>
        ${statusNote}
        <div class="stat-grid">
          <div class="stat-box"><div class="label">${t("session.entry")}</div><div class="value">${fmtClock(r.entry_timestamp)}</div></div>
          <div class="stat-box"><div class="label">${isFinal ? t("session.exit") : t("session.elapsed")}</div><div class="value">${isFinal ? fmtClock(r.exit_timestamp) : fmtMinutes(minutes)}</div></div>
        </div>
        <div class="charge-box">
          <div class="label">${isFinal ? t("session.final_charge") : t("session.current_charge")}</div>
          <div class="amount">${money(amount, r.currency)}</div>
          <div class="footnote">${isFinal ? t("session.footnote_final") : t("session.footnote_active")}</div>
        </div>
        ${isFinal ? "" : `<button class="refresh-btn" id="manual-refresh">${t("btn.refresh_now")}</button>`}
      `;
      const rb = document.getElementById("manual-refresh");
      if (rb) rb.addEventListener("click", load);
    }

    load();
    pollTimer = setInterval(load, 15000);
  }

  init();
})();
