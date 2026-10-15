// Drives the monitor panel (public/monitor) in jsdom against a REAL local Worker:
//   node tests/monitor_ui.test.mjs <base-url> <ingest-secret> <setup-token>
import assert from "node:assert/strict";
import { JSDOM, VirtualConsole } from "jsdom";

const [BASE, INGEST, SETUP] = process.argv.slice(2);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const errors = [];
let n = 0;
const ok = (c, m) => { assert.ok(c, "FAILED: " + m); n++; console.log("  ok -", m); };

async function waitFor(fn, what, timeout = 8000) {
  const t0 = Date.now();
  for (;;) {
    let v; try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error("timeout waiting for: " + what);
    await sleep(40);
  }
}

const ingest = (kind, record) => fetch(BASE + "/api/ingest", {
  method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + INGEST },
  body: JSON.stringify({ kind, record }),
}).then(r => assert.equal(r.status, 200, kind + " ingest"));

async function openPanel() {
  const vc = new VirtualConsole();
  vc.on("jsdomError", e => errors.push("jsdomError: " + (e.detail || e.message)));
  vc.on("error", (...a) => errors.push("console.error: " + a.join(" ")));
  const dom = await JSDOM.fromURL(BASE + "/monitor/", {
    runScripts: "dangerously", resources: "usable", pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      // jsdom has no fetch(); keep the session cookie by hand (it is Secure, and this is plain http).
      let cookie = "";
      w.fetch = async (u, o = {}) => {
        const res = await fetch(new URL(u, BASE), { ...o, headers: { ...(o.headers || {}), ...(cookie ? { Cookie: cookie } : {}), "CF-Connecting-IP": "198.51.100." + (w.__ip || 77) } });
        // `w.__holdMs`: the next answer of the sessions list arrives late (to make requests overlap).
        if (w.__holdMs && String(u).startsWith("/api/monitor/sessions?")) { const ms = w.__holdMs; w.__holdMs = 0; await sleep(ms); }
        const set = res.headers.get("set-cookie");
        if (set) cookie = set.split(";")[0].endsWith("=") ? "" : set.split(";")[0];
        return res;
      };
      w.confirm = () => true;
      w.addEventListener("error", e => errors.push("window.onerror: " + e.message));
      w.addEventListener("unhandledrejection", e => errors.push("unhandledrejection: " + e.reason));
    },
  });
  await waitFor(() => dom.window.document.getElementById("login-btn"), "panel scripts");
  return dom.window;
}
const visible = (w, id) => !w.document.getElementById(id).hidden;
const type = (w, id, v) => { w.document.getElementById(id).value = v; };
const click = (w, sel) => w.document.querySelector(sel).click();
const tabBtn = (w, name) => w.document.querySelector(`#tabs button[data-tab="${name}"]`);

const T = (d, t) => `2026-10-${d}T${t}-05:00`;
const sess = (over) => ({
  session_token: "ui-token-0001", ticket_id: "TKT-000001", customer_name: "Ana Pérez", plate: "ABC123", phone: "+57 300 1112233",
  person_type: "RESIDENT", unit: "Torre 1 - 101", visiting: null, vehicle: "Renault rojo", source: "MANUAL", checked_in_by: "vigi1",
  checked_out_by: null, space_number: "P03", entry_timestamp: new Date(Date.now() - 95 * 60000).toISOString(), exit_timestamp: null,
  duration_minutes: null, pricing_rule_name: "Hora", pricing_type: "HOURLY", pricing_config_json: "{}", status: "OCCUPIED",
  final_amount: null, currency: "COP", synced_at: T(15, "08:00:05"), ...over,
});

console.log("Monitor panel");
await ingest("session", sess());
await ingest("session", sess({ session_token: "ui-token-0002", ticket_id: "TKT-000002", plate: "XSS999", person_type: "VISITOR",
  customer_name: "<img src=x onerror=window.__xss=1>", unit: "<b>Torre 9</b>", visiting: "\"><script>window.__xss=2</script>" }));
await ingest("audit", { uid: "ui-audit-0001", ts: T(15, "08:00:00"), username: "vigi1", role: "ATTENDANT", action: "SESSION_CHECKIN", subject: "ABC123", details: "name=Ana; type=RESIDENT" });
await ingest("monthly_event", { uid: "ui-event-0001", subscription_id: 5, direction: "IN", ts: T(15, "07:00:00"), customer_name: "Mensual Cinco", plate: "MEN005", space_number: "P05", recorded_by: "vigi1" });

const w = await openPanel();
await check_setup();

async function check_setup() {
  await waitFor(() => visible(w, "setup-screen"), "setup screen on a fresh service");
  ok(!visible(w, "login-screen") && !visible(w, "app"), "only the setup screen is shown at first");
  type(w, "setup-name", "Dueño"); type(w, "setup-token", "wrong-code");
  click(w, "#setup-btn");
  await waitFor(() => /no es correcto/.test(w.document.getElementById("setup-error").textContent), "wrong setup code message");
  type(w, "setup-token", SETUP);
  click(w, "#setup-btn");
  const key = await waitFor(() => w.document.getElementById("setup-key").textContent.startsWith("pk_") && w.document.getElementById("setup-key").textContent, "owner key shown");
  ok(!visible(w, "app") && !w.document.getElementById("setup-result").hidden, "the owner key is displayed once");
  click(w, "#setup-continue");
  await waitFor(() => visible(w, "login-screen"), "login screen after setup");
  ok(w.document.getElementById("setup-key").textContent === "", "the key is cleared from the page");
  await ownerFlow(key);
}

async function ownerFlow(ownerKey) {
  type(w, "login-key", "pk_" + "z".repeat(43));
  click(w, "#login-btn");
  await waitFor(() => /incorrecta/.test(w.document.getElementById("login-error").textContent), "wrong key message");
  type(w, "login-key", ownerKey);
  click(w, "#login-btn");
  await waitFor(() => visible(w, "app"), "panel after login");
  ok(w.document.getElementById("who-name").textContent === "Dueño" && w.document.getElementById("who-role").textContent === "Propietario", "shows who is signed in");
  ok([...w.document.querySelectorAll(".owner-only")].every(el => !el.hidden), "owner sees the Bitácora and Accesos tabs");

  // -- Ahora --
  await waitFor(() => w.document.querySelectorAll("#now-table tbody tr").length === 2, "active sessions listed");
  const kpis = w.document.getElementById("kpis").textContent;
  ok(/Dentro ahora/.test(kpis) && /Mensualistas dentro/.test(kpis) && /Entradas hoy/.test(kpis), "KPI cards");
  const nowText = w.document.getElementById("now-table").textContent;
  ok(/1 h 3\d min|1 h 4\d min/.test(nowText), "elapsed time is computed from the timestamp (≈ 1 h 35 min)");
  ok(w.document.querySelectorAll("#now-monthly tbody tr").length === 1 && /MEN005/.test(w.document.getElementById("now-monthly").textContent), "monthly subscribers inside");

  // -- hostile data from public forms is shown as text, never run --
  ok(nowText.includes("<img src=x onerror=window.__xss=1>"), "a hostile name is displayed literally");
  ok(w.__xss === undefined && !w.document.querySelector("#now-table img") && !w.document.querySelector("#now-table script") && !w.document.querySelector("#now-table b"),
     "…and nothing in it was executed or turned into markup");

  // -- Registro --
  tabBtn(w, "sessions").click();
  await waitFor(() => w.document.querySelectorAll("#sessions-table tbody tr").length === 2, "sessions tab rows");
  const f = w.document.querySelector('#tab-sessions .filters [data-f="q"]');
  f.value = "ABC"; click(w, "#tab-sessions [data-search]");
  await waitFor(() => w.document.querySelectorAll("#sessions-table tbody tr").length === 1, "search narrows the list");
  ok(/\+57 300 1112233/.test(w.document.getElementById("sessions-table").textContent), "the owner sees phone numbers");
  ok(/q=ABC/.test(w.document.querySelector("#tab-sessions [data-export]").href) && /sessions\.csv/.test(w.document.querySelector("#tab-sessions [data-export]").href), "CSV link carries the filters");
  f.value = "no-such-plate"; click(w, "#tab-sessions [data-search]");
  await waitFor(() => !w.document.getElementById("sessions-empty").hidden, "empty state");

  // Two searches overlap and the OLDER one answers last: it must not overwrite the newer result.
  f.value = "ABC"; w.__holdMs = 900; click(w, "#tab-sessions [data-search]");       // slow; would list 1 row
  f.value = "no-such-plate"; click(w, "#tab-sessions [data-search]");               // fast; nothing found
  await sleep(1400);
  ok(!w.document.getElementById("sessions-empty").hidden && w.document.querySelectorAll("#sessions-table tbody tr").length === 0,
     "a late answer from an older search does not overwrite the table");

  // -- Mensualistas / Bitácora --
  tabBtn(w, "monthly").click();
  await waitFor(() => /MEN005/.test(w.document.getElementById("monthly-table").textContent), "monthly movements");
  tabBtn(w, "audit").click();
  await waitFor(() => /Ingreso registrado por el vigilante/.test(w.document.getElementById("audit-table").textContent), "audit rows with Spanish labels");
  ok(/name=Ana · type=RESIDENT/.test(w.document.getElementById("audit-table").textContent), "audit details are readable");
  ok(w.document.getElementById("audit-action").options.length > 20, "audit action filter populated");

  // -- Accesos --
  tabBtn(w, "access").click();
  await waitFor(() => w.document.querySelectorAll("#viewers-table tbody tr").length === 1, "viewer list");
  type(w, "viewer-name", "Administración - Juan");
  click(w, "#viewer-create");
  const viewerKey = await waitFor(() => w.document.getElementById("viewer-new-key").textContent.startsWith("pk_") && w.document.getElementById("viewer-new-key").textContent, "new viewer key");
  ok(w.document.getElementById("viewer-new-name").textContent === "Administración - Juan", "shows whose key it is");
  await waitFor(() => w.document.querySelectorAll("#viewers-table tbody tr").length === 2, "viewer added to the list");
  ok(!w.document.getElementById("viewers-table").textContent.includes(viewerKey), "the key is not in the list");
  ok(w.document.querySelectorAll("#logins-table tbody tr").length >= 1, "recent panel sign-ins are listed");

  // -- sign out, then a read-only viewer --
  click(w, "#logout-btn");
  await waitFor(() => visible(w, "login-screen"), "back at login after logout");
  type(w, "login-key", viewerKey);
  click(w, "#login-btn");
  await waitFor(() => visible(w, "app"), "viewer signs in");
  ok(w.document.getElementById("who-role").textContent === "Consulta", "viewer is labelled 'Consulta'");
  ok([...w.document.querySelectorAll(".owner-only")].every(el => el.hidden), "viewer does not see Bitácora or Accesos");
  tabBtn(w, "sessions").click();
  await waitFor(() => w.document.querySelectorAll("#sessions-table tbody tr").length === 2, "viewer reads sessions");
  ok(!/1112233/.test(w.document.getElementById("sessions-table").textContent), "viewer does not see phone numbers");

  // -- revoked while signed in: the very next request sends them to the login screen --
  const rev = await fetch(BASE + "/api/monitor/login", { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.99" }, body: JSON.stringify({ key: ownerKey }) });
  const ownerCookie = rev.headers.get("set-cookie").split(";")[0];
  const list = await (await fetch(BASE + "/api/monitor/viewers", { headers: { Cookie: ownerCookie } })).json();
  const v = list.viewers.find(x => x.role === "VIEWER");
  assert.equal((await fetch(BASE + "/api/monitor/viewers/" + v.id, { method: "DELETE", headers: { Cookie: ownerCookie } })).status, 200);
  tabBtn(w, "monthly").click();
  await waitFor(() => visible(w, "login-screen"), "revoked viewer is sent to the login screen");
  ok(true, "revoked viewer is sent to the login screen");

  await sleep(200);
  if (errors.length) { console.error("PAGE ERRORS:\n" + errors.join("\n")); process.exit(1); }
  console.log(`ALL OK (${n} checks)`);
  process.exit(0);
}
