// Smoke test of the real administration console (desktop_ui) driven in jsdom
// against a RUNNING ParkingManager server.
//
//   node tests/ui/admin_ui.test.js http://127.0.0.1:PORT
//
// Needs `jsdom` (npm install --no-save jsdom). Exits non-zero on the first
// failed expectation, on any uncaught page error, or on any console.error.
const { JSDOM, VirtualConsole } = require("jsdom");

const BASE = process.argv[2];
if (!BASE) { console.error("usage: node admin_ui.test.js <base-url>"); process.exit(2); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const pageErrors = [];

async function waitFor(fn, what, timeout = 8000) {
  const t0 = Date.now();
  for (;;) {
    let v; try { v = fn(); } catch (e) { v = null; }
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error("timeout waiting for: " + what);
    await sleep(40);
  }
}
function ok(cond, msg) { if (!cond) throw new Error("FAILED: " + msg); console.log("  ok -", msg); }

async function openConsole(lang = "es") {
  const vc = new VirtualConsole();
  vc.on("jsdomError", e => pageErrors.push("jsdomError: " + (e.detail || e.message)));
  vc.on("error", (...a) => pageErrors.push("console.error: " + a.join(" ")));
  const dom = await JSDOM.fromURL(BASE + "/admin", {
    runScripts: "dangerously", resources: "usable", pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.localStorage.setItem("pm_lang", lang);
      // jsdom has no fetch(); route the page's relative calls to Node's.
      w.fetch = (u, o) => fetch(new URL(u, BASE), o);
      w.addEventListener("error", e => pageErrors.push("window.onerror: " + e.message));
      w.addEventListener("unhandledrejection", e => pageErrors.push("unhandledrejection: " + e.reason));
    },
  });
  const w = dom.window, d = w.document;
  // `const I18N` is a global lexical binding, not a window property.
  await waitFor(() => d.getElementById("login-btn") && w.eval("typeof I18N") === "object" && w.eval("typeof t") === "function",
                "console scripts to load");
  await sleep(150);
  return { w, d };
}

async function login({ w, d }, user, pin) {
  d.getElementById("username-input").value = user;
  d.getElementById("pin-input").value = pin;
  d.getElementById("login-btn").click();
  await waitFor(() => d.getElementById("login-screen").style.display === "none", `login as ${user}`);
  await sleep(300);
}
const api = (token, method, path, body) => fetch(BASE + path, {
  method, headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
  body: body ? JSON.stringify(body) : undefined,
}).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));

function setVal(d, id, v) { d.getElementById(id).value = v; }
function clickNav(d, view) { d.querySelector(`.nav-item[data-view="${view}"]`).click(); }

(async () => {
  console.log("Administrator flow");
  const A = await openConsole("es");
  const { w, d } = A;
  await login(A, "admin", "1234");
  const token = w.localStorage.getItem("pm_admin_token");
  ok(token, "got an admin token from the page");

  // -- check-in from the dashboard ------------------------------------------
  ok(d.getElementById("open-checkin-btn") && /Registrar ingreso/.test(d.getElementById("open-checkin-btn").textContent), "dashboard has the 'Registrar ingreso' button");
  d.getElementById("open-checkin-btn").click();
  await waitFor(() => d.getElementById("ci-save-btn"), "check-in form");
  ok(d.getElementById("ci-type").options.length === 3, "check-in form offers visitor / resident / service");
  setVal(d, "ci-name", "Marta Gómez");
  setVal(d, "ci-plate", "uiz123");
  setVal(d, "ci-type", "VISITOR");
  setVal(d, "ci-unit", "Torre 3 - 402");
  setVal(d, "ci-visiting", "Familia Ruiz");
  setVal(d, "ci-vehicle", "Mazda 3 rojo");
  const space = [...d.getElementById("ci-space").options].find(o => o.value);
  ok(space, "check-in form lists free spaces");
  setVal(d, "ci-space", space.value);
  d.getElementById("ci-save-btn").click();
  await waitFor(() => /Ingreso registrado/.test(d.getElementById("toast-container").textContent), "success toast");
  const card = await waitFor(() => [...d.querySelectorAll(".space-card")].find(c => /UIZ123|Marta/.test(c.textContent)), "occupied space card");
  ok(/Visitante/.test(card.textContent) && /Torre 3 - 402/.test(card.textContent) && /visita a Familia Ruiz/.test(card.textContent),
     "occupied space card shows type, tower/apt and whom they visit");

  // -- the same person shows in the session modal --------------------------------
  card.click();
  await waitFor(() => /Visitante/.test(d.getElementById("session-modal-body").textContent), "session detail modal");
  const modalText = d.getElementById("session-modal-body").textContent;
  ok(/Familia Ruiz/.test(modalText) && /Mazda 3 rojo/.test(modalText) && /admin/.test(modalText),
     "session detail shows whom they visit, the vehicle and who registered the entry");
  d.getElementById("close-session-modal").click();
  const dash = await api(token, "GET", "/api/admin/dashboard");
  const occ = dash.body.spaces.find(s => s.occupied && s.occupied.plate === "UIZ123");
  ok(occ && occ.occupied.person_type === "VISITOR" && occ.occupied.unit === "Torre 3 - 402", "API carries the new fields");

  // -- history: filter + 'Registró' column --------------------------------------
  clickNav(d, "history");
  await waitFor(() => d.getElementById("filter-person-type"), "history filters");
  ok(d.querySelectorAll("#view-history thead th").length >= 9, "history table has the extra 'Registró' column");
  ok(/Registró/.test(d.querySelector("#view-history thead").textContent), "history header is translated");

  // -- audit view -------------------------------------------------------------------
  clickNav(d, "audit");
  await waitFor(() => d.querySelectorAll("#audit-table-body tr").length > 0, "audit rows");
  let text = d.getElementById("audit-table-body").textContent;
  ok(/Ingreso registrado por el vigilante/.test(text), "audit lists the gate check-in in Spanish");
  ok(/admin/.test(text) && /UIZ123/.test(text), "audit says who and which plate");
  ok(d.getElementById("audit-action").options.length > 20, "audit action filter is populated");
  setVal(d, "audit-action", "LOGIN_OK");
  d.getElementById("audit-search-btn").click();
  await waitFor(() => [...d.querySelectorAll("#audit-table-body tr")].every(r => /Inicio de sesión/.test(r.textContent)) &&
                      d.querySelectorAll("#audit-table-body tr").length > 0, "filtered by action");
  ok(true, "audit action filter works");

  // -- monthly movements ---------------------------------------------------------------
  const sub = await api(token, "POST", "/api/admin/subscriptions", {
    customer_name: "Pedro Mensual", plate: "MEN111", phone: null,
    space_id: dash.body.spaces.find(s => s.status === "AVAILABLE" && !s.monthly).id, monthly_fee: 90000,
  });
  ok(sub.status === 200 || sub.status === 201, "created a monthly subscription via API (" + sub.status + " " + JSON.stringify(sub.body).slice(0, 120) + ")");
  clickNav(d, "monthly");
  const parkedBtn = await waitFor(() => d.querySelector("[data-toggle-parked]"), "monthly 'marcar entrada' button");
  parkedBtn.click();
  await waitFor(() => d.querySelector("[data-toggle-parked][data-parked='true']"), "subscriber marked as parked");
  d.querySelector("[data-events]").click();
  await waitFor(() => /Entrada/.test(d.getElementById("events-modal-body").textContent), "movements modal");
  ok(/admin/.test(d.getElementById("events-modal-body").textContent), "movements modal shows who recorded it");
  d.getElementById("close-events-modal").click();
  clickNav(d, "audit");
  setVal(d, "audit-kind", "monthly");
  d.getElementById("audit-kind").dispatchEvent(new w.Event("change"));
  await waitFor(() => /MEN111/.test(d.getElementById("audit-table-body").textContent), "monthly movements in the audit view");
  ok(d.getElementById("audit-action-field").style.display === "none", "action filter hidden in monthly mode");

  // -- English renders every new label ----------------------------------------------------
  ok(w.eval('I18N.en["audit.a.SESSION_CHECKIN"]') === "Gate check-in by attendant" &&
     w.eval('I18N.en["person.RESIDENT"]') === "Resident", "English strings exist");

  console.log("Attendant (vigilante) flow");
  const mk = await api(token, "POST", "/api/admin/users", { username: "vigiui", display_name: "Vigi UI", pin: "4321", role: "ATTENDANT" });
  ok([200, 201].includes(mk.status), "created an attendant user");
  const V = await openConsole("es");
  await login(V, "vigiui", "4321");
  ok(V.d.querySelector('.nav-item[data-view="audit"]').style.display === "none", "attendant does not see the Bitácora tab");
  ok(V.d.getElementById("open-checkin-btn"), "attendant has the check-in button");
  V.d.getElementById("open-checkin-btn").click();
  await waitFor(() => V.d.getElementById("ci-save-btn"), "attendant check-in form");
  setVal(V.d, "ci-name", "Servicio Rápido"); setVal(V.d, "ci-plate", "SVC999"); setVal(V.d, "ci-type", "SERVICE");
  V.d.getElementById("ci-save-btn").click();
  await waitFor(() => /Ingreso registrado/.test(V.d.getElementById("toast-container").textContent), "attendant check-in done");
  const audit = await api(token, "GET", "/api/admin/audit?q=SVC999");
  ok(audit.body.results.some(r => r.username === "vigiui" && r.action === "SESSION_CHECKIN"), "audit attributes it to the attendant");

  await sleep(200);
  if (pageErrors.length) { console.error("PAGE ERRORS:\n" + pageErrors.join("\n")); process.exit(1); }
  console.log("ALL OK");
  process.exit(0);
})().catch(e => { console.error(e.message || e); if (pageErrors.length) console.error("PAGE ERRORS:\n" + pageErrors.join("\n")); process.exit(1); });
