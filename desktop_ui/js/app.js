/* ParkingManager admin console -- vanilla JS, no build step, no CDN. */
(() => {
  "use strict";

  const TOKEN_KEY = "pm_admin_token";
  const ROLE_KEY = "pm_admin_role";
  const NAME_KEY = "pm_admin_name";
  const USERNAME_KEY = "pm_admin_username";
  let currentCurrency = "COP";
  let refreshTimer = null;

  function currentLocale() {
    return getLang() === "es" ? "es-CO" : "en-US";
  }

  function currentRole() {
    return localStorage.getItem(ROLE_KEY) || "ATTENDANT";
  }
  function isAdmin() {
    return currentRole() === "ADMIN";
  }

  // ------------------------------------------------------------------
  // API helper
  // ------------------------------------------------------------------
  async function api(path, opts = {}) {
    const headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
    const token = localStorage.getItem(TOKEN_KEY);
    if (token) headers["Authorization"] = "Bearer " + token;

    const res = await fetch(path, Object.assign({}, opts, { headers }));
    if (res.status === 401) {
      showLogin(t("err.session_expired"));
      throw new Error("unauthorized");
    }
    let body = null;
    const text = await res.text();
    try { body = text ? JSON.parse(text) : null; } catch (e) { body = text; }
    if (!res.ok) {
      throw new Error(detailToMessage(body, res.status));
    }
    return body;
  }

  // FastAPI sends a plain string for the errors we raise ourselves, but a LIST
  // of objects for request-validation failures (HTTP 422). Passing that list to
  // Error() produced the useless "[object Object]" in the toast.
  function detailToMessage(body, status) {
    const detail = body && body.detail;
    if (typeof detail === "string" && detail) return detail;
    if (Array.isArray(detail) && detail.length) {
      const fields = detail
        .map(d => (d && Array.isArray(d.loc) ? d.loc[d.loc.length - 1] : null))
        .filter(f => f && f !== "body");
      return t("err.invalid_data") + (fields.length ? ` (${[...new Set(fields)].join(", ")})` : "");
    }
    return `Request failed (${status})`;
  }

  function money(amount) {
    const n = Math.round(Number(amount) || 0);
    return "$" + n.toLocaleString("en-US") + " " + currentCurrency;
  }

  function fmtMinutes(min) {
    min = Math.max(0, Math.round(min));
    const h = Math.floor(min / 60), m = min % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  // The server sends naive timestamps that already represent the parking
  // booth's LOCAL time (see app/config.py: "Time source" -- everything
  // uses datetime.now(), not UTC). A date-time string with no "Z"/offset
  // is parsed by the browser as local time already, so we parse it as-is
  // -- no manual UTC conversion needed or wanted here.
  function fmtTime(iso) {
    if (!iso) return "--";
    const d = new Date(iso);
    return d.toLocaleString(currentLocale(), { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  }
  function fmtClock(iso) {
    if (!iso) return "--";
    const d = new Date(iso);
    return d.toLocaleTimeString(currentLocale(), { hour: "2-digit", minute: "2-digit" });
  }
  function fmtDate(iso) {
    if (!iso) return "--";
    const d = new Date(iso);
    return d.toLocaleDateString(currentLocale(), { year: "numeric", month: "short", day: "2-digit" });
  }

  function toast(message, kind = "success") {
    const container = document.getElementById("toast-container");
    const el = document.createElement("div");
    el.className = `toast ${kind}`;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => el.remove(), 3800);
  }

  function toastError(err) {
    toast(translateServerMessage(err.message), "error");
  }

  function statusLabel(status) {
    return t(`status.${status.toLowerCase()}`);
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // Second line shown under a customer's name: who they are (resident /
  // visitor / service), where they are going, whom they visit and the vehicle.
  function whoLine(o) {
    if (!o) return "";
    const bits = [];
    if (o.unit) bits.push(escapeHtml(o.unit));
    if (o.visiting) bits.push(t("who.visiting", { name: escapeHtml(o.visiting) }));
    if (o.vehicle) bits.push(escapeHtml(o.vehicle));
    const type = o.person_type || "VISITOR";
    return `<div class="who-line"><span class="person-badge ${escapeHtml(type)}">${escapeHtml(t("person." + type))}</span>${bits.join(" &middot; ")}</div>`;
  }

  function fmtDateTime(iso) {
    if (!iso) return "--";
    return new Date(iso).toLocaleString(currentLocale(), {
      year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  }

  // ------------------------------------------------------------------
  // Language
  // ------------------------------------------------------------------
  function applyLanguage() {
    document.getElementById("html-root").setAttribute("lang", getLang());
    document.querySelectorAll(".lang-btn").forEach(b => b.classList.toggle("active", b.dataset.lang === getLang()));
    applyStaticTranslations(document);
    const el = document.getElementById("view-title");
    if (el) el.textContent = t(VIEW_TITLE_KEYS[activeViewName()] || "nav.dashboard");
    if (document.getElementById("app").style.display !== "none") {
      applyRoleVisibility();
      updateCurrentUserLine();
      loadView(activeViewName());
    }
  }

  function wireLanguageToggle() {
    document.querySelectorAll(".lang-btn").forEach(btn =>
      btn.addEventListener("click", () => { setLang(btn.dataset.lang); applyLanguage(); }));
  }

  // ------------------------------------------------------------------
  // Role-based UI visibility (server-side enforcement is what actually
  // matters -- see require_full_admin in app/routers/admin.py -- this is
  // just so a Vigilante/Attendant account isn't shown buttons for actions
  // that would just 403 if clicked)
  // ------------------------------------------------------------------
  function applyRoleVisibility() {
    document.querySelectorAll(".admin-only").forEach(el => {
      el.style.display = isAdmin() ? "" : "none";
    });
    // If a restricted user is currently sitting on a now-hidden nav item
    // (e.g. their role changed), bounce them back to the dashboard.
    const activeNav = document.querySelector(".nav-item.active");
    if (activeNav && activeNav.classList.contains("admin-only") && !isAdmin()) {
      switchView("dashboard");
    }
  }

  function updateCurrentUserLine() {
    const name = localStorage.getItem(NAME_KEY) || "";
    document.getElementById("current-user-name").textContent = name;
    const badge = document.getElementById("current-user-role-badge");
    badge.textContent = t(`role.${currentRole()}`);
    badge.className = `role-badge ${currentRole()}`;
  }

  // ------------------------------------------------------------------
  // Auth / login
  // ------------------------------------------------------------------
  function showLogin(error) {
    stopAutoRefresh();
    document.getElementById("app").style.display = "none";
    document.getElementById("login-screen").style.display = "flex";
    document.getElementById("login-error").textContent = error || "";
    document.getElementById("pin-input").value = "";
    document.getElementById("username-input").focus();
  }

  async function attemptLogin() {
    const username = document.getElementById("username-input").value.trim();
    const pin = document.getElementById("pin-input").value.trim();
    if (!username || !pin) return;
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, pin }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(detailToMessage(data, res.status));
      localStorage.setItem(TOKEN_KEY, data.token);
      localStorage.setItem(ROLE_KEY, data.role);
      localStorage.setItem(NAME_KEY, data.display_name);
      localStorage.setItem(USERNAME_KEY, data.username);
      document.getElementById("login-screen").style.display = "none";
      document.getElementById("app").style.display = "flex";
      await bootstrapApp();
    } catch (e) {
      document.getElementById("login-error").textContent = translateServerMessage(e.message);
    }
  }

  function lockConsole() {
    api("/api/admin/logout", { method: "POST" }).catch(() => {});
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(ROLE_KEY);
    localStorage.removeItem(NAME_KEY);
    localStorage.removeItem(USERNAME_KEY);
    showLogin();
  }

  // ------------------------------------------------------------------
  // Navigation
  // ------------------------------------------------------------------
  const VIEW_TITLE_KEYS = {
    dashboard: "nav.dashboard", active: "nav.active", history: "nav.history",
    revenue: "nav.revenue", pricing: "nav.pricing", schedules: "nav.schedules",
    monthly: "nav.monthly", users: "nav.users", settings: "nav.settings", qr: "nav.qr",
    audit: "nav.audit",
  };

  function switchView(name) {
    document.querySelectorAll(".nav-item").forEach(el => el.classList.toggle("active", el.dataset.view === name));
    document.querySelectorAll(".view").forEach(el => el.classList.toggle("active", el.id === "view-" + name));
    document.getElementById("view-title").textContent = t(VIEW_TITLE_KEYS[name] || name);
    loadView(name);
  }

  function loadView(name) {
    if (name === "dashboard") loadDashboard();
    else if (name === "active") loadActive();
    else if (name === "history") loadHistory();
    else if (name === "revenue") loadRevenue();
    else if (name === "pricing") loadPricing();
    else if (name === "schedules") loadSchedules();
    else if (name === "monthly") loadMonthlyFees();
    else if (name === "audit") loadAudit(true);
    else if (name === "users") loadUsers();
    else if (name === "settings") loadSettings();
    else if (name === "qr") loadQr();
  }

  function activeViewName() {
    const el = document.querySelector(".view.active");
    return el ? el.id.replace("view-", "") : "dashboard";
  }

  // ------------------------------------------------------------------
  // Dashboard
  // ------------------------------------------------------------------
  async function loadDashboard() {
    let data;
    try { data = await api("/api/admin/dashboard"); } catch (e) { return; }
    currentCurrency = data.currency;

    document.getElementById("stat-available").textContent = data.available_count;
    document.getElementById("stat-occupied").textContent = data.occupied_count;
    document.getElementById("stat-monthly").textContent = data.monthly_count;
    document.getElementById("stat-pending").textContent = data.pending.length;
    document.getElementById("available-pill").textContent = t("topbar.available", { n: data.available_count });
    document.getElementById("occupied-pill").textContent = t("topbar.occupied", { n: data.occupied_count });
    document.getElementById("monthly-pill").textContent = t("topbar.monthly", { n: data.monthly_count });

    const pendingPanel = document.getElementById("pending-panel");
    pendingPanel.style.display = data.pending.length ? "block" : "none";
    document.getElementById("pending-table-body").innerHTML = data.pending.map(p => `
      <tr>
        <td>${escapeHtml(p.customer_name)}${whoLine(p)}</td>
        <td class="mono">${escapeHtml(p.plate)}</td>
        <td>${fmtMinutes(p.waiting_minutes)}</td>
        <td><button class="btn small primary" data-assign="${p.session_id}">${t("btn.assign_space")}</button></td>
      </tr>`).join("");
    pendingPanel.querySelectorAll("[data-assign]").forEach(btn =>
      btn.addEventListener("click", () => openAssignModal(btn.dataset.assign, data.spaces)));

    const grid = document.getElementById("space-grid");
    grid.innerHTML = data.spaces.map(renderSpaceCard).join("");
    grid.querySelectorAll(".space-card").forEach(card =>
      card.addEventListener("click", () => openSpaceCard(card.dataset.id, data.spaces)));

    if (isAdmin()) {
      api("/api/admin/revenue").then(r => {
        document.getElementById("stat-today-revenue").textContent = money(r.today.total_revenue);
      }).catch(() => {});
    }
  }

  function renderSpaceCard(space) {
    if (space.monthly) {
      const m = space.monthly;
      return `<div class="space-card monthly" data-id="${space.id}">
        <div class="space-card-head">
          <div class="space-number">${space.number}</div>
          <span class="led monthly"></span>
        </div>
        <div class="space-status-label">${t("dash.monthly")}${m.is_overdue ? `<span class="overdue-badge">${t("monthly.overdue")}</span>` : ""}</div>
        <div class="space-customer" style="margin-top:8px">${escapeHtml(m.customer_name)}</div>
        <div class="space-plate">${escapeHtml(m.plate)}</div>
        <div class="space-meta" style="margin-top:10px"><span>${m.currently_parked ? t("monthly.currently_parked") : t("monthly.not_parked")}</span></div>
      </div>`;
    }
    if (space.status === "AVAILABLE") {
      return `<div class="space-card available" data-id="${space.id}">
        <div class="space-card-head">
          <div class="space-number">${space.number}</div>
          <span class="led available"></span>
        </div>
        <div class="space-status-label">${t("space.available")}</div>
        <div class="space-empty-hint">${t("space.click_hint")}</div>
      </div>`;
    }
    const o = space.occupied;
    if (!o) {
      return `<div class="space-card occupied" data-id="${space.id}">
        <div class="space-card-head"><div class="space-number">${space.number}</div><span class="led occupied"></span></div>
        <div class="space-status-label">${t("space.occupied")}</div></div>`;
    }
    return `<div class="space-card occupied" data-id="${space.id}">
      <div class="space-card-head">
        <div class="space-number">${space.number}</div>
        <span class="led occupied"></span>
      </div>
      <div class="space-status-label">${t("space.occupied")}</div>
      <div class="space-plate">${escapeHtml(o.plate)}</div>
      <div class="space-customer">${escapeHtml(o.customer_name)}</div>
      ${whoLine(o)}
      <div class="space-meta"><span>${t("table.entry")} ${fmtClock(o.entry_timestamp)}</span><span>${fmtMinutes(o.elapsed_minutes)}</span></div>
      <div class="space-charge">${money(o.current_amount)}</div>
    </div>`;
  }

  function openSpaceCard(spaceId, spaces) {
    const space = spaces.find(s => String(s.id) === String(spaceId));
    if (!space) return;
    if (space.monthly) { switchView("monthly"); return; }
    if (space.status === "OCCUPIED" && space.occupied) { openSessionModal(space.occupied.session_id); }
  }

  // ------------------------------------------------------------------
  // Session detail / assign / exit modals
  // ------------------------------------------------------------------
  function openModal(id) { document.getElementById(id).classList.add("open"); }
  function closeModal(id) { document.getElementById(id).classList.remove("open"); }

  async function openSessionModal(sessionId) {
    let s;
    try { s = await api(`/api/admin/sessions/${sessionId}`); } catch (e) { toastError(e); return; }
    const body = document.getElementById("session-modal-body");
    const amount = s.status === "OCCUPIED" ? s.estimated_amount : s.final_amount;
    body.innerHTML = `
      <div class="ticket-id">TKT-${String(s.id).padStart(6, "0")}</div>
      <div class="big-amount">${amount != null ? money(amount) : "--"}</div>
      <div class="detail-row"><span class="k">${t("detail.customer")}</span><span class="v">${escapeHtml(s.customer_name)}</span></div>
      <div class="detail-row"><span class="k">${t("detail.plate")}</span><span class="v">${escapeHtml(s.plate)}</span></div>
      <div class="detail-row"><span class="k">${t("detail.phone")}</span><span class="v">${escapeHtml(s.phone || "--")}</span></div>
      <div class="detail-row"><span class="k">${t("detail.person_type")}</span><span class="v"><span class="person-badge ${escapeHtml(s.person_type)}">${escapeHtml(t("person." + s.person_type))}</span></span></div>
      ${s.unit ? `<div class="detail-row"><span class="k">${t("detail.unit")}</span><span class="v">${escapeHtml(s.unit)}</span></div>` : ""}
      ${s.visiting ? `<div class="detail-row"><span class="k">${t("detail.visiting")}</span><span class="v">${escapeHtml(s.visiting)}</span></div>` : ""}
      ${s.vehicle ? `<div class="detail-row"><span class="k">${t("detail.vehicle")}</span><span class="v">${escapeHtml(s.vehicle)}</span></div>` : ""}
      <div class="detail-row"><span class="k">${t("detail.space")}</span><span class="v">${s.space_number || "--"}</span></div>
      <div class="detail-row"><span class="k">${t("detail.entry")}</span><span class="v">${fmtTime(s.entry_timestamp)}</span></div>
      <div class="detail-row"><span class="k">${t("detail.exit")}</span><span class="v">${s.exit_timestamp ? fmtTime(s.exit_timestamp) : "--"}</span></div>
      <div class="detail-row"><span class="k">${t("detail.rate")}</span><span class="v">${escapeHtml(s.pricing_rule_name || "--")}</span></div>
      <div class="detail-row"><span class="k">${t("detail.registered_by")}</span><span class="v">${s.source === "MANUAL" ? escapeHtml(s.checked_in_by || "--") : t("who.qr")}</span></div>
      ${s.checked_out_by ? `<div class="detail-row"><span class="k">${t("detail.exit_by")}</span><span class="v">${escapeHtml(s.checked_out_by)}</span></div>` : ""}
      <div class="detail-row"><span class="k">${t("detail.status")}</span><span class="v"><span class="status-badge ${s.status}">${statusLabel(s.status)}</span></span></div>
      <div class="btn-row">
        ${s.status === "OCCUPIED" ? `<button class="btn primary" id="modal-exit-btn">${t("btn.register_exit")}</button>` : ""}
        ${(s.status === "OCCUPIED" || s.status === "PENDING_ASSIGNMENT") ? `<button class="btn danger" id="modal-cancel-btn">${t("btn.cancel_session")}</button>` : ""}
      </div>`;
    const exitBtn = document.getElementById("modal-exit-btn");
    if (exitBtn) exitBtn.addEventListener("click", async () => {
      try {
        const res = await api(`/api/admin/sessions/${sessionId}/exit`, { method: "POST" });
        toast(t("toast.exit_registered", { amount: money(res.final_amount) }));
        closeModal("session-modal");
        loadView(activeViewName());
      } catch (e) { toastError(e); }
    });
    const cancelBtn = document.getElementById("modal-cancel-btn");
    if (cancelBtn) cancelBtn.addEventListener("click", async () => {
      try {
        await api(`/api/admin/sessions/${sessionId}/cancel`, { method: "POST" });
        toast(t("toast.session_cancelled"));
        closeModal("session-modal");
        loadView(activeViewName());
      } catch (e) { toastError(e); }
    });
    openModal("session-modal");
  }

  function openAssignModal(sessionId, spaces) {
    // Monthly-reserved spaces are excluded here even though their DB status
    // is AVAILABLE -- the backend enforces this too (see crud.assign_space),
    // this is just so the dropdown doesn't even offer them in the first place.
    const available = spaces.filter(s => s.status === "AVAILABLE" && !s.monthly);
    const body = document.getElementById("assign-modal-body");
    if (!available.length) {
      body.innerHTML = `<p style="color:var(--text-dim)">${t("modal.no_spaces")}</p>`;
    } else {
      body.innerHTML = `
        <div class="field"><label>${t("modal.choose_space")}</label>
          <select id="assign-space-select">${available.map(s => `<option value="${s.id}">${s.number}</option>`).join("")}</select>
        </div>
        <div class="btn-row"><button class="btn primary" id="confirm-assign-btn">${t("btn.assign_confirm")}</button></div>`;
      document.getElementById("confirm-assign-btn").addEventListener("click", async () => {
        const spaceId = Number(document.getElementById("assign-space-select").value);
        try {
          await api(`/api/admin/sessions/${sessionId}/assign-space`, {
            method: "POST", body: JSON.stringify({ space_id: spaceId }),
          });
          toast(t("toast.space_assigned"));
          closeModal("assign-modal");
          loadView(activeViewName());
        } catch (e) { toastError(e); }
      });
    }
    openModal("assign-modal");
  }

  // ------------------------------------------------------------------
  // Active parking (list)
  // ------------------------------------------------------------------
  async function loadActive() {
    let data;
    try { data = await api("/api/admin/dashboard"); } catch (e) { return; }
    currentCurrency = data.currency;
    const rows = [];
    data.pending.forEach(p => rows.push(`
      <tr>
        <td class="ticket-id">TKT-${String(p.session_id).padStart(6, "0")}</td>
        <td>${escapeHtml(p.customer_name)}${whoLine(p)}</td><td class="mono">${escapeHtml(p.plate)}</td>
        <td><span class="status-badge PENDING_ASSIGNMENT">${t("dash.pending_badge")}</span></td>
        <td>${fmtClock(p.entry_timestamp)}</td><td>${fmtMinutes(p.waiting_minutes)}</td><td>--</td>
        <td><button class="btn small primary" data-assign="${p.session_id}">${t("btn.assign")}</button></td>
      </tr>`));
    data.spaces.filter(s => s.status === "OCCUPIED" && s.occupied).forEach(s => {
      const o = s.occupied;
      rows.push(`
        <tr>
          <td class="ticket-id">TKT-${String(o.session_id).padStart(6, "0")}</td>
          <td>${escapeHtml(o.customer_name)}${whoLine(o)}</td><td class="mono">${escapeHtml(o.plate)}</td>
          <td>${s.number}</td><td>${fmtClock(o.entry_timestamp)}</td>
          <td>${fmtMinutes(o.elapsed_minutes)}</td><td>${money(o.current_amount)}</td>
          <td><button class="btn small" data-detail="${o.session_id}">${t("btn.view")}</button></td>
        </tr>`);
    });
    const tbody = document.getElementById("active-table-body");
    tbody.innerHTML = rows.join("") || `<tr><td colspan="8" style="color:var(--text-dim);text-align:center;padding:30px">${t("active.empty")}</td></tr>`;
    tbody.querySelectorAll("[data-assign]").forEach(btn => btn.addEventListener("click", () => openAssignModal(btn.dataset.assign, data.spaces)));
    tbody.querySelectorAll("[data-detail]").forEach(btn => btn.addEventListener("click", () => openSessionModal(btn.dataset.detail)));
  }

  // ------------------------------------------------------------------
  // History
  // ------------------------------------------------------------------
  const HISTORY_PAGE_SIZE = 100;
  let historyOffset = 0;

  // The query string shared by the table and the CSV/Excel exports, so an
  // export contains exactly what the filters on screen select.
  function historyFilterParams() {
    const params = new URLSearchParams();
    const plate = document.getElementById("filter-plate").value.trim();
    const customer = document.getElementById("filter-customer").value.trim();
    const space = document.getElementById("filter-space").value.trim();
    const status = document.getElementById("filter-status").value;
    const preset = document.getElementById("filter-date-preset").value;
    const personType = document.getElementById("filter-person-type").value;
    const unit = document.getElementById("filter-unit").value.trim();
    if (personType) params.set("person_type", personType);
    if (unit) params.set("unit", unit);
    if (plate) params.set("plate", plate);
    if (customer) params.set("customer", customer);
    if (space) params.set("space", space);
    if (status) params.set("status", status);
    if (preset === "custom") {
      const from = document.getElementById("filter-date-from").value;   // YYYY-MM-DD
      const to = document.getElementById("filter-date-to").value;
      if (from) params.set("date_from", from);
      if (to) params.set("date_to", to);                                // whole day, inclusive
    } else if (preset) {
      params.set("date_preset", preset);
    }
    return params;
  }

  async function loadHistory(resetPage = true) {
    if (resetPage === true) historyOffset = 0;
    const params = historyFilterParams();
    params.set("limit", HISTORY_PAGE_SIZE);
    params.set("offset", historyOffset);

    let data;
    try { data = await api("/api/admin/history?" + params.toString()); } catch (e) { toastError(e); return; }
    currentCurrency = data.results[0] ? data.results[0].currency : currentCurrency;
    const tbody = document.getElementById("history-table-body");
    document.getElementById("history-empty").style.display = data.results.length ? "none" : "block";
    tbody.innerHTML = data.results.map(s => `
      <tr>
        <td class="ticket-id">TKT-${String(s.id).padStart(6, "0")}</td>
        <td>${escapeHtml(s.customer_name)}${whoLine(s)}</td>
        <td class="mono">${escapeHtml(s.plate)}</td>
        <td>${s.space_number || "--"}</td>
        <td>${fmtTime(s.entry_timestamp)}</td>
        <td>${s.exit_timestamp ? fmtTime(s.exit_timestamp) : "--"}</td>
        <td>${s.duration_minutes != null ? fmtMinutes(s.duration_minutes) : "--"}</td>
        <td>${escapeHtml(s.pricing_rule_name || "--")}</td>
        <td><span class="status-badge ${s.status}">${statusLabel(s.status)}</span></td>
        <td>${s.final_amount != null ? money(s.final_amount) : "--"}</td>
        <td class="who-line" style="white-space:nowrap">${s.source === "MANUAL" ? escapeHtml(s.checked_in_by || "--") : t("who.qr")} &rarr; ${escapeHtml(s.checked_out_by || "--")}</td>
      </tr>`).join("");

    // Pager: "Showing 1-100 of 6065" with Previous / Next.
    const total = data.total, first = total ? historyOffset + 1 : 0;
    const last = Math.min(historyOffset + data.results.length, total);
    document.getElementById("history-page-info").textContent =
      t("history.showing", { first, last, total });
    document.getElementById("history-prev").disabled = historyOffset <= 0;
    document.getElementById("history-next").disabled = last >= total;
    document.getElementById("history-pager").style.display = total > HISTORY_PAGE_SIZE ? "flex" : "none";
  }

  // ------------------------------------------------------------------
  // Revenue
  // ------------------------------------------------------------------
  async function loadRevenue() {
    let data;
    try { data = await api("/api/admin/revenue"); } catch (e) { return; }
    currentCurrency = data.today.currency;
    const monthlyByRange = { today: data.monthly_fees_today, this_week: data.monthly_fees_this_week, this_month: data.monthly_fees_this_month };
    const cardsHtml = ["today", "this_week", "this_month"].map(key => {
      const r = data[key];
      const monthlyFees = monthlyByRange[key];
      return `<div class="stat-card">
        <div class="stat-label">${t("revenue.range_" + key)}</div>
        <div class="stat-value blue">${money(r.total_revenue + monthlyFees)}</div>
        <div style="font-size:11.5px;color:var(--text-dim);margin-top:6px">
          ${t("revenue.vehicles", { n: r.vehicles_served })} &middot; ${t("revenue.avg", { amount: money(r.average_ticket) })}<br>
          ${t("revenue.hourly", { amount: money(r.hourly_revenue) })} &middot; ${t("revenue.flat", { amount: money(r.flat_revenue) })}<br>
          ${t("monthly.fee_label", { amount: money(monthlyFees) }).replace(" / month", "").replace(" / mes", "")}: ${money(monthlyFees)}
        </div></div>`;
    }).join("");
    document.getElementById("revenue-cards").innerHTML = cardsHtml;

    const series = data.daily_series;
    const max = Math.max(1, ...series.map(p => p.total));
    document.getElementById("revenue-chart").innerHTML = series.map(p => {
      const h = Math.max(2, Math.round((p.total / max) * 120));
      const d = new Date(p.label + "T00:00:00");
      const label = d.toLocaleDateString(currentLocale(), { month: "short", day: "numeric" });
      return `<div style="flex:1;display:flex;flex-direction:column;align-items:center">
        <div class="bar" style="height:${h}px;width:100%" title="${label}: ${money(p.total)}"></div>
        <div class="bar-label">${label}</div>
      </div>`;
    }).join("");
  }

  // ------------------------------------------------------------------
  // Pricing rules
  // ------------------------------------------------------------------
  function methodLabel(config) {
    const method = config.rounding_method || "per_started_hour";
    if (method === "blocks") return t("method.blocks", { n: config.block_minutes || 30 });
    return t(`method.${method}`);
  }

  async function loadPricing() {
    let rules;
    try { rules = await api("/api/admin/pricing-rules"); } catch (e) { return; }
    const list = document.getElementById("rules-list");
    list.innerHTML = rules.map(r => {
      const detail = r.type === "HOURLY"
        ? t("pricing.detail_hourly", { first: money(r.configuration.first_hour_price), additional: money(r.configuration.additional_hour_price), method: methodLabel(r.configuration) })
        : t("pricing.detail_flat", { amount: money(r.configuration.flat_rate) });
      return `<div class="rule-card ${r.is_default ? "default" : ""}">
        <div>
          <div class="rule-title">${escapeHtml(r.name)}${r.is_default ? `<span class="tag default">${t("tag.default")}</span>` : ""}${!r.active ? `<span class="tag">${t("tag.inactive")}</span>` : ""}</div>
          <div class="rule-detail">${detail}</div>
        </div>
        <div class="btn-row" style="margin-top:0">
          <button class="btn small" data-edit-rule="${r.id}">${t("btn.edit")}</button>
          <button class="btn small danger" data-delete-rule="${r.id}">${t("btn.delete")}</button>
        </div>
      </div>`;
    }).join("") || `<div class="empty-state"><div class="glyph">%</div>${t("pricing.empty")}</div>`;

    list.querySelectorAll("[data-edit-rule]").forEach(btn =>
      btn.addEventListener("click", () => openRuleModal(rules.find(r => r.id == btn.dataset.editRule))));
    list.querySelectorAll("[data-delete-rule]").forEach(btn =>
      btn.addEventListener("click", async () => {
        if (!confirm(t("confirm.delete_rule"))) return;
        try { await api(`/api/admin/pricing-rules/${btn.dataset.deleteRule}`, { method: "DELETE" }); loadPricing(); }
        catch (e) { toastError(e); }
      }));
  }

  function openRuleModal(rule) {
    document.getElementById("rule-modal-title").textContent = rule ? t("rule_modal.title_edit") : t("rule_modal.title_new");
    const cfg = rule ? rule.configuration : {};
    const type = rule ? rule.type : "HOURLY";
    document.getElementById("rule-modal-body").innerHTML = `
      <div class="field"><label>${t("field.name")}</label><input id="rule-name" value="${escapeHtml(rule ? rule.name : "")}"></div>
      <div class="field"><label>${t("field.type")}</label>
        <select id="rule-type">
          <option value="HOURLY" ${type === "HOURLY" ? "selected" : ""}>${t("type.hourly")}</option>
          <option value="FLAT" ${type === "FLAT" ? "selected" : ""}>${t("type.flat")}</option>
        </select>
      </div>
      <div id="rule-type-fields"></div>
      <div class="checkbox-field"><input type="checkbox" id="rule-default" ${rule && rule.is_default ? "checked" : ""}> ${t("checkbox.default_rule")}</div>
      <div class="checkbox-field" style="margin-top:8px"><input type="checkbox" id="rule-active" ${!rule || rule.active ? "checked" : ""}> ${t("checkbox.active")}</div>
      <div class="btn-row"><button class="btn primary" id="save-rule-btn">${t("btn.save")}</button></div>
    `;
    function renderTypeFields() {
      const tp = document.getElementById("rule-type").value;
      const el = document.getElementById("rule-type-fields");
      if (tp === "HOURLY") {
        el.innerHTML = `
          <div class="field-row">
            <div class="field"><label>${t("field.first_hour_price")}</label><input id="cfg-first" type="number" min="0" value="${cfg.first_hour_price ?? 5000}"></div>
            <div class="field"><label>${t("field.additional_hour_price")}</label><input id="cfg-additional" type="number" min="0" value="${cfg.additional_hour_price ?? 3000}"></div>
          </div>
          <div class="field"><label>${t("field.rounding_method")}</label>
            <select id="cfg-method">
              <option value="per_started_hour" ${(!cfg.rounding_method || cfg.rounding_method === "per_started_hour") ? "selected" : ""}>${t("method_option.per_started_hour")}</option>
              <option value="exact_fraction" ${cfg.rounding_method === "exact_fraction" ? "selected" : ""}>${t("method_option.exact_fraction")}</option>
              <option value="blocks" ${cfg.rounding_method === "blocks" ? "selected" : ""}>${t("method_option.blocks")}</option>
            </select>
          </div>
          <div class="field" id="cfg-block-field" style="display:${cfg.rounding_method === "blocks" ? "flex" : "none"}">
            <label>${t("field.block_minutes")}</label><input id="cfg-block-minutes" type="number" min="1" value="${cfg.block_minutes ?? 30}">
          </div>`;
        document.getElementById("cfg-method").addEventListener("change", (e) => {
          document.getElementById("cfg-block-field").style.display = e.target.value === "blocks" ? "flex" : "none";
        });
      } else {
        el.innerHTML = `<div class="field"><label>${t("field.flat_rate")}</label><input id="cfg-flat" type="number" min="0" value="${cfg.flat_rate ?? 25000}"></div>`;
      }
    }
    renderTypeFields();
    document.getElementById("rule-type").addEventListener("change", renderTypeFields);

    document.getElementById("save-rule-btn").addEventListener("click", async () => {
      const type2 = document.getElementById("rule-type").value;
      let configuration;
      if (type2 === "HOURLY") {
        configuration = {
          first_hour_price: Number(document.getElementById("cfg-first").value),
          additional_hour_price: Number(document.getElementById("cfg-additional").value),
          rounding_method: document.getElementById("cfg-method").value,
        };
        if (configuration.rounding_method === "blocks") {
          configuration.block_minutes = Number(document.getElementById("cfg-block-minutes").value);
        }
      } else {
        configuration = { flat_rate: Number(document.getElementById("cfg-flat").value) };
      }
      const payload = {
        name: document.getElementById("rule-name").value.trim(),
        type: type2,
        configuration,
        is_default: document.getElementById("rule-default").checked,
        active: document.getElementById("rule-active").checked,
      };
      try {
        if (rule) await api(`/api/admin/pricing-rules/${rule.id}`, { method: "PUT", body: JSON.stringify(payload) });
        else await api("/api/admin/pricing-rules", { method: "POST", body: JSON.stringify(payload) });
        toast(t("toast.rule_saved"));
        closeModal("rule-modal");
        loadPricing();
      } catch (e) { toastError(e); }
    });
    openModal("rule-modal");
  }

  // ------------------------------------------------------------------
  // Schedules
  // ------------------------------------------------------------------
  const DAY_OPTIONS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

  async function loadSchedules() {
    let schedules, rules;
    try {
      [schedules, rules] = await Promise.all([api("/api/admin/schedules"), api("/api/admin/pricing-rules")]);
    } catch (e) { return; }
    const list = document.getElementById("schedules-list");
    list.innerHTML = schedules.map(s => {
      const daysDisplay = s.days_of_week === "ALL" ? s.days_of_week : s.days_of_week.split(",").map(d => dayLabel(d.trim())).join(",");
      return `<div class="schedule-card">
        <div>
          <div class="rule-title">${escapeHtml(s.name)} <span class="tag">${t("tag.priority", { n: s.priority })}</span>${!s.active ? `<span class="tag">${t("tag.inactive")}</span>` : ""}</div>
          <div class="rule-detail">${daysDisplay} &middot; ${s.start_time}-${s.end_time} &rarr; ${escapeHtml(s.pricing_rule_name)}</div>
        </div>
        <div class="btn-row" style="margin-top:0">
          <button class="btn small" data-edit-sched="${s.id}">${t("btn.edit")}</button>
          <button class="btn small danger" data-delete-sched="${s.id}">${t("btn.delete")}</button>
        </div>
      </div>`;
    }).join("") || `<div class="empty-state"><div class="glyph">&#9707;</div>${t("schedules.empty")}</div>`;

    list.querySelectorAll("[data-edit-sched]").forEach(btn =>
      btn.addEventListener("click", () => openScheduleModal(schedules.find(s => s.id == btn.dataset.editSched), rules)));
    list.querySelectorAll("[data-delete-sched]").forEach(btn =>
      btn.addEventListener("click", async () => {
        if (!confirm(t("confirm.delete_schedule"))) return;
        try { await api(`/api/admin/schedules/${btn.dataset.deleteSched}`, { method: "DELETE" }); loadSchedules(); }
        catch (e) { toastError(e); }
      }));
  }

  function openScheduleModal(schedule, rules) {
    document.getElementById("schedule-modal-title").textContent = schedule ? t("schedule_modal.title_edit") : t("schedule_modal.title_new");
    const selectedDays = schedule ? schedule.days_of_week.split(",").map(d => d.trim()) : ["MON", "TUE", "WED", "THU", "FRI"];
    document.getElementById("schedule-modal-body").innerHTML = `
      <div class="field"><label>${t("field.name")}</label><input id="sched-name" value="${escapeHtml(schedule ? schedule.name : "")}"></div>
      <div class="field"><label>${t("field.days")}</label>
        <div style="display:flex;flex-wrap:wrap;gap:8px">
          ${DAY_OPTIONS.map(d => `<label class="checkbox-field"><input type="checkbox" class="sched-day" value="${d}" ${selectedDays.includes(d) ? "checked" : ""}> ${dayLabel(d)}</label>`).join("")}
        </div>
      </div>
      <div class="field-row">
        <div class="field"><label>${t("field.start_time")}</label><input id="sched-start" value="${schedule ? schedule.start_time : "08:00"}" placeholder="08:00"></div>
        <div class="field"><label>${t("field.end_time")}</label><input id="sched-end" value="${schedule ? schedule.end_time : "18:00"}" placeholder="18:00"></div>
      </div>
      <div class="field"><label>${t("field.pricing_rule")}</label>
        <select id="sched-rule">${rules.map(r => `<option value="${r.id}" ${schedule && schedule.pricing_rule_id === r.id ? "selected" : ""}>${escapeHtml(r.name)}</option>`).join("")}</select>
      </div>
      <div class="field"><label>${t("field.priority")}</label><input id="sched-priority" type="number" value="${schedule ? schedule.priority : 100}"></div>
      <div class="checkbox-field"><input type="checkbox" id="sched-active" ${!schedule || schedule.active ? "checked" : ""}> ${t("checkbox.active")}</div>
      <div class="btn-row"><button class="btn primary" id="save-sched-btn">${t("btn.save")}</button></div>
    `;
    document.getElementById("save-sched-btn").addEventListener("click", async () => {
      const days = Array.from(document.querySelectorAll(".sched-day:checked")).map(el => el.value);
      const payload = {
        name: document.getElementById("sched-name").value.trim(),
        days_of_week: days.length ? days.join(",") : "ALL",
        start_time: document.getElementById("sched-start").value.trim(),
        end_time: document.getElementById("sched-end").value.trim(),
        pricing_rule_id: Number(document.getElementById("sched-rule").value),
        priority: Number(document.getElementById("sched-priority").value),
        active: document.getElementById("sched-active").checked,
      };
      try {
        if (schedule) await api(`/api/admin/schedules/${schedule.id}`, { method: "PUT", body: JSON.stringify(payload) });
        else await api("/api/admin/schedules", { method: "POST", body: JSON.stringify(payload) });
        toast(t("toast.schedule_saved"));
        closeModal("schedule-modal");
        loadSchedules();
      } catch (e) { toastError(e); }
    });
    openModal("schedule-modal");
  }

  // ------------------------------------------------------------------
  // Monthly fees (mensualidades)
  // ------------------------------------------------------------------
  async function loadMonthlyFees() {
    let subs;
    try { subs = await api("/api/admin/subscriptions"); } catch (e) { return; }
    currentCurrency = subs[0] ? subs[0].currency : currentCurrency;
    const list = document.getElementById("subscriptions-list");
    const active = subs.filter(s => s.status === "ACTIVE");
    list.innerHTML = active.map(s => `
      <div class="rule-card ${s.is_overdue ? "" : "default"}">
        <div>
          <div class="rule-title">${escapeHtml(s.customer_name)} <span class="tag">${escapeHtml(s.space_number)}</span>${s.is_overdue ? `<span class="overdue-badge">${t("monthly.overdue")}</span>` : ""}</div>
          <div class="rule-detail">${escapeHtml(s.plate)}${s.phone ? " &middot; " + escapeHtml(s.phone) : ""} &middot; ${t("monthly.fee_label", { amount: money(s.monthly_fee) })}</div>
          <div class="rule-detail">${t("monthly.next_due")}: ${fmtDate(s.next_due_date)} &middot; ${s.currently_parked ? t("monthly.currently_parked") : t("monthly.not_parked")}</div>
        </div>
        <div class="btn-row" style="margin-top:0;flex-wrap:wrap">
          <button class="btn small primary" data-log-payment="${s.id}">${t("monthly.log_payment")}</button>
          <button class="btn small" data-toggle-parked="${s.id}" data-parked="${s.currently_parked}">${s.currently_parked ? t("monthly.mark_left") : t("monthly.mark_parked")}</button>
          <button class="btn small" data-events="${s.id}">${t("monthly.movements")}</button>
          <button class="btn small admin-only" data-edit-sub="${s.id}">${t("btn.edit")}</button>
          <button class="btn small danger admin-only" data-cancel-sub="${s.id}">${t("monthly.cancel_subscription")}</button>
        </div>
      </div>`).join("") || `<div class="empty-state"><div class="glyph">🅿</div>${t("monthly.empty")}</div>`;

    applyRoleVisibility();

    list.querySelectorAll("[data-log-payment]").forEach(btn =>
      btn.addEventListener("click", () => openPaymentModal(btn.dataset.logPayment, active.find(s => s.id == btn.dataset.logPayment))));
    list.querySelectorAll("[data-toggle-parked]").forEach(btn =>
      btn.addEventListener("click", async () => {
        const parked = btn.dataset.parked !== "true";
        try {
          await api(`/api/admin/subscriptions/${btn.dataset.toggleParked}/toggle-parked`, { method: "POST", body: JSON.stringify({ parked }) });
          toast(t("toast.parked_updated"));
          loadMonthlyFees();
        } catch (e) { toastError(e); }
      }));
    list.querySelectorAll("[data-events]").forEach(btn =>
      btn.addEventListener("click", () => openEventsModal(btn.dataset.events, active.find(s => s.id == btn.dataset.events))));
    list.querySelectorAll("[data-edit-sub]").forEach(btn =>
      btn.addEventListener("click", () => openSubscriptionModal(active.find(s => s.id == btn.dataset.editSub))));
    list.querySelectorAll("[data-cancel-sub]").forEach(btn =>
      btn.addEventListener("click", async () => {
        if (!confirm(t("confirm.cancel_subscription"))) return;
        try {
          await api(`/api/admin/subscriptions/${btn.dataset.cancelSub}/cancel`, { method: "POST" });
          toast(t("toast.subscription_cancelled"));
          loadMonthlyFees();
        } catch (e) { toastError(e); }
      }));
  }

  async function openEventsModal(subId, sub) {
    let events;
    try { events = await api(`/api/admin/subscriptions/${subId}/events`); } catch (e) { toastError(e); return; }
    const rows = events.map(e => `
      <tr>
        <td>${fmtDateTime(e.ts)}</td>
        <td><span class="dir-badge ${e.direction}">${t("dir." + e.direction)}</span></td>
        <td>${escapeHtml(e.recorded_by || "--")}</td>
      </tr>`).join("");
    document.getElementById("events-modal-body").innerHTML = `
      <div class="rule-detail" style="margin-bottom:10px">${sub ? escapeHtml(sub.customer_name) + " &middot; " + escapeHtml(sub.plate) : ""}</div>
      ${events.length ? `<table><thead><tr><th>${t("audit.col_time")}</th><th>${t("audit.col_movement")}</th><th>${t("table.recorded_by")}</th></tr></thead><tbody>${rows}</tbody></table>`
                      : `<p style="color:var(--text-dim)">${t("events.empty")}</p>`}`;
    openModal("events-modal");
  }

  async function openSubscriptionModal(sub) {
    document.getElementById("subscription-modal-title").textContent = sub ? t("subscription_modal.title_edit") : t("subscription_modal.title_new");
    let spaceOptions = "";
    if (!sub) {
      let dash;
      try { dash = await api("/api/admin/dashboard"); } catch (e) { toastError(e); return; }
      const eligible = dash.spaces.filter(s => s.status === "AVAILABLE" && !s.monthly);
      if (!eligible.length) {
        document.getElementById("subscription-modal-body").innerHTML = `<p style="color:var(--text-dim)">${t("modal.no_spaces")}</p>`;
        openModal("subscription-modal");
        return;
      }
      spaceOptions = eligible.map(s => `<option value="${s.id}">${s.number}</option>`).join("");
    }
    document.getElementById("subscription-modal-body").innerHTML = `
      <div class="field"><label>${t("field.customer_name")}</label><input id="sub-customer-name" value="${escapeHtml(sub ? sub.customer_name : "")}"></div>
      <div class="field-row">
        <div class="field"><label>${t("table.plate")}</label><input id="sub-plate" value="${escapeHtml(sub ? sub.plate : "")}" style="text-transform:uppercase"></div>
        <div class="field"><label>${t("field.phone")}</label><input id="sub-phone" value="${escapeHtml(sub ? (sub.phone || "") : "")}"></div>
      </div>
      <div class="field"><label>${t("field.additional_plates")}</label><input id="sub-additional-plates" value="${escapeHtml(sub ? (sub.additional_plates || "") : "")}"></div>
      ${sub ? "" : `<div class="field"><label>${t("field.space")}</label><select id="sub-space">${spaceOptions}</select></div>`}
      <div class="field"><label>${t("field.monthly_fee")}</label><input id="sub-fee" type="number" min="0" value="${sub ? sub.monthly_fee : 150000}"></div>
      <div class="field"><label>${t("field.notes")}</label><input id="sub-notes" value="${escapeHtml(sub ? (sub.notes || "") : "")}"></div>
      <div class="btn-row"><button class="btn primary" id="save-sub-btn">${t("btn.save")}</button></div>
    `;
    document.getElementById("save-sub-btn").addEventListener("click", async () => {
      const payload = {
        customer_name: document.getElementById("sub-customer-name").value.trim(),
        plate: document.getElementById("sub-plate").value.trim(),
        phone: document.getElementById("sub-phone").value.trim() || null,
        additional_plates: document.getElementById("sub-additional-plates").value.trim() || null,
        monthly_fee: Number(document.getElementById("sub-fee").value),
        notes: document.getElementById("sub-notes").value.trim() || null,
      };
      try {
        if (sub) {
          await api(`/api/admin/subscriptions/${sub.id}`, { method: "PUT", body: JSON.stringify(payload) });
          toast(t("toast.subscription_updated"));
        } else {
          payload.space_id = Number(document.getElementById("sub-space").value);
          await api("/api/admin/subscriptions", { method: "POST", body: JSON.stringify(payload) });
          toast(t("toast.subscription_created"));
        }
        closeModal("subscription-modal");
        loadMonthlyFees();
      } catch (e) { toastError(e); }
    });
    openModal("subscription-modal");
  }

  function openPaymentModal(subId, sub) {
    document.getElementById("payment-modal-body").innerHTML = `
      <div class="field"><label>${t("payment_modal.amount")}</label><input id="payment-amount" type="number" min="0" value="${sub ? sub.monthly_fee : 0}"></div>
      <div class="field"><label>${t("payment_modal.notes")}</label><input id="payment-notes"></div>
      <div class="btn-row"><button class="btn primary" id="save-payment-btn">${t("btn.log_payment")}</button></div>
    `;
    document.getElementById("save-payment-btn").addEventListener("click", async () => {
      try {
        await api(`/api/admin/subscriptions/${subId}/log-payment`, {
          method: "POST",
          body: JSON.stringify({
            amount_paid: Number(document.getElementById("payment-amount").value),
            notes: document.getElementById("payment-notes").value.trim() || null,
          }),
        });
        toast(t("toast.payment_logged"));
        closeModal("payment-modal");
        loadMonthlyFees();
      } catch (e) { toastError(e); }
    });
    openModal("payment-modal");
  }

  // ------------------------------------------------------------------
  // Check-in: the attendant registers a vehicle at the gate
  // ------------------------------------------------------------------
  async function openCheckinModal() {
    let dash;
    try { dash = await api("/api/admin/dashboard"); } catch (e) { toastError(e); return; }
    const free = dash.spaces.filter(s => s.status === "AVAILABLE" && !s.monthly);
    document.getElementById("checkin-modal-body").innerHTML = `
      <div class="field-row">
        <div class="field"><label>${t("field.customer_name")}</label><input id="ci-name" autocomplete="off"></div>
        <div class="field"><label>${t("table.plate")}</label><input id="ci-plate" autocomplete="off" style="text-transform:uppercase" placeholder="ABC123"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>${t("checkin.person_type")}</label>
          <select id="ci-type">
            <option value="VISITOR">${t("person.VISITOR")}</option>
            <option value="RESIDENT">${t("person.RESIDENT")}</option>
            <option value="SERVICE">${t("person.SERVICE")}</option>
          </select></div>
        <div class="field"><label>${t("checkin.unit")}</label><input id="ci-unit" autocomplete="off" placeholder="${t("checkin.unit_placeholder")}"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>${t("checkin.visiting")}</label><input id="ci-visiting" autocomplete="off"></div>
        <div class="field"><label>${t("checkin.vehicle")}</label><input id="ci-vehicle" autocomplete="off" placeholder="${t("checkin.vehicle_placeholder")}"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>${t("field.phone")}</label><input id="ci-phone" autocomplete="off"></div>
        <div class="field"><label>${t("field.space")}</label>
          <select id="ci-space"><option value="">${t("checkin.assign_later")}</option>
            ${free.map(s => `<option value="${s.id}">${escapeHtml(s.number)}</option>`).join("")}</select></div>
      </div>
      <div class="btn-row"><button class="btn primary" id="ci-save-btn">${t("checkin.save")}</button></div>`;
    document.getElementById("ci-save-btn").addEventListener("click", async () => {
      const val = id => document.getElementById(id).value.trim();
      const payload = {
        name: val("ci-name"), plate: val("ci-plate"), phone: val("ci-phone") || null,
        person_type: val("ci-type"), unit: val("ci-unit") || null,
        visiting: val("ci-visiting") || null, vehicle: val("ci-vehicle") || null,
        space_id: val("ci-space") ? Number(val("ci-space")) : null,
      };
      try {
        await api("/api/admin/sessions/check-in", { method: "POST", body: JSON.stringify(payload) });
        toast(t("toast.checkin_done"));
        closeModal("checkin-modal");
        loadView(activeViewName());
      } catch (e) { toastError(e); }
    });
    openModal("checkin-modal");
    document.getElementById("ci-name").focus();
  }

  // ------------------------------------------------------------------
  // Audit trail ("bitacora") + monthly-subscriber movements (admin only)
  // ------------------------------------------------------------------
  const AUDIT_PAGE_SIZE = 100;
  const AUDIT_ACTIONS = [
    "SESSION_REGISTERED", "SESSION_CHECKIN", "SPACE_ASSIGNED", "SESSION_EXIT", "SESSION_CANCELLED",
    "SUBSCRIPTION_CREATED", "SUBSCRIPTION_UPDATED", "SUBSCRIPTION_CANCELLED", "PAYMENT_LOGGED",
    "PRICING_CREATED", "PRICING_UPDATED", "PRICING_DELETED",
    "SCHEDULE_CREATED", "SCHEDULE_UPDATED", "SCHEDULE_DELETED",
    "USER_CREATED", "USER_UPDATED", "USER_PIN_RESET", "PIN_CHANGED",
    "SETTINGS_UPDATED", "CLOUD_SYNC_UPDATED", "REMOTE_ACCESS_UPDATED", "STATUS_PAGE_UPDATED",
    "LOGIN_OK", "LOGIN_FAILED",
  ];
  let auditOffset = 0;

  function auditKind() { return document.getElementById("audit-kind").value; }

  function auditParams() {
    const params = new URLSearchParams();
    const q = document.getElementById("audit-q").value.trim();
    const preset = document.getElementById("audit-date-preset").value;
    const action = document.getElementById("audit-action").value;
    if (q) params.set("q", q);
    if (preset) params.set("date_preset", preset);
    if (action && auditKind() === "actions") params.set("action", action);
    return params;
  }

  function ensureAuditActionOptions() {
    const sel = document.getElementById("audit-action");
    const current = sel.value;
    sel.innerHTML = `<option value="">${t("filter.status_any")}</option>` +
      AUDIT_ACTIONS.map(a => `<option value="${a}">${escapeHtml(t("audit.a." + a))}</option>`).join("");
    sel.value = current;
  }

  async function loadAudit(resetPage = true) {
    if (resetPage === true) auditOffset = 0;
    ensureAuditActionOptions();
    const kind = auditKind();
    document.getElementById("audit-action-field").style.display = kind === "actions" ? "" : "none";
    const params = auditParams();
    params.set("limit", AUDIT_PAGE_SIZE);
    params.set("offset", auditOffset);
    const url = (kind === "actions" ? "/api/admin/audit?" : "/api/admin/monthly-events?") + params.toString();
    let data;
    try { data = await api(url); } catch (e) { toastError(e); return; }

    const head = document.getElementById("audit-table-head");
    const body = document.getElementById("audit-table-body");
    if (kind === "actions") {
      head.innerHTML = `<tr><th>${t("audit.col_time")}</th><th>${t("audit.col_user")}</th><th>${t("audit.col_action")}</th><th>${t("audit.col_subject")}</th><th>${t("audit.col_details")}</th></tr>`;
      body.innerHTML = data.results.map(a => `
        <tr>
          <td style="white-space:nowrap">${fmtDateTime(a.ts)}</td>
          <td>${escapeHtml(a.username)}</td>
          <td>${escapeHtml(t("audit.a." + a.action))}</td>
          <td class="mono">${escapeHtml(a.subject || "--")}</td>
          <td class="who-line">${escapeHtml(a.details || "")}</td>
        </tr>`).join("");
    } else {
      head.innerHTML = `<tr><th>${t("audit.col_time")}</th><th>${t("audit.col_movement")}</th><th>${t("table.customer")}</th><th>${t("table.plate")}</th><th>${t("table.space")}</th><th>${t("table.recorded_by")}</th></tr>`;
      body.innerHTML = data.results.map(e => `
        <tr>
          <td style="white-space:nowrap">${fmtDateTime(e.ts)}</td>
          <td><span class="dir-badge ${e.direction}">${t("dir." + e.direction)}</span></td>
          <td>${escapeHtml(e.customer_name)}</td>
          <td class="mono">${escapeHtml(e.plate)}</td>
          <td>${escapeHtml(e.space_number || "--")}</td>
          <td>${escapeHtml(e.recorded_by || "--")}</td>
        </tr>`).join("");
    }
    document.getElementById("audit-empty").style.display = data.results.length ? "none" : "block";
    const total = data.total, first = total ? auditOffset + 1 : 0;
    const last = Math.min(auditOffset + data.results.length, total);
    document.getElementById("audit-page-info").textContent = t("history.showing", { first, last, total });
    document.getElementById("audit-prev").disabled = auditOffset <= 0;
    document.getElementById("audit-next").disabled = last >= total;
    document.getElementById("audit-pager").style.display = total > AUDIT_PAGE_SIZE ? "flex" : "none";
  }

  // ------------------------------------------------------------------
  // Users
  // ------------------------------------------------------------------
  async function loadUsers() {
    let users;
    try { users = await api("/api/admin/users"); } catch (e) { return; }
    const list = document.getElementById("users-list");
    list.innerHTML = users.map(u => `
      <div class="rule-card ${u.active ? "default" : ""}">
        <div>
          <div class="rule-title">${escapeHtml(u.display_name)} <span class="tag">@${escapeHtml(u.username)}</span>
            <span class="role-badge ${u.role}">${t("role." + u.role)}</span>
            ${!u.active ? `<span class="tag">${t("tag.inactive_user")}</span>` : ""}
          </div>
        </div>
        <div class="btn-row" style="margin-top:0">
          <button class="btn small" data-edit-user="${u.id}">${t("btn.edit")}</button>
          <button class="btn small" data-reset-pin="${u.id}">${t("users.reset_pin")}</button>
        </div>
      </div>`).join("") || `<div class="empty-state">${t("users.empty")}</div>`;

    list.querySelectorAll("[data-edit-user]").forEach(btn =>
      btn.addEventListener("click", () => openUserModal(users.find(u => u.id == btn.dataset.editUser))));
    list.querySelectorAll("[data-reset-pin]").forEach(btn =>
      btn.addEventListener("click", () => openResetPinModal(btn.dataset.resetPin)));
  }

  function openUserModal(user) {
    document.getElementById("user-modal-title").textContent = user ? t("user_modal.title_edit") : t("user_modal.title_new");
    document.getElementById("user-modal-body").innerHTML = `
      ${user ? "" : `
        <div class="field"><label>${t("field.username")}</label><input id="user-username"></div>
        <div class="field"><label>${t("field.pin")}</label><input id="user-pin" type="password"></div>
      `}
      <div class="field"><label>${t("field.display_name")}</label><input id="user-display-name" value="${escapeHtml(user ? user.display_name : "")}"></div>
      <div class="field"><label>${t("field.role")}</label>
        <select id="user-role">
          <option value="ADMIN" ${user && user.role === "ADMIN" ? "selected" : ""}>${t("role.ADMIN")}</option>
          <option value="ATTENDANT" ${!user || user.role === "ATTENDANT" ? "selected" : ""}>${t("role.ATTENDANT")}</option>
        </select>
      </div>
      ${user ? `<div class="checkbox-field"><input type="checkbox" id="user-active" ${user.active ? "checked" : ""}> ${t("checkbox.user_active")}</div>` : ""}
      <div class="btn-row"><button class="btn primary" id="save-user-btn">${t("btn.save")}</button></div>
    `;
    document.getElementById("save-user-btn").addEventListener("click", async () => {
      try {
        if (user) {
          await api(`/api/admin/users/${user.id}`, {
            method: "PUT",
            body: JSON.stringify({
              display_name: document.getElementById("user-display-name").value.trim(),
              role: document.getElementById("user-role").value,
              active: document.getElementById("user-active").checked,
            }),
          });
          toast(t("toast.user_updated"));
        } else {
          await api("/api/admin/users", {
            method: "POST",
            body: JSON.stringify({
              username: document.getElementById("user-username").value.trim(),
              pin: document.getElementById("user-pin").value.trim(),
              display_name: document.getElementById("user-display-name").value.trim(),
              role: document.getElementById("user-role").value,
            }),
          });
          toast(t("toast.user_created"));
        }
        closeModal("user-modal");
        loadUsers();
      } catch (e) { toastError(e); }
    });
    openModal("user-modal");
  }

  function openResetPinModal(userId) {
    document.getElementById("reset-pin-modal-body").innerHTML = `
      <div class="field"><label>${t("field.new_pin_reset")}</label><input id="reset-pin-new" type="password"></div>
      <div class="btn-row"><button class="btn primary" id="save-reset-pin-btn">${t("btn.reset_pin")}</button></div>
    `;
    document.getElementById("save-reset-pin-btn").addEventListener("click", async () => {
      try {
        await api(`/api/admin/users/${userId}/reset-pin`, {
          method: "PUT", body: JSON.stringify({ new_pin: document.getElementById("reset-pin-new").value.trim() }),
        });
        toast(t("toast.pin_reset"));
        closeModal("reset-pin-modal");
      } catch (e) { toastError(e); }
    });
    openModal("reset-pin-modal");
  }

  // ------------------------------------------------------------------
  // Settings
  // ------------------------------------------------------------------
  async function loadSettings() {
    document.getElementById("my-account-line").textContent = t("my_account.signed_in_as", { name: localStorage.getItem(NAME_KEY) || "" });
    if (!isAdmin()) return; // rest of Settings (business/cloud/remote/status-page) is admin-only, hidden via CSS
    let s;
    try { s = await api("/api/admin/settings"); } catch (e) { return; }
    document.getElementById("setting-business-name").value = s.business_name || "";
    document.getElementById("setting-currency-code").value = s.currency_code || "";
    document.getElementById("setting-currency-symbol").value = s.currency_symbol || "";
    document.getElementById("data-dir-value").textContent = s.data_dir;
    document.getElementById("sidebar-spaces-label").textContent = t("sidebar.spaces_count", { n: s.num_spaces });
    await loadCloudSettings();
    await loadRemoteAccessSettings();
    await loadStatusPageSettings();
  }

  document.getElementById("save-settings-btn").addEventListener("click", async () => {
    try {
      await api("/api/admin/settings", {
        method: "PUT",
        body: JSON.stringify({
          business_name: document.getElementById("setting-business-name").value.trim(),
          currency_code: document.getElementById("setting-currency-code").value.trim(),
          currency_symbol: document.getElementById("setting-currency-symbol").value.trim(),
        }),
      });
      toast(t("toast.settings_saved"));
      document.getElementById("sidebar-business-name").textContent = document.getElementById("setting-business-name").value.trim();
    } catch (e) { toastError(e); }
  });

  document.getElementById("change-pin-btn").addEventListener("click", async () => {
    const current = document.getElementById("pin-current").value;
    const next = document.getElementById("pin-new").value;
    try {
      await api("/api/admin/me/pin", { method: "PUT", body: JSON.stringify({ current_pin: current, new_pin: next }) });
      toast(t("toast.pin_changed"));
      document.getElementById("pin-current").value = "";
      document.getElementById("pin-new").value = "";
    } catch (e) { toastError(e); }
  });

  // ------------------------------------------------------------------
  // Cloud backup / Remote access / Status page (all admin-only)
  // ------------------------------------------------------------------
  async function loadCloudSettings() {
    try {
      const cfg = await api("/api/admin/cloud-sync/config");
      document.getElementById("cloud-enabled").checked = cfg.enabled;
      document.getElementById("cloud-url").value = cfg.url;
      document.getElementById("cloud-secret").value = cfg.secret;
      await refreshCloudStatus();
    } catch (e) { /* ignore */ }
  }

  async function refreshCloudStatus() {
    try {
      const status = await api("/api/admin/cloud-sync/status");
      const line = document.getElementById("cloud-status-line");
      const parts = [];
      parts.push(status.last_success ? t("cloud.last_success", { time: fmtTime(status.last_success) }) : t("cloud.never_synced"));
      parts.push(status.pending_count > 0 ? t("cloud.pending_count", { n: status.pending_count }) : t("cloud.pending_zero"));
      line.textContent = parts.join(" · ");
    } catch (e) { /* ignore */ }
  }

  document.getElementById("save-cloud-btn").addEventListener("click", async () => {
    try {
      await api("/api/admin/cloud-sync", {
        method: "PUT",
        body: JSON.stringify({
          enabled: document.getElementById("cloud-enabled").checked,
          url: document.getElementById("cloud-url").value.trim(),
          secret: document.getElementById("cloud-secret").value.trim(),
        }),
      });
      toast(t("toast.cloud_saved"));
      await refreshCloudStatus();
    } catch (e) { toastError(e); }
  });

  document.getElementById("test-cloud-btn").addEventListener("click", async () => {
    try {
      // Test what is typed on screen, not only what was saved before.
      await api("/api/admin/cloud-sync", {
        method: "PUT",
        body: JSON.stringify({
          url: document.getElementById("cloud-url").value.trim(),
          secret: document.getElementById("cloud-secret").value.trim(),
        }),
      });
      const r = await api("/api/admin/cloud-sync/test", { method: "POST" });
      if (r.ok) toast(t("toast.cloud_test_ok"));
      else toast(t("toast.cloud_test_failed", { reason: translateServerMessage(r.message) }), "error");
    } catch (e) { toastError(e); }
  });

  document.getElementById("sync-now-btn").addEventListener("click", async () => {
    try {
      const result = await api("/api/admin/cloud-sync/sync-now", { method: "POST" });
      if (result.attempted > 0) {
        toast(t("toast.sync_result", { succeeded: result.succeeded, attempted: result.attempted }));
      } else {
        toast(translateServerMessage(result.message));
      }
      await refreshCloudStatus();
    } catch (e) { toastError(e); }
  });

  async function loadRemoteAccessSettings() {
    try {
      const cfg = await api("/api/admin/remote-access");
      document.getElementById("remote-enabled").checked = cfg.enabled;
      document.getElementById("remote-url").value = cfg.public_base_url;
    } catch (e) { /* ignore */ }
  }

  document.getElementById("save-remote-btn").addEventListener("click", async () => {
    try {
      await api("/api/admin/remote-access", {
        method: "PUT",
        body: JSON.stringify({
          enabled: document.getElementById("remote-enabled").checked,
          public_base_url: document.getElementById("remote-url").value.trim(),
        }),
      });
      toast(t("toast.remote_saved"));
    } catch (e) { toastError(e); }
  });

  async function loadStatusPageSettings() {
    try {
      const cfg = await api("/api/admin/status-page");
      document.getElementById("status-page-enabled").checked = cfg.enabled;
      document.getElementById("status-page-url").value = cfg.base_url;
    } catch (e) { /* ignore */ }
  }

  document.getElementById("save-status-page-btn").addEventListener("click", async () => {
    try {
      await api("/api/admin/status-page", {
        method: "PUT",
        body: JSON.stringify({
          enabled: document.getElementById("status-page-enabled").checked,
          base_url: document.getElementById("status-page-url").value.trim(),
        }),
      });
      toast(t("toast.status_page_saved"));
    } catch (e) { toastError(e); }
  });

  // ------------------------------------------------------------------
  // QR
  // ------------------------------------------------------------------
  async function loadQr() {
    try {
      const info = await api("/api/admin/qr-info");
      document.getElementById("qr-url").textContent = info.registration_url;
      const badge = document.getElementById("qr-mode-badge");
      badge.textContent = info.using_public_url ? t("qr.mode_public") : t("qr.mode_local");
      const token = localStorage.getItem(TOKEN_KEY);
      const res = await fetch("/api/admin/qr", { headers: { Authorization: "Bearer " + token } });
      const blob = await res.blob();
      document.getElementById("qr-image").src = URL.createObjectURL(blob);
    } catch (e) { /* ignore */ }
  }
  document.getElementById("refresh-qr-btn").addEventListener("click", loadQr);

  // ------------------------------------------------------------------
  // Wiring
  // ------------------------------------------------------------------
  document.querySelectorAll(".nav-item").forEach(el => el.addEventListener("click", () => switchView(el.dataset.view)));
  document.getElementById("login-btn").addEventListener("click", attemptLogin);
  document.getElementById("pin-input").addEventListener("keydown", e => { if (e.key === "Enter") attemptLogin(); });
  document.getElementById("username-input").addEventListener("keydown", e => { if (e.key === "Enter") document.getElementById("pin-input").focus(); });
  document.getElementById("lock-btn").addEventListener("click", lockConsole);
  wireLanguageToggle();

  document.getElementById("close-session-modal").addEventListener("click", () => closeModal("session-modal"));
  document.getElementById("close-assign-modal").addEventListener("click", () => closeModal("assign-modal"));
  document.getElementById("close-rule-modal").addEventListener("click", () => closeModal("rule-modal"));
  document.getElementById("close-schedule-modal").addEventListener("click", () => closeModal("schedule-modal"));
  document.getElementById("close-subscription-modal").addEventListener("click", () => closeModal("subscription-modal"));
  document.getElementById("close-payment-modal").addEventListener("click", () => closeModal("payment-modal"));
  document.getElementById("close-user-modal").addEventListener("click", () => closeModal("user-modal"));
  document.getElementById("close-reset-pin-modal").addEventListener("click", () => closeModal("reset-pin-modal"));
  document.getElementById("close-checkin-modal").addEventListener("click", () => closeModal("checkin-modal"));
  document.getElementById("close-events-modal").addEventListener("click", () => closeModal("events-modal"));
  document.getElementById("open-checkin-btn").addEventListener("click", openCheckinModal);
  document.getElementById("audit-search-btn").addEventListener("click", () => loadAudit(true));
  document.getElementById("audit-kind").addEventListener("change", () => loadAudit(true));
  document.getElementById("audit-prev").addEventListener("click", () => {
    auditOffset = Math.max(0, auditOffset - AUDIT_PAGE_SIZE); loadAudit(false);
  });
  document.getElementById("audit-next").addEventListener("click", () => {
    auditOffset += AUDIT_PAGE_SIZE; loadAudit(false);
  });
  document.getElementById("export-audit-btn").addEventListener("click", () => {
    const kind = auditKind();
    const params = auditParams().toString();
    downloadFile(kind === "actions" ? `/api/admin/export/audit?${params}` : `/api/admin/export/monthly-events?${params}`,
                 kind === "actions" ? "parking_audit.csv" : "parking_monthly_movements.csv");
  });
  document.querySelectorAll(".modal-backdrop").forEach(bd => bd.addEventListener("click", e => { if (e.target === bd) bd.classList.remove("open"); }));

  document.getElementById("new-rule-btn").addEventListener("click", () => openRuleModal(null));
  document.getElementById("new-schedule-btn").addEventListener("click", () => api("/api/admin/pricing-rules").then(rules => openScheduleModal(null, rules)));
  document.getElementById("new-subscription-btn").addEventListener("click", () => openSubscriptionModal(null));
  document.getElementById("new-user-btn").addEventListener("click", () => openUserModal(null));
  document.getElementById("apply-filters-btn").addEventListener("click", () => loadHistory(true));
  document.getElementById("history-prev").addEventListener("click", () => {
    historyOffset = Math.max(0, historyOffset - HISTORY_PAGE_SIZE); loadHistory(false);
  });
  document.getElementById("history-next").addEventListener("click", () => {
    historyOffset += HISTORY_PAGE_SIZE; loadHistory(false);
  });
  document.getElementById("filter-date-preset").addEventListener("change", e => {
    document.querySelectorAll("#view-history .custom-range")
      .forEach(el => { el.style.display = e.target.value === "custom" ? "" : "none"; });
  });
  document.getElementById("export-csv-btn").addEventListener("click", () => downloadExport("csv"));
  document.getElementById("export-xlsx-btn").addEventListener("click", () => downloadExport("xlsx"));

  async function downloadExport(kind) {
    // Same filters as the table on screen (plate, customer, space, status, dates).
    return downloadFile(`/api/admin/export/${kind}?` + historyFilterParams().toString(), `parking_history.${kind}`);
  }

  async function downloadFile(url, fallbackName) {
    const token = localStorage.getItem(TOKEN_KEY);
    const res = await fetch(url, { headers: { Authorization: "Bearer " + token } });
    if (!res.ok) { toast(t("toast.export_failed"), "error"); return; }
    const blob = await res.blob();
    const disposition = res.headers.get("Content-Disposition") || "";
    const match = disposition.match(/filename="(.+)"/);
    const filename = match ? match[1] : fallbackName;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
  }

  function tickClock() {
    document.getElementById("clock").textContent = new Date().toLocaleTimeString(currentLocale());
  }

  function startAutoRefresh() {
    stopAutoRefresh();
    refreshTimer = setInterval(() => {
      const v = activeViewName();
      if (v === "dashboard" || v === "active") loadView(v);
    }, 5000);
  }
  function stopAutoRefresh() { if (refreshTimer) clearInterval(refreshTimer); refreshTimer = null; }

  async function bootstrapApp() {
    applyRoleVisibility();
    updateCurrentUserLine();
    try {
      const s = await api("/api/admin/settings").catch(() => null);
      if (s) {
        document.getElementById("sidebar-business-name").textContent = s.business_name;
        document.getElementById("login-business-name").textContent = s.business_name;
        document.getElementById("sidebar-spaces-label").textContent = t("sidebar.spaces_count", { n: s.num_spaces });
      }
    } catch (e) { /* ignore, defaults remain */ }
    switchView("dashboard");
    startAutoRefresh();
  }

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------
  applyLanguage();
  setInterval(tickClock, 1000);
  tickClock();

  if (localStorage.getItem(TOKEN_KEY)) {
    document.getElementById("login-screen").style.display = "none";
    document.getElementById("app").style.display = "flex";
    bootstrapApp();
  } else {
    showLogin();
  }
})();
