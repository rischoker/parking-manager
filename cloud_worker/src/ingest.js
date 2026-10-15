// Receives records from the parking PC (cloud_sync.py, protocol v2):
//   POST /api/ingest   {secret?, kind: session|audit|monthly_event|ping, record}
// plus the customer-facing, token-protected lookup:
//   GET  /api/session?token=...
import { clip, fail, httpError, isIso, json, readJson, safeEqual } from "./util.js";

const STATUSES = new Set(["PENDING_ASSIGNMENT", "OCCUPIED", "COMPLETED", "CANCELLED"]);
const PERSON_TYPES = new Set(["VISITOR", "RESIDENT", "SERVICE"]);
const TOKEN_RE = /^[A-Za-z0-9_-]{8,128}$/;
const UID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const ACTION_RE = /^[A-Z][A-Z_]{1,39}$/;

async function authorised(request, env, body) {
  if (!env.INGEST_SECRET) return false;              // not configured -> nobody gets in
  const auth = request.headers.get("Authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  // Apps-Script-style clients can only put it in the body; both are accepted.
  const supplied = bearer ?? (typeof body?.secret === "string" ? body.secret : null);
  return safeEqual(supplied, env.INGEST_SECRET);
}

function requireIso(value, field, { optional = false } = {}) {
  if (value == null || value === "") {
    if (optional) return null;
    throw httpError(400, `${field} es obligatorio.`);
  }
  if (!isIso(value)) throw httpError(400, `${field} no es una fecha ISO válida.`);
  return value;
}

function intOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw httpError(400, "Número inválido.");
  return Math.round(n);
}

function numOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw httpError(400, "Número inválido.");
  return n;
}

const UPSERT_SESSION = `
INSERT INTO sessions (token, ticket_id, customer_name, plate, phone, person_type, unit, visiting, vehicle,
  source, checked_in_by, checked_out_by, space_number, entry_ts, exit_ts, duration_minutes, pricing_rule_name,
  pricing_type, pricing_config_json, status, final_amount, currency, client_ts, received_at)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(token) DO UPDATE SET
  ticket_id=excluded.ticket_id, customer_name=excluded.customer_name, plate=excluded.plate, phone=excluded.phone,
  person_type=excluded.person_type, unit=excluded.unit, visiting=excluded.visiting, vehicle=excluded.vehicle,
  source=excluded.source, checked_in_by=excluded.checked_in_by, checked_out_by=excluded.checked_out_by,
  space_number=excluded.space_number, entry_ts=excluded.entry_ts, exit_ts=excluded.exit_ts,
  duration_minutes=excluded.duration_minutes, pricing_rule_name=excluded.pricing_rule_name,
  pricing_type=excluded.pricing_type, pricing_config_json=excluded.pricing_config_json, status=excluded.status,
  final_amount=excluded.final_amount, currency=excluded.currency, client_ts=excluded.client_ts,
  received_at=excluded.received_at
WHERE excluded.client_ts >= sessions.client_ts`;

async function saveSession(env, r) {
  if (!TOKEN_RE.test(r.session_token || "")) throw httpError(400, "session_token inválido.");
  if (!STATUSES.has(r.status)) throw httpError(400, "status inválido.");
  const personType = PERSON_TYPES.has(r.person_type) ? r.person_type : "VISITOR";
  const clientTs = r.synced_at == null ? "" : requireIso(r.synced_at, "synced_at");
  await env.DB.prepare(UPSERT_SESSION).bind(
    r.session_token, clip(r.ticket_id, 40), clip(r.customer_name, 160), clip(r.plate, 24), clip(r.phone, 40),
    personType, clip(r.unit, 80), clip(r.visiting, 160), clip(r.vehicle, 120),
    clip(r.source, 10), clip(r.checked_in_by, 60), clip(r.checked_out_by, 60), clip(r.space_number, 12),
    requireIso(r.entry_timestamp, "entry_timestamp", { optional: true }),
    requireIso(r.exit_timestamp, "exit_timestamp", { optional: true }),
    intOrNull(r.duration_minutes), clip(r.pricing_rule_name, 120), clip(r.pricing_type, 30),
    clip(r.pricing_config_json, 4000), r.status, numOrNull(r.final_amount), clip(r.currency, 8),
    clientTs, Date.now(),
  ).run();
}

async function saveAudit(env, r) {
  if (!UID_RE.test(r.uid || "")) throw httpError(400, "uid inválido.");
  if (!ACTION_RE.test(r.action || "")) throw httpError(400, "action inválida.");
  if (!r.username) throw httpError(400, "username es obligatorio.");
  await env.DB.prepare(
    "INSERT OR IGNORE INTO audit (uid, ts, username, role, action, subject, details) VALUES (?,?,?,?,?,?,?)",
  ).bind(r.uid, requireIso(r.ts, "ts"), clip(r.username, 60), clip(r.role, 20), r.action,
         clip(r.subject, 160), clip(r.details, 1500)).run();
}

async function saveMonthlyEvent(env, r) {
  if (!UID_RE.test(r.uid || "")) throw httpError(400, "uid inválido.");
  if (r.direction !== "IN" && r.direction !== "OUT") throw httpError(400, "direction inválida.");
  await env.DB.prepare(
    `INSERT OR IGNORE INTO monthly_events (uid, ts, direction, subscription_id, customer_name, plate, space_number, recorded_by)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).bind(r.uid, requireIso(r.ts, "ts"), r.direction, intOrNull(r.subscription_id), clip(r.customer_name, 160),
         clip(r.plate, 24), clip(r.space_number, 12), clip(r.recorded_by, 60)).run();
}

export async function handleIngest(request, env) {
  let body;
  try { body = await readJson(request); }
  catch (e) {
    // Do not reveal body-validation details to someone who has not proven they know the secret.
    if (!(await authorised(request, env, null))) return fail(401, "Invalid or missing secret");
    throw e;
  }
  if (!(await authorised(request, env, body))) return fail(401, "Invalid or missing secret");

  const kind = body.kind || "session";   // v1.x clients send no kind
  if (kind === "ping") return json({ ok: true, service: "parking-cloud", protocol: 2 });

  const record = body.record;
  if (!record || typeof record !== "object" || Array.isArray(record)) throw httpError(400, "record es obligatorio.");
  if (kind === "session") await saveSession(env, record);
  else if (kind === "audit") await saveAudit(env, record);
  else if (kind === "monthly_event") await saveMonthlyEvent(env, record);
  else throw httpError(400, `kind desconocido: ${String(kind).slice(0, 30)}`);
  return json({ ok: true });
}

/** Public: the customer's own "how much am I paying" lookup. The unguessable
 * token IS the access control; only what that page needs is returned (never
 * the name, phone, tower/apartment or whom they visit). */
export async function handlePublicSession(request, env) {
  const token = new URL(request.url).searchParams.get("token") || "";
  if (!TOKEN_RE.test(token)) return fail(404, "No session found for this token.");
  const row = await env.DB.prepare(
    `SELECT ticket_id, plate, space_number, entry_ts, exit_ts, duration_minutes, pricing_rule_name,
            pricing_type, pricing_config_json, status, final_amount, currency
       FROM sessions WHERE token = ?`,
  ).bind(token).first();
  if (!row) return fail(404, "No session found for this token.");
  return json({
    ok: true,
    record: {
      ticket_id: row.ticket_id, plate: row.plate, space_number: row.space_number,
      entry_timestamp: row.entry_ts, exit_timestamp: row.exit_ts, duration_minutes: row.duration_minutes,
      pricing_rule_name: row.pricing_rule_name, pricing_type: row.pricing_type,
      pricing_config_json: row.pricing_config_json, status: row.status,
      final_amount: row.final_amount, currency: row.currency,
    },
  });
}
