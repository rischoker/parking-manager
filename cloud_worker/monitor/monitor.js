/* Read-only monitor panel. Spanish only (it is for the owner and the administration).
 * Everything that comes from the server is escaped before it touches the page. */
(() => {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const STATUS = { PENDING_ASSIGNMENT: "Esperando espacio", OCCUPIED: "Dentro", COMPLETED: "Salió", CANCELLED: "Cancelado" };
  const PERSON = { VISITOR: "Visitante", RESIDENT: "Residente", SERVICE: "Servicio / domicilio" };
  const ACTIONS = {
    SESSION_REGISTERED: "Registro por QR", SESSION_CHECKIN: "Ingreso registrado por el vigilante",
    SPACE_ASSIGNED: "Espacio asignado", SESSION_EXIT: "Salida y cobro", SESSION_CANCELLED: "Registro cancelado",
    SUBSCRIPTION_CREATED: "Mensualidad creada", SUBSCRIPTION_UPDATED: "Mensualidad modificada",
    SUBSCRIPTION_CANCELLED: "Mensualidad cancelada", PAYMENT_LOGGED: "Pago de mensualidad",
    PRICING_CREATED: "Tarifa creada", PRICING_UPDATED: "Tarifa modificada", PRICING_DELETED: "Tarifa eliminada",
    SCHEDULE_CREATED: "Horario creado", SCHEDULE_UPDATED: "Horario modificado", SCHEDULE_DELETED: "Horario eliminado",
    USER_CREATED: "Usuario creado", USER_UPDATED: "Usuario modificado", USER_PIN_RESET: "PIN de usuario restablecido",
    PIN_CHANGED: "PIN propio cambiado", SETTINGS_UPDATED: "Ajustes modificados",
    CLOUD_SYNC_UPDATED: "Conexión a la nube modificada", REMOTE_ACCESS_UPDATED: "Acceso remoto modificado",
    STATUS_PAGE_UPDATED: "Página de estado modificada", LOGIN_OK: "Inicio de sesión", LOGIN_FAILED: "Intento de acceso fallido",
  };
  const PAGE_SIZE = 100;

  let me = null;
  let refreshTimer = null;

  // ------------------------------------------------------------ plumbing --
  async function api(path, options = {}) {
    const res = await fetch(path, {
      credentials: "same-origin",
      headers: options.body ? { "Content-Type": "application/json" } : undefined,
      ...options,
    });
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    if (res.status === 401 && !path.endsWith("/login") && !path.endsWith("/setup")) { showLogin(); throw new Error("login"); }
    if (!res.ok) throw new Error((data && data.error) || `Error ${res.status}`);
    return data;
  }

  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg; el.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { el.hidden = true; }, 3500);
  }

  // The server stores the lot's own wall-clock time with its UTC offset; show the wall-clock part as is.
  const fmtTs = s => (s ? String(s).slice(0, 16).replace("T", " ") : "--");

  // Times the CLOUD itself wrote (access creation, panel sign-ins) are UTC: show them in the viewer's own clock.
  function fmtUtc(s) {
    if (!s) return "--";
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return "--";
    const p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function elapsed(s) {
    const t = Date.parse(s);
    if (Number.isNaN(t)) return "--";
    const min = Math.max(0, Math.round((Date.now() - t) / 60000));
    return min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`;
  }

  const who = r => {
    const bits = [];
    if (r.unit) bits.push(esc(r.unit));
    if (r.visiting) bits.push("visita a " + esc(r.visiting));
    if (r.vehicle) bits.push(esc(r.vehicle));
    return `<span class="pill ${esc(r.person_type)}">${esc(PERSON[r.person_type] || r.person_type)}</span>` +
      (bits.length ? `<div class="sub">${bits.join(" &middot; ")}</div>` : "");
  };

  function fillTable(table, headers, rows) {
    $("thead", table).innerHTML = "<tr>" + headers.map(h => `<th>${esc(h)}</th>`).join("") + "</tr>";
    $("tbody", table).innerHTML = rows.join("");
  }

  // ------------------------------------------------------------- screens --
  const show = id => ["setup-screen", "login-screen", "app"].forEach(x => { $("#" + x).hidden = x !== id; });

  function showLogin() {
    clearInterval(refreshTimer);
    show("login-screen");
    $("#login-key").value = "";
    $("#login-key").focus();
  }

  async function boot() {
    try {
      const setup = await api("/api/setup");
      if (setup.needs_setup) {
        show("setup-screen");
        if (!setup.setup_available) {
          $("#setup-error").textContent = "Falta definir el secreto SETUP_TOKEN en Cloudflare (ver DEPLOY.md).";
        }
        return;
      }
      me = await api("/api/monitor/me");
      enterApp();
    } catch (e) {
      if (e.message !== "login") showLogin();
    }
  }

  function enterApp() {
    show("app");
    // A new sign-in starts from a clean slate: no filters left over from the previous person.
    $$(".filters [data-f]").forEach(el => { el.value = ""; });
    $("#viewer-new").hidden = true; $("#viewer-new-key").textContent = "";
    $("#who-name").textContent = me.name;
    $("#who-role").textContent = me.role === "OWNER" ? "Propietario" : "Consulta";
    $$(".owner-only").forEach(el => { el.hidden = me.role !== "OWNER"; });
    $("#audit-action").innerHTML = '<option value="">Todas</option>' +
      Object.entries(ACTIONS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("");
    switchTab("now");
  }

  function switchTab(name) {
    $$("#tabs button").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
    $$(".tab").forEach(t => { t.hidden = t.id !== "tab-" + name; });
    clearInterval(refreshTimer);
    if (name === "now") { loadNow(); refreshTimer = setInterval(loadNow, 20000); }
    else if (name === "sessions") lists.sessions.load(true);
    else if (name === "monthly") lists.monthly.load(true);
    else if (name === "audit") lists.audit.load(true);
    else if (name === "access") loadAccess();
  }

  // ----------------------------------------------------------------- now --
  const localToday = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  async function loadNow() {
    let data;
    try { data = await api("/api/monitor/now?today=" + localToday()); } catch (e) { if (e.message !== "login") toast(e.message); return; }
    const c = data.counts;
    $("#kpis").innerHTML = [
      ["Dentro ahora", c.inside], ["Esperando espacio", c.waiting], ["Mensualistas dentro", c.monthly_inside],
      ["Entradas hoy", c.entries_today ?? "--"],
    ].map(([l, n]) => `<div class="kpi"><div class="n">${esc(n)}</div><div class="l">${esc(l)}</div></div>`).join("");
    fillTable($("#now-table"), ["Entrada", "Lleva", "Placa", "Nombre", "Persona", "Espacio", "Estado", "Registró"],
      data.sessions.map(s => `<tr><td>${esc(fmtTs(s.entry_ts))}</td><td>${esc(elapsed(s.entry_ts))}</td>
        <td class="mono">${esc(s.plate)}</td><td>${esc(s.customer_name)}</td><td>${who(s)}</td>
        <td>${esc(s.space_number || "--")}</td><td>${esc(STATUS[s.status] || s.status)}</td>
        <td>${esc(s.source === "MANUAL" ? s.checked_in_by || "--" : "QR (cliente)")}</td></tr>`));
    $("#now-empty").hidden = data.sessions.length > 0;
    fillTable($("#now-monthly"), ["Entró", "Lleva", "Placa", "Nombre", "Espacio", "Registró"],
      data.monthly_inside.map(m => `<tr><td>${esc(fmtTs(m.ts))}</td><td>${esc(elapsed(m.ts))}</td><td class="mono">${esc(m.plate)}</td>
        <td>${esc(m.customer_name)}</td><td>${esc(m.space_number || "--")}</td><td>${esc(m.recorded_by || "--")}</td></tr>`));
    $("#now-monthly-empty").hidden = data.monthly_inside.length > 0;
    $("#now-updated").textContent = "· actualizado " + new Date().toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  // --------------------------------------------------- filterable lists --
  function makeList({ tab, kind, endpoint, tableId, emptyId, headers, row }) {
    const root = $("#tab-" + tab);
    const filters = $(".filters", root);
    const pager = $(".pager", root);
    let offset = 0;
    let seq = 0;   // only the LAST request may draw: an older, slower answer must not overwrite a newer one

    function params() {
      const p = new URLSearchParams();
      $$("[data-f]", filters).forEach(el => { if (el.value) p.set(el.dataset.f, el.value.trim()); });
      return p;
    }

    async function load(reset) {
      const mine = ++seq;
      if (reset === true) offset = 0;
      const p = params();
      $("[data-export]", filters).href = `/api/monitor/export/${kind}.csv?` + p.toString();
      p.set("limit", PAGE_SIZE); p.set("offset", offset);
      let data;
      try { data = await api(`/api/monitor/${endpoint}?` + p.toString()); } catch (e) { if (mine === seq && e.message !== "login") toast(e.message); return; }
      if (mine !== seq) return;
      fillTable($("#" + tableId), headers, data.results.map(row));
      $("#" + emptyId).hidden = data.results.length > 0;
      const last = Math.min(offset + data.results.length, data.total);
      $("span", pager).textContent = data.total ? `Mostrando ${offset + 1}-${last} de ${data.total}` : "";
      $("[data-prev]", pager).disabled = offset <= 0;
      $("[data-next]", pager).disabled = last >= data.total;
      pager.hidden = data.total <= PAGE_SIZE;
    }

    $("[data-search]", filters).addEventListener("click", () => load(true));
    $$("input", filters).forEach(el => el.addEventListener("keydown", e => { if (e.key === "Enter") load(true); }));
    $("[data-prev]", pager).addEventListener("click", () => { offset = Math.max(0, offset - PAGE_SIZE); load(false); });
    $("[data-next]", pager).addEventListener("click", () => { offset += PAGE_SIZE; load(false); });
    return { load };
  }

  const lists = {
    sessions: makeList({
      tab: "sessions", kind: "sessions", endpoint: "sessions", tableId: "sessions-table", emptyId: "sessions-empty",
      headers: ["Entrada", "Salida", "Placa", "Nombre", "Persona", "Espacio", "Estado", "Valor", "Registró (entrada → salida)"],
      row: s => `<tr><td>${esc(fmtTs(s.entry_ts))}</td><td>${esc(fmtTs(s.exit_ts))}</td><td class="mono">${esc(s.plate)}</td>
        <td>${esc(s.customer_name)}${s.phone ? `<div class="sub">${esc(s.phone)}</div>` : ""}</td><td>${who(s)}</td>
        <td>${esc(s.space_number || "--")}</td><td>${esc(STATUS[s.status] || s.status)}</td>
        <td>${s.final_amount != null ? esc("$" + Math.round(s.final_amount).toLocaleString("es-CO")) : "--"}</td>
        <td class="sub">${esc(s.source === "MANUAL" ? s.checked_in_by || "--" : "QR (cliente)")} &rarr; ${esc(s.checked_out_by || "--")}</td></tr>`,
    }),
    monthly: makeList({
      tab: "monthly", kind: "monthly-events", endpoint: "monthly-events", tableId: "monthly-table", emptyId: "monthly-empty",
      headers: ["Fecha y hora", "Movimiento", "Nombre", "Placa", "Espacio", "Registró"],
      row: e => `<tr><td>${esc(fmtTs(e.ts))}</td><td><span class="pill ${e.direction === "IN" ? "in" : "out"}">${e.direction === "IN" ? "Entrada" : "Salida"}</span></td>
        <td>${esc(e.customer_name)}</td><td class="mono">${esc(e.plate)}</td><td>${esc(e.space_number || "--")}</td><td>${esc(e.recorded_by || "--")}</td></tr>`,
    }),
    audit: makeList({
      tab: "audit", kind: "audit", endpoint: "audit", tableId: "audit-table", emptyId: "audit-empty",
      headers: ["Fecha y hora", "Usuario", "Acción", "Sobre", "Detalle"],
      row: a => `<tr><td>${esc(fmtTs(a.ts))}</td><td>${esc(a.username)}</td><td>${esc(ACTIONS[a.action] || a.action)}</td>
        <td class="mono">${esc(a.subject || "--")}</td><td class="sub">${esc((a.details || "").replace(/; /g, " · "))}</td></tr>`,
    }),
  };

  // -------------------------------------------------------------- access --
  async function loadAccess() {
    let data;
    try { data = await api("/api/monitor/viewers"); } catch (e) { if (e.message !== "login") toast(e.message); return; }
    fillTable($("#viewers-table"), ["Nombre", "Tipo", "Creado", "Última vez", "Estado", ""],
      data.viewers.map(v => `<tr><td>${esc(v.name)}</td><td>${v.role === "OWNER" ? "Propietario" : "Solo consulta"}</td>
        <td>${esc(fmtUtc(v.created_at))}</td><td>${esc(fmtUtc(v.last_used_at))}</td>
        <td>${v.revoked_at ? "Revocado" : "Activo"}</td>
        <td>${v.role !== "OWNER" && !v.revoked_at ? `<button class="btn small" data-revoke="${Number(v.id)}">Quitar acceso</button>` : ""}</td></tr>`));
    $$("[data-revoke]").forEach(b => b.addEventListener("click", async () => {
      if (!confirm("¿Quitar el acceso a esta persona? Su llave deja de funcionar de inmediato.")) return;
      try { await api("/api/monitor/viewers/" + b.dataset.revoke, { method: "DELETE" }); toast("Acceso revocado."); loadAccess(); }
      catch (e) { $("#viewer-error").textContent = e.message; }
    }));
    fillTable($("#logins-table"), ["Fecha y hora", "Persona", "Dirección IP"],
      data.logins.map(l => `<tr><td>${esc(fmtUtc(l.ts))}</td><td>${esc(l.name)}</td><td class="mono">${esc(l.ip || "--")}</td></tr>`));
  }

  function copyKey(elId) {
    const text = $("#" + elId).textContent;
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(
      () => toast("Llave copiada."), () => toast("Selecciona la llave y cópiala con Ctrl+C."));
  }

  // -------------------------------------------------------------- wiring --
  $("#login-btn").addEventListener("click", async () => {
    $("#login-error").textContent = "";
    try {
      me = await api("/api/monitor/login", { method: "POST", body: JSON.stringify({ key: $("#login-key").value }) });
      enterApp();
    } catch (e) { $("#login-error").textContent = e.message; }
  });
  $("#login-key").addEventListener("keydown", e => { if (e.key === "Enter") $("#login-btn").click(); });

  $("#logout-btn").addEventListener("click", async () => {
    try { await api("/api/monitor/logout", { method: "POST", body: "{}" }); } catch { /* ignore */ }
    me = null; showLogin();
  });

  $("#tabs").addEventListener("click", e => { const b = e.target.closest("button[data-tab]"); if (b) switchTab(b.dataset.tab); });

  $("#setup-btn").addEventListener("click", async () => {
    $("#setup-error").textContent = "";
    try {
      const r = await api("/api/setup", { method: "POST", body: JSON.stringify({ name: $("#setup-name").value, setup_token: $("#setup-token").value }) });
      $("#setup-key").textContent = r.key;
      $("#setup-result").hidden = false;
      $("#setup-btn").hidden = true;
      $("#setup-token").value = "";
    } catch (e) { $("#setup-error").textContent = e.message; }
  });
  $("#setup-copy").addEventListener("click", () => copyKey("setup-key"));
  $("#setup-continue").addEventListener("click", () => { $("#setup-key").textContent = ""; boot(); });

  $("#viewer-create").addEventListener("click", async () => {
    $("#viewer-error").textContent = "";
    try {
      const r = await api("/api/monitor/viewers", { method: "POST", body: JSON.stringify({ name: $("#viewer-name").value }) });
      $("#viewer-new-name").textContent = r.name;
      $("#viewer-new-key").textContent = r.key;
      $("#viewer-new").hidden = false;
      $("#viewer-name").value = "";
      loadAccess();
    } catch (e) { $("#viewer-error").textContent = e.message; }
  });
  $("#viewer-copy").addEventListener("click", () => copyKey("viewer-new-key"));

  boot();
})();
