// Black-box tests of the cloud service, run against a REAL local Worker (wrangler dev --local + a
// throw-away D1 database):  node tests/worker.test.mjs <base-url> <ingest-secret> <setup-token>
import assert from "node:assert/strict";

const [BASE, INGEST, SETUP] = process.argv.slice(2);
if (!BASE || !INGEST || !SETUP) { console.error("usage: worker.test.mjs <base> <ingest-secret> <setup-token>"); process.exit(2); }

let ipCounter = 0;
const newIp = () => `198.51.100.${++ipCounter}`;

async function call(method, path, { body, headers = {}, cookie, ip, raw } = {}) {
  const h = { "CF-Connecting-IP": ip || "203.0.113.250", ...headers };
  if (cookie) h.Cookie = cookie;
  if (body !== undefined && !raw) h["Content-Type"] = "application/json";
  const res = await fetch(BASE + path, { method, headers: h, redirect: "manual",
    body: body === undefined ? undefined : (raw ? body : JSON.stringify(body)) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text, headers: res.headers };
}
const ingest = (kind, record, extra = {}) =>
  call("POST", "/api/ingest", { body: { kind, record }, headers: { Authorization: "Bearer " + INGEST }, ...extra });
const cookieOf = res => (res.headers.get("set-cookie") || "").split(";")[0];

let n = 0;
async function check(name, fn) {
  try { await fn(); n++; console.log("  ok -", name); }
  catch (e) { console.error("  FAILED -", name, "\n", e.stack || e); process.exit(1); }
}

const T = (d, t) => `2026-10-${d}T${t}-05:00`;
const session = (over) => ({
  session_token: "tok-aaaa-0001", ticket_id: "TKT-000001", customer_name: "Ana Pérez", plate: "ABC123",
  phone: "+57 300 1112233", person_type: "RESIDENT", unit: "Torre 1 - 101", visiting: null, vehicle: "Renault rojo",
  source: "MANUAL", checked_in_by: "vigi1", checked_out_by: null, space_number: "P03",
  entry_timestamp: T(15, "08:00:00"), exit_timestamp: null, duration_minutes: null, pricing_rule_name: "Hora",
  pricing_type: "HOURLY", pricing_config_json: '{"first_hour_price":5000}', status: "OCCUPIED",
  final_amount: null, currency: "COP", synced_at: T(15, "08:00:05"), ...over,
});

console.log("Ingest");
await check("health and security headers", async () => {
  const r = await call("GET", "/api/health");
  assert.equal(r.status, 200); assert.equal(r.json.ok, true);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(r.headers.get("cache-control"), "no-store");
});
await check("ingest needs the secret (none / wrong / header / body)", async () => {
  assert.equal((await call("POST", "/api/ingest", { body: { kind: "ping" } })).status, 401);
  assert.equal((await call("POST", "/api/ingest", { body: { kind: "ping" }, headers: { Authorization: "Bearer nope" } })).status, 401);
  assert.equal((await call("POST", "/api/ingest", { body: { kind: "ping", secret: "nope" } })).status, 401);
  assert.equal((await call("POST", "/api/ingest", { body: { kind: "ping" }, headers: { Authorization: "Bearer " + INGEST } })).status, 200);
  assert.equal((await call("POST", "/api/ingest", { body: { kind: "ping", secret: INGEST } })).status, 200);
  const bad = await call("POST", "/api/ingest", { body: { kind: "ping" }, headers: { Authorization: "Bearer nope" } });
  assert.match(bad.json.error, /secret/i, "message the PC recognises as a wrong secret");
});
await check("GET on /api/ingest is refused", async () => assert.equal((await call("GET", "/api/ingest")).status, 405));
await check("bad JSON is a 400 for the PC, but gives nothing away without the secret", async () => {
  assert.equal((await call("POST", "/api/ingest", { body: "{not json", raw: true, headers: { Authorization: "Bearer " + INGEST } })).status, 400);
  assert.equal((await call("POST", "/api/ingest", { body: "{not json", raw: true })).status, 401);
  assert.equal((await call("POST", "/api/ingest", { body: JSON.stringify([1]), raw: true, headers: { Authorization: "Bearer " + INGEST } })).status, 400);
});
await check("oversized bodies are refused", async () => {
  const big = JSON.stringify({ kind: "audit", record: { details: "x".repeat(200_000) } });
  const r = await call("POST", "/api/ingest", { body: big, raw: true, headers: { Authorization: "Bearer " + INGEST } });
  assert.equal(r.status, 413);
});
await check("sessions: upsert, validation and no-kind (v1.x) clients", async () => {
  assert.equal((await ingest("session", session())).status, 200);
  assert.equal((await ingest("session", session({ session_token: "x" }))).status, 400);
  assert.equal((await ingest("session", session({ session_token: "tok bad/token" }))).status, 400);
  assert.equal((await ingest("session", session({ status: "HACKED" }))).status, 400);
  assert.equal((await ingest("session", session({ entry_timestamp: "yesterday" }))).status, 400);
  assert.equal((await ingest("session", session({ final_amount: "abc" }))).status, 400);
  assert.equal((await ingest("session", null)).status, 400);
  assert.equal((await ingest("nonsense", {})).status, 400);
  const legacy = await call("POST", "/api/ingest", { body: { secret: INGEST, record: session({ session_token: "tok-legacy-01", plate: "OLD111" }) } });
  assert.equal(legacy.status, 200, "a v1.x client sends no kind: it means 'session'");
});
await check("sessions: an older update never overwrites a newer one", async () => {
  await ingest("session", session({ synced_at: T(15, "08:10:00"), space_number: "P09" }));
  await ingest("session", session({ synced_at: T(15, "08:05:00"), space_number: "P01" }));   // late, stale retry
  const r = await call("GET", "/api/session?token=tok-aaaa-0001");
  assert.equal(r.json.record.space_number, "P09");
});
await check("public lookup returns only what the customer's page needs", async () => {
  const r = await call("GET", "/api/session?token=tok-aaaa-0001");
  assert.equal(r.status, 200);
  const rec = r.json.record;
  assert.equal(rec.plate, "ABC123"); assert.equal(rec.status, "OCCUPIED"); assert.equal(rec.pricing_type, "HOURLY");
  assert.equal(rec.entry_timestamp, T(15, "08:00:00"));
  for (const secret of ["customer_name", "phone", "unit", "visiting", "vehicle", "checked_in_by", "session_token"]) {
    assert.ok(!(secret in rec), `${secret} must not be public`);
  }
  assert.ok(!r.text.includes("Ana") && !r.text.includes("1112233") && !r.text.includes("Torre"));
  assert.equal((await call("GET", "/api/session?token=tok-does-not-exist")).status, 404);
  assert.equal((await call("GET", "/api/session?token=%27%20OR%201%3D1--")).status, 404);
  assert.equal((await call("GET", "/api/session")).status, 404);
});
await check("more sessions, audit rows (idempotent) and monthly movements", async () => {
  await ingest("session", session({ session_token: "tok-aaaa-0002", ticket_id: "TKT-000002", plate: "XYZ789",
    customer_name: '=HYPERLINK("http://evil","x")', phone: null, person_type: "VISITOR", unit: "Torre 2 - 305",
    visiting: "Familia Ruiz", vehicle: null, source: "QR", checked_in_by: null, checked_out_by: "vigi1", space_number: "P07",
    entry_timestamp: T(14, "10:00:00"), exit_timestamp: T(14, "12:30:00"), duration_minutes: 150, status: "COMPLETED",
    final_amount: 8000, synced_at: T(14, "12:30:01") }));
  await ingest("session", session({ session_token: "tok-aaaa-0003", ticket_id: "TKT-000003", plate: "DEF456", customer_name: "Luis Gómez",
    phone: null, person_type: "SERVICE", unit: null, source: "QR", checked_in_by: null, space_number: null,
    entry_timestamp: T(15, "09:00:00"), status: "PENDING_ASSIGNMENT" }));
  await ingest("session", session({ session_token: "tok-aaaa-0004", ticket_id: "TKT-000004", plate: "GONE00", customer_name: "Cancelado",
    status: "CANCELLED", entry_timestamp: T(15, "09:30:00") }));
  const audit = (uid, action, ts, username = "admin", subject = null, details = null) =>
    ingest("audit", { uid, ts, username, role: "ADMIN", action, subject, details });
  for (let i = 0; i < 2; i++) assert.equal((await audit("aud-0000-0001", "SESSION_CHECKIN", T(15, "08:00:00"), "vigi1", "ABC123", "name=Ana; type=RESIDENT")).status, 200);
  await audit("aud-0000-0002", "LOGIN_FAILED", T(15, "08:30:00"), "=cmd|' /C calc'!A0", null, "attempted username");
  await audit("aud-0000-0003", "PRICING_UPDATED", T(15, "09:00:00"), "admin", "Hora", "name=Hora");
  assert.equal((await audit("x", "SESSION_CHECKIN", T(15, "08:00:00"))).status, 400, "short uid");
  assert.equal((await audit("aud-0000-0004", "lower_case", T(15, "08:00:00"))).status, 400, "bad action");
  const ev = (uid, sub, dir, ts, plate, name) =>
    ingest("monthly_event", { uid, subscription_id: sub, direction: dir, ts, customer_name: name, plate, space_number: "P" + sub, recorded_by: "vigi1" });
  await ev("evt-0000-0001", 7, "IN", T(15, "07:00:00"), "MEN007", "Mensual Siete");
  await ev("evt-0000-0002", 7, "OUT", T(15, "09:00:00"), "MEN007", "Mensual Siete");
  await ev("evt-0000-0003", 8, "IN", T(15, "08:30:00"), "MEN008", "Mensual Ocho");
  await ev("evt-0000-0004", 7, "IN", T(15, "10:00:00"), "MEN007", "Mensual Siete");
  await ev("evt-0000-0004", 7, "IN", T(15, "10:00:00"), "MEN007", "Mensual Siete");   // duplicate retry
  assert.equal((await ev("evt-0000-0005", 7, "SIDEWAYS", T(15, "10:00:00"), "MEN007", "x")).status, 400);
});

console.log("First-time setup and sign-in");
const owner = { key: null, cookie: null };
await check("panel needs setup; the wrong code is refused and throttled", async () => {
  assert.deepEqual((await call("GET", "/api/setup")).json, { needs_setup: true, setup_available: true });
  const ip = newIp();
  for (let i = 0; i < 5; i++) assert.equal((await call("POST", "/api/setup", { body: { setup_token: "wrong", name: "Dueño" }, ip })).status, 401);
  const locked = await call("POST", "/api/setup", { body: { setup_token: SETUP, name: "Dueño" }, ip });
  assert.equal(locked.status, 429, "even the right code is refused while locked");
  assert.ok(locked.json.retry_after > 0);
});
await check("setup from a cross-site page is refused", async () => {
  const r = await call("POST", "/api/setup", { body: { setup_token: SETUP, name: "Dueño" }, ip: newIp(), headers: { Origin: "https://evil.example" } });
  assert.equal(r.status, 403);
});
await check("the right code creates the owner key, once", async () => {
  const short = await call("POST", "/api/setup", { body: { setup_token: SETUP, name: "D" }, ip: newIp() });
  assert.equal(short.status, 400);
  const r = await call("POST", "/api/setup", { body: { setup_token: SETUP, name: "Dueño del parqueadero" }, ip: newIp() });
  assert.equal(r.status, 200); assert.match(r.json.key, /^pk_[A-Za-z0-9_-]{40,}$/);
  owner.key = r.json.key;
  assert.equal((await call("POST", "/api/setup", { body: { setup_token: SETUP, name: "Otro" }, ip: newIp() })).status, 409);
  assert.equal((await call("GET", "/api/setup")).json.needs_setup, false);
});
await check("monitor endpoints need a sign-in", async () => {
  for (const p of ["/api/monitor/me", "/api/monitor/now", "/api/monitor/sessions", "/api/monitor/audit", "/api/monitor/viewers", "/api/monitor/export/sessions.csv"]) {
    assert.equal((await call("GET", p)).status, 401, p);
  }
  assert.equal((await call("GET", "/api/monitor/me", { cookie: "pm_monitor=forged-cookie-value" })).status, 401);
});
await check("wrong keys are refused and throttled; the throttle is per address", async () => {
  const ip = newIp();
  for (let i = 0; i < 5; i++) assert.equal((await call("POST", "/api/monitor/login", { body: { key: "pk_" + "x".repeat(43) }, ip })).status, 401);
  const locked = await call("POST", "/api/monitor/login", { body: { key: owner.key }, ip });
  assert.equal(locked.status, 429);
  const other = await call("POST", "/api/monitor/login", { body: { key: owner.key }, ip: newIp() });
  assert.equal(other.status, 200, "another address is not affected");
  assert.equal((await call("POST", "/api/monitor/login", { body: { key: 12345 }, ip: newIp() })).status, 401);
  assert.equal((await call("POST", "/api/monitor/login", { body: { key: "" }, ip: newIp() })).status, 401);
});
await check("login sets a hardened cookie and works; logout kills it", async () => {
  const r = await call("POST", "/api/monitor/login", { body: { key: owner.key }, ip: newIp() });
  assert.equal(r.status, 200); assert.equal(r.json.role, "OWNER");
  const raw = r.headers.get("set-cookie");
  assert.match(raw, /HttpOnly/); assert.match(raw, /Secure/); assert.match(raw, /SameSite=Strict/); assert.match(raw, /Path=\/api/);
  assert.ok(!r.text.includes(cookieOf(r).split("=")[1]), "the session id is never in the body");
  owner.cookie = cookieOf(r);
  assert.equal((await call("GET", "/api/monitor/me", { cookie: owner.cookie })).json.name, "Dueño del parqueadero");
  const second = cookieOf(await call("POST", "/api/monitor/login", { body: { key: owner.key }, ip: newIp() }));
  await call("POST", "/api/monitor/logout", { cookie: second, body: {} });
  assert.equal((await call("GET", "/api/monitor/me", { cookie: second })).status, 401, "logged-out cookie is dead");
  assert.equal((await call("GET", "/api/monitor/me", { cookie: owner.cookie })).status, 200, "other sign-ins are unaffected");
});

console.log("Reading the data");
const get = (path, c = owner.cookie) => call("GET", path, { cookie: c });
await check("'now': who is inside, monthly subscribers by their latest movement, entries today", async () => {
  const r = await get("/api/monitor/now?today=2026-10-15");
  assert.equal(r.status, 200);
  const plates = r.json.sessions.map(s => s.plate).sort();
  assert.deepEqual(plates, ["ABC123", "DEF456", "OLD111"].sort(), "only active sessions; completed and cancelled are not inside");
  assert.deepEqual(r.json.monthly_inside.map(m => m.plate).sort(), ["MEN007", "MEN008"], "7 came back in after leaving; 8 never left");
  assert.equal(r.json.counts.inside, 2); assert.equal(r.json.counts.waiting, 1); assert.equal(r.json.counts.monthly_inside, 2);
  assert.equal(r.json.counts.entries_today, 3 + 3, "3 sessions (cancelled excluded) + 3 monthly IN movements on the 15th");
  assert.ok(!r.text.includes("tok-aaaa"), "session tokens are never shown in the panel");
  assert.equal((await get("/api/monitor/now?today=15-10-2026")).status, 422);
});
await check("sessions list: filters, inclusive end date, pagination, bad input", async () => {
  const all = await get("/api/monitor/sessions");
  assert.equal(all.json.total, 5);   // 0001,0002,0003,0004 + legacy
  assert.equal(all.json.results[0].entry_ts >= all.json.results.at(-1).entry_ts, true, "newest first");
  assert.equal((await get("/api/monitor/sessions?q=abc1")).json.total, 1);
  assert.equal((await get("/api/monitor/sessions?q=Ruiz")).json.total, 1, "search finds who was visited");
  assert.equal((await get("/api/monitor/sessions?q=Torre%201")).json.total, 3, "tower/apartment search");
  assert.equal((await get("/api/monitor/sessions?person_type=SERVICE")).json.total, 1);
  assert.equal((await get("/api/monitor/sessions?status=COMPLETED")).json.total, 1);
  const day = await get("/api/monitor/sessions?date_from=2026-10-14&date_to=2026-10-14");
  assert.equal(day.json.total, 1, "entries on the end date itself are included");
  assert.equal(day.json.results[0].plate, "XYZ789");
  const p = await get("/api/monitor/sessions?limit=2&offset=2");
  assert.equal(p.json.results.length, 2); assert.equal(p.json.total, 5); assert.equal(p.json.offset, 2);
  assert.equal((await get("/api/monitor/sessions?limit=99999")).json.limit, 200, "limit is capped");
  assert.equal((await get("/api/monitor/sessions?date_from=not-a-date")).status, 422);
  assert.equal((await get("/api/monitor/sessions?date_to=2026-02-31")).status, 422);
  assert.equal((await get("/api/monitor/sessions?status=BOGUS")).status, 422);
  assert.equal((await get("/api/monitor/sessions?q=%25")).json.total, 0, "% is searched literally, not as a wildcard");
  const inj = await get("/api/monitor/sessions?q=" + encodeURIComponent("' OR 1=1 --"));
  assert.equal(inj.status, 200); assert.equal(inj.json.total, 0, "SQL injection finds nothing");
});
await check("audit rows were stored once each; filters work", async () => {
  const a = await get("/api/monitor/audit");
  assert.equal(a.json.total, 3, "the duplicated upload created a single row");
  assert.equal(a.json.results[0].action, "PRICING_UPDATED", "newest first");
  assert.equal((await get("/api/monitor/audit?action=LOGIN_FAILED")).json.total, 1);
  assert.equal((await get("/api/monitor/audit?q=vigi1")).json.total, 1);
  assert.equal((await get("/api/monitor/audit?date_from=2026-10-16")).json.total, 0);
  assert.equal((await get("/api/monitor/audit?action=" + encodeURIComponent("x' OR '1'='1"))).json.total, 0);
});
await check("monthly movements: newest first and filterable", async () => {
  const m = await get("/api/monitor/monthly-events");
  assert.equal(m.json.total, 4, "the retried movement was stored once");
  assert.equal(m.json.results[0].ts, T(15, "10:00:00"));
  assert.equal((await get("/api/monitor/monthly-events?direction=OUT")).json.total, 1);
  assert.equal((await get("/api/monitor/monthly-events?q=MEN008")).json.total, 1);
  assert.equal((await get("/api/monitor/monthly-events?direction=SIDEWAYS")).status, 422);
});
await check("CSV export: BOM, formulas neutralised, filters honoured", async () => {
  const r = await get("/api/monitor/export/sessions.csv?person_type=VISITOR");
  assert.equal(r.status, 200); assert.match(r.headers.get("content-type"), /text\/csv/);
  assert.match(r.headers.get("content-disposition"), /attachment; filename="parqueadero_ingresos_\d{4}-\d{2}-\d{2}\.csv"/);
  // fetch().text() strips a leading BOM, so look at the raw bytes.
  const bytes = new Uint8Array(await (await fetch(BASE + "/api/monitor/export/sessions.csv?person_type=VISITOR",
    { headers: { Cookie: owner.cookie, "CF-Connecting-IP": "203.0.113.250" } })).arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xEF, 0xBB, 0xBF], "UTF-8 BOM so Excel reads accents");
  assert.ok(r.text.includes(`"'=HYPERLINK(""http://evil"",""x"")"`), "name starting with = is neutralised");
  assert.ok(!r.text.includes("ABC123"), "filter applied to the export too");
  const all = await get("/api/monitor/export/sessions.csv");
  assert.ok(all.text.includes("+57 300 1112233"), "ordinary phone numbers are not mangled");
  const aud = await get("/api/monitor/export/audit.csv");
  assert.ok(aud.text.includes("'=cmd|"), "audit usernames starting with = are neutralised too");
  assert.equal((await get("/api/monitor/export/monthly-events.csv")).status, 200);
  assert.equal((await get("/api/monitor/export/bogus.csv")).status, 404);
});

console.log("Read-only viewers");
const viewer = { key: null, cookie: null, id: null };
await check("owner creates a viewer; the key is shown once and stored only as a hash", async () => {
  const r = await call("POST", "/api/monitor/viewers", { cookie: owner.cookie, body: { name: "Administración - Juan" } });
  assert.equal(r.status, 201); assert.match(r.json.key, /^pk_/);
  viewer.key = r.json.key; viewer.id = r.json.id;
  const list = await get("/api/monitor/viewers");
  assert.equal(list.json.viewers.length, 2);
  assert.ok(!list.text.includes(viewer.key) && !list.text.includes(owner.key), "keys are never listed");
  assert.ok(!list.text.includes("key_hash"));
  assert.equal((await call("POST", "/api/monitor/viewers", { cookie: owner.cookie, body: { name: "x" } })).status, 400);
  viewer.cookie = cookieOf(await call("POST", "/api/monitor/login", { body: { key: viewer.key }, ip: newIp() }));
  assert.ok(viewer.cookie.startsWith("pm_monitor="));
});
await check("a viewer can read sessions and monthly movements but not the audit, accesses or the owner's phone numbers", async () => {
  const me = await get("/api/monitor/me", viewer.cookie);
  assert.equal(me.json.role, "VIEWER");
  const s = await get("/api/monitor/sessions", viewer.cookie);
  assert.equal(s.status, 200); assert.equal(s.json.total, 5);
  assert.ok(s.json.results.every(r => !("phone" in r)), "phone numbers are for the owner only");
  assert.ok(!(await get("/api/monitor/export/sessions.csv", viewer.cookie)).text.includes("1112233"));
  assert.equal((await get("/api/monitor/now", viewer.cookie)).status, 200);
  assert.equal((await get("/api/monitor/monthly-events", viewer.cookie)).status, 200);
  for (const p of ["/api/monitor/audit", "/api/monitor/viewers", "/api/monitor/export/audit.csv"]) {
    assert.equal((await get(p, viewer.cookie)).status, 403, p);
  }
  assert.equal((await call("POST", "/api/monitor/viewers", { cookie: viewer.cookie, body: { name: "Intruso" } })).status, 403);
  assert.equal((await call("DELETE", "/api/monitor/viewers/1", { cookie: viewer.cookie })).status, 403);
  assert.equal((await call("POST", "/api/ingest", { body: { kind: "ping" }, cookie: viewer.cookie })).status, 401, "a viewer can never write data");
});
await check("cross-site requests cannot act with the cookie", async () => {
  const r = await call("POST", "/api/monitor/viewers", { cookie: owner.cookie, body: { name: "Via Evil" }, headers: { Origin: "https://evil.example" } });
  assert.equal(r.status, 403);
  assert.equal((await call("DELETE", "/api/monitor/viewers/" + viewer.id, { cookie: owner.cookie, headers: { Origin: "https://evil.example" } })).status, 403);
  assert.equal((await get("/api/monitor/me", viewer.cookie)).status, 200, "nothing was revoked");
});
await check("owner and self cannot be revoked; revoking cuts a signed-in viewer off at once", async () => {
  assert.equal((await call("DELETE", "/api/monitor/viewers/1", { cookie: owner.cookie })).status, 400);
  assert.equal((await call("DELETE", "/api/monitor/viewers/999", { cookie: owner.cookie })).status, 404);
  assert.equal((await call("DELETE", "/api/monitor/viewers/abc", { cookie: owner.cookie })).status, 404);
  assert.equal((await call("DELETE", "/api/monitor/viewers/" + viewer.id, { cookie: owner.cookie })).status, 200);
  assert.equal((await get("/api/monitor/me", viewer.cookie)).status, 401, "the open browser session is dead");
  assert.equal((await call("POST", "/api/monitor/login", { body: { key: viewer.key }, ip: newIp() })).status, 401, "and so is the key");
  const list = await get("/api/monitor/viewers");
  assert.ok(list.json.viewers.find(v => v.id === viewer.id).revoked_at);
  assert.ok(list.json.logins.length >= 2 && list.json.logins.every(l => l.name), "owner sees who opened the panel");
});

console.log("Static pages");
await check("customer page and panel are served with a strict CSP; no inline scripts", async () => {
  const home = await call("GET", "/");
  assert.equal(home.status, 200); assert.match(home.headers.get("content-security-policy"), /script-src 'self'/);
  assert.ok(home.text.includes('js/config.js') && home.text.indexOf("config.js") < home.text.indexOf("status.js"));
  const cfg = await call("GET", "/js/config.js");
  assert.match(cfg.text, /PARKING_STATUS_ENDPOINT = "\/api\/session"/);
  const mon = await call("GET", "/monitor/");
  assert.equal(mon.status, 200); assert.match(mon.text, /noindex/);
  assert.match(mon.headers.get("x-robots-tag") || "", /noindex/);
  assert.ok(!/<script>[^<]/.test(mon.text) && !/\son\w+="/.test(mon.text), "no inline script or handlers");
  assert.equal((await call("GET", "/api/nope")).status, 404);
});

console.log(`ALL OK (${n} checks)`);
