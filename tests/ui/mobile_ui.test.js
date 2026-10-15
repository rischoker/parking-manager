// Smoke test of the customer's QR registration page in jsdom against a
// RUNNING ParkingManager server:  node tests/ui/mobile_ui.test.js http://127.0.0.1:PORT
const { JSDOM, VirtualConsole } = require("jsdom");
const BASE = process.argv[2];
if (!BASE) { console.error("usage: node mobile_ui.test.js <base-url>"); process.exit(2); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const errors = [];
function ok(c, m) { if (!c) throw new Error("FAILED: " + m); console.log("  ok -", m); }
async function waitFor(fn, what, timeout = 8000) {
  const t0 = Date.now();
  for (;;) { let v; try { v = await fn(); } catch (e) { v = null; } if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error("timeout waiting for: " + what); await sleep(40); }
}

async function openRegister(n) {
  const vc = new VirtualConsole();
  // Setting window.location after a successful registration is "not implemented" in jsdom: expected.
  vc.on("jsdomError", e => { if (!/navigation/i.test(e.message)) errors.push("jsdomError: " + e.message); });
  vc.on("error", (...a) => errors.push("console.error: " + a.join(" ")));
  const sent = [];
  const dom = await JSDOM.fromURL(BASE + "/mobile/register", {
    runScripts: "dangerously", resources: "usable", pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.localStorage.setItem("pm_lang", "es");
      // each test "phone" gets its own fake address so the per-device limit never interferes
      w.fetch = (u, o = {}) => { if (o.body) sent.push(JSON.parse(o.body));
        return fetch(new URL(u, BASE), { ...o, headers: { ...(o.headers || {}), "CF-Connecting-IP": `198.51.100.${n}` } }); };
    },
  });
  const w = dom.window, d = w.document;
  await waitFor(() => d.getElementById("submit-btn") && w.eval("typeof I18N") === "object", "page scripts");
  await sleep(150);
  return { w, d, sent };
}
const fill = (d, id, v) => { d.getElementById(id).value = v; };
const admin = async () => {
  const r = await fetch(BASE + "/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", pin: "1234" }) });
  return (await r.json()).token;
};

(async () => {
  console.log("Customer QR page");
  const { w, d, sent } = await openRegister(11);
  ok(d.getElementById("f-type").options.length === 3, "page offers visitor / resident / service");
  ok(/Visitante/.test(d.getElementById("f-type").textContent) && /Torre \/ apartamento/.test(d.body.textContent), "new fields are translated (es)");
  ok(d.getElementById("f-visiting-field").style.display !== "none", "'visiting' is shown for a visitor");
  fill(d, "f-type", "RESIDENT"); d.getElementById("f-type").dispatchEvent(new w.Event("change"));
  ok(d.getElementById("f-visiting-field").style.display === "none", "'visiting' is hidden for a resident");
  fill(d, "f-name", "Laura Residente"); fill(d, "f-plate", "res456");
  fill(d, "f-unit", "Torre 1 - 101"); fill(d, "f-visiting", "no debería enviarse"); fill(d, "f-vehicle", "Kia Picanto gris");
  d.getElementById("submit-btn").click();
  await waitFor(() => sent.length === 1, "registration request");
  ok(sent[0].person_type === "RESIDENT" && sent[0].unit === "Torre 1 - 101" && sent[0].vehicle === "Kia Picanto gris",
     "request carries type, tower/apt and vehicle");
  ok(sent[0].visiting === null, "a resident never sends 'visiting'");

  const token = await admin();
  // the click only *starts* the request: wait until the server has queued it
  const queued = plate => waitFor(async () => {
    const r = await fetch(BASE + "/api/admin/dashboard", { headers: { Authorization: "Bearer " + token } });
    return (await r.json()).pending.find(x => x.plate === plate);
  }, "queued registration " + plate);
  const p = await queued("RES456");
  ok(p && p.person_type === "RESIDENT" && p.unit === "Torre 1 - 101" && p.vehicle === "Kia Picanto gris",
     "the attendant's queue shows what the customer typed");

  // Visitor with the legacy minimal form still works (all new fields optional)
  const V = await openRegister(12);
  fill(V.d, "f-name", "Visitante Simple"); fill(V.d, "f-plate", "vis789");
  V.d.getElementById("submit-btn").click();
  await waitFor(() => V.sent.length === 1, "minimal registration");
  ok(V.sent[0].person_type === "VISITOR" && V.sent[0].unit === null && V.sent[0].visiting === null, "minimal registration defaults to VISITOR");
  const v = await queued("VIS789");
  ok(v.person_type === "VISITOR" && !v.unit, "minimal registration reaches the queue as a visitor");

  await sleep(200);
  if (errors.length) { console.error("PAGE ERRORS:\n" + errors.join("\n")); process.exit(1); }
  console.log("ALL OK"); process.exit(0);
})().catch(e => { console.error(e.message || e); if (errors.length) console.error(errors.join("\n")); process.exit(1); });
