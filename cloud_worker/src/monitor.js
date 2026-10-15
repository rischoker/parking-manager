// The read-only panel for the owner and the complex administration.
//   GET  /api/setup                 -> {needs_setup}
//   POST /api/setup                 first-time creation of the OWNER key (needs SETUP_TOKEN)
//   POST /api/monitor/login         {key}  -> HttpOnly cookie
//   POST /api/monitor/logout
//   GET  /api/monitor/me|now|sessions|monthly-events|audit*   (* owner only)
//   GET  /api/monitor/export/{sessions|monthly-events|audit}.csv
//   GET/POST/DELETE /api/monitor/viewers[/:id]                (owner only)
import {
  clientIp, csvResponse, fail, getCookie, httpError, isDateOnly, json, likeEscape, nextDay, randomToken,
  readJson, safeEqual, sameOriginOrNone, sha256Hex,
} from "./util.js";

const COOKIE = "pm_monitor";
const SESSION_MS = 12 * 3600 * 1000;
const MAX_FAILS = 5;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const MAX_VIEWERS = 25;
const KEY_PREFIX = "pk_";

const isoNow = () => new Date().toISOString();

// ------------------------------------------------------------- throttling --
async function lockedFor(env, key) {
  const row = await env.DB.prepare("SELECT locked_until FROM login_throttle WHERE key = ?").bind(key).first();
  const wait = row ? row.locked_until - Date.now() : 0;
  return wait > 0 ? Math.ceil(wait / 1000) : 0;
}

async function registerFailure(env, key) {
  const now = Date.now();
  const row = await env.DB.prepare("SELECT fails, first_ts FROM login_throttle WHERE key = ?").bind(key).first();
  let fails = 1, first = now;
  if (row && now - row.first_ts < FAIL_WINDOW_MS) { fails = row.fails + 1; first = row.first_ts; }
  // 5 free tries, then 30 s, doubling up to 15 minutes.
  const lock = fails >= MAX_FAILS ? now + Math.min(900, 30 * 2 ** (fails - MAX_FAILS)) * 1000 : 0;
  await env.DB.prepare(
    `INSERT INTO login_throttle (key, fails, first_ts, locked_until) VALUES (?,?,?,?)
     ON CONFLICT(key) DO UPDATE SET fails=excluded.fails, first_ts=excluded.first_ts, locked_until=excluded.locked_until`,
  ).bind(key, fails, first, lock).run();
}

const clearFailures = (env, key) => env.DB.prepare("DELETE FROM login_throttle WHERE key = ?").bind(key).run();

const tooMany = seconds => fail(429, `Demasiados intentos fallidos. Intenta de nuevo en ${seconds} segundos.`,
  { retry_after: seconds });

// ----------------------------------------------------------------- setup --
export async function handleSetup(request, env) {
  const owner = await env.DB.prepare("SELECT 1 AS x FROM viewers WHERE role = 'OWNER' LIMIT 1").first();
  if (request.method === "GET") {
    return json({ needs_setup: !owner, setup_available: !!env.SETUP_TOKEN });
  }
  if (request.method !== "POST") return fail(405, "Método no permitido.");
  if (!sameOriginOrNone(request)) return fail(403, "Origen no permitido.");
  if (owner) return fail(409, "El panel ya fue configurado.");
  if (!env.SETUP_TOKEN) {
    return fail(503, "Falta definir el secreto SETUP_TOKEN en Cloudflare (ver DEPLOY.md).");
  }
  const throttleKey = "setup:" + clientIp(request);
  const wait = await lockedFor(env, throttleKey);
  if (wait) return tooMany(wait);

  const body = await readJson(request);
  if (!(await safeEqual(String(body.setup_token ?? ""), env.SETUP_TOKEN))) {
    await registerFailure(env, throttleKey);
    return fail(401, "El código de configuración no es correcto.");
  }
  const name = String(body.name ?? "").trim().slice(0, 60);
  if (name.length < 2) return fail(400, "Escribe el nombre del propietario (mínimo 2 letras).");

  const key = KEY_PREFIX + randomToken(32);
  // Conditional insert: two simultaneous setups can never create two owners.
  const res = await env.DB.prepare(
    `INSERT INTO viewers (name, role, key_hash, created_at)
     SELECT ?, 'OWNER', ?, ? WHERE NOT EXISTS (SELECT 1 FROM viewers WHERE role = 'OWNER')`,
  ).bind(name, await sha256Hex(key), isoNow()).run();
  if (!res.meta.changes) return fail(409, "El panel ya fue configurado.");
  await clearFailures(env, throttleKey);
  return json({ ok: true, name, key });
}

// ------------------------------------------------------------------ auth --
async function login(request, env) {
  if (!sameOriginOrNone(request)) return fail(403, "Origen no permitido.");
  const ip = clientIp(request);
  const throttleKey = "login:" + ip;
  const wait = await lockedFor(env, throttleKey);
  if (wait) return tooMany(wait);

  const body = await readJson(request);
  const key = typeof body.key === "string" ? body.key.trim() : "";
  const viewer = key.length >= 20 && key.length <= 120
    ? await env.DB.prepare("SELECT id, name, role FROM viewers WHERE key_hash = ? AND revoked_at IS NULL")
        .bind(await sha256Hex(key)).first()
    : null;
  if (!viewer) {
    await registerFailure(env, throttleKey);
    return fail(401, "Llave de acceso incorrecta.");
  }

  const sessionId = randomToken(32);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO web_sessions (id_hash, viewer_id, expires_at) VALUES (?,?,?)")
      .bind(await sha256Hex(sessionId), viewer.id, now + SESSION_MS),
    env.DB.prepare("UPDATE viewers SET last_used_at = ? WHERE id = ?").bind(isoNow(), viewer.id),
    env.DB.prepare("INSERT INTO viewer_logins (viewer_id, ts, ip) VALUES (?,?,?)").bind(viewer.id, isoNow(), ip),
    env.DB.prepare("DELETE FROM viewer_logins WHERE id <= (SELECT MAX(id) FROM viewer_logins) - 500"),
    env.DB.prepare("DELETE FROM web_sessions WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM login_throttle WHERE key = ?").bind(throttleKey),
    // housekeeping: forget old failure counters from addresses that stopped trying
    env.DB.prepare("DELETE FROM login_throttle WHERE first_ts < ? AND locked_until < ?").bind(now - 86400000, now),
  ]);
  return json({ ok: true, name: viewer.name, role: viewer.role }, 200, {
    "Set-Cookie": `${COOKIE}=${sessionId}; HttpOnly; Secure; SameSite=Strict; Path=/api; Max-Age=${SESSION_MS / 1000}`,
  });
}

async function logout(request, env) {
  if (!sameOriginOrNone(request)) return fail(403, "Origen no permitido.");
  const id = getCookie(request, COOKIE);
  if (id) await env.DB.prepare("DELETE FROM web_sessions WHERE id_hash = ?").bind(await sha256Hex(id)).run();
  return json({ ok: true }, 200, {
    "Set-Cookie": `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/api; Max-Age=0`,
  });
}

async function currentViewer(request, env) {
  const id = getCookie(request, COOKIE);
  if (!id || id.length > 100) return null;
  return env.DB.prepare(
    `SELECT v.id, v.name, v.role FROM web_sessions w JOIN viewers v ON v.id = w.viewer_id
      WHERE w.id_hash = ? AND w.expires_at > ? AND v.revoked_at IS NULL`,
  ).bind(await sha256Hex(id), Date.now()).first();
}

// --------------------------------------------------------------- filters --
function limits(params, max = 200) {
  const limit = Math.min(Math.max(parseInt(params.get("limit") || "100", 10) || 100, 1), max);
  const offset = Math.max(parseInt(params.get("offset") || "0", 10) || 0, 0);
  return { limit, offset };
}

function dateRange(params, column, where, binds) {
  const from = params.get("date_from"), to = params.get("date_to");
  if (from) {
    if (!isDateOnly(from)) throw httpError(422, `Fecha inválida: '${from.slice(0, 20)}'`);
    where.push(`${column} >= ?`); binds.push(from);
  }
  if (to) {
    if (!isDateOnly(to)) throw httpError(422, `Fecha inválida: '${to.slice(0, 20)}'`);
    where.push(`${column} < ?`); binds.push(nextDay(to));   // the whole last day is included
  }
}

function textSearch(params, columns, where, binds) {
  const q = (params.get("q") || "").trim().slice(0, 80);
  if (!q) return;
  const like = "%" + likeEscape(q) + "%";
  where.push("(" + columns.map(c => `${c} LIKE ? ESCAPE '\\'`).join(" OR ") + ")");
  columns.forEach(() => binds.push(like));
}

function exact(params, name, column, allowed, where, binds) {
  const v = params.get(name);
  if (!v) return;
  if (allowed && !allowed.includes(v)) throw httpError(422, `Valor inválido para ${name}.`);
  where.push(`${column} = ?`); binds.push(v);
}

const whereSql = where => (where.length ? " WHERE " + where.join(" AND ") : "");

async function page(env, table, columns, where, binds, orderBy, params, shape = r => r) {
  const { limit, offset } = limits(params);
  const total = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}${whereSql(where)}`).bind(...binds).first()).n;
  const rows = await env.DB.prepare(
    `SELECT ${columns} FROM ${table}${whereSql(where)} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
  ).bind(...binds, limit, offset).all();
  return { total, limit, offset, results: rows.results.map(shape) };
}

// ------------------------------------------------------------- sessions --
const SESSION_COLS = `ticket_id, customer_name, plate, phone, person_type, unit, visiting, vehicle, source,
  checked_in_by, checked_out_by, space_number, entry_ts, exit_ts, duration_minutes, status, final_amount, currency`;

function sessionFilters(params) {
  const where = [], binds = [];
  textSearch(params, ["plate", "customer_name", "unit", "visiting", "vehicle", "ticket_id"], where, binds);
  exact(params, "status", "status", ["PENDING_ASSIGNMENT", "OCCUPIED", "COMPLETED", "CANCELLED"], where, binds);
  exact(params, "person_type", "person_type", ["VISITOR", "RESIDENT", "SERVICE"], where, binds);
  dateRange(params, "entry_ts", where, binds);
  return { where, binds };
}

// The phone number is shown to the owner only.
const shapeSession = viewer => row => {
  if (viewer.role !== "OWNER") delete row.phone;
  return row;
};

async function now(request, env, viewer, params) {
  const today = params.get("today");
  if (today && !isDateOnly(today)) throw httpError(422, "Fecha inválida.");
  const active = await env.DB.prepare(
    `SELECT ${SESSION_COLS} FROM sessions WHERE status IN ('PENDING_ASSIGNMENT','OCCUPIED')
      ORDER BY entry_ts DESC LIMIT 300`,
  ).all();
  // A monthly subscriber is inside when the latest movement is an IN.
  const monthly = await env.DB.prepare(
    `SELECT e.ts, e.customer_name, e.plate, e.space_number, e.recorded_by FROM monthly_events e
      WHERE e.direction = 'IN' AND NOT EXISTS (
        SELECT 1 FROM monthly_events n WHERE n.subscription_id = e.subscription_id
          AND (n.ts > e.ts OR (n.ts = e.ts AND n.uid > e.uid)))
      ORDER BY e.ts DESC LIMIT 100`,
  ).all();
  let entriesToday = null;
  if (today) {
    entriesToday = (await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM sessions WHERE entry_ts >= ? AND entry_ts < ? AND status != 'CANCELLED'",
    ).bind(today, nextDay(today)).first()).n
      + (await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM monthly_events WHERE direction='IN' AND ts >= ? AND ts < ?",
      ).bind(today, nextDay(today)).first()).n;
  }
  const sessions = active.results.map(shapeSession(viewer));
  return json({
    ok: true,
    sessions,
    monthly_inside: monthly.results,
    counts: {
      inside: sessions.filter(s => s.status === "OCCUPIED").length,
      waiting: sessions.filter(s => s.status === "PENDING_ASSIGNMENT").length,
      monthly_inside: monthly.results.length,
      entries_today: entriesToday,
    },
  });
}

// ------------------------------------------------------------------ CSV --
const MONTHLY_COLS = "ts, direction, customer_name, plate, space_number, recorded_by, subscription_id";
const AUDIT_COLS = "ts, username, role, action, subject, details";

function monthlyFilters(params) {
  const where = [], binds = [];
  textSearch(params, ["customer_name", "plate", "recorded_by"], where, binds);
  exact(params, "direction", "direction", ["IN", "OUT"], where, binds);
  dateRange(params, "ts", where, binds);
  return { where, binds };
}

function auditFilters(params) {
  const where = [], binds = [];
  textSearch(params, ["subject", "details", "username", "action"], where, binds);
  exact(params, "action", "action", null, where, binds);
  dateRange(params, "ts", where, binds);
  return { where, binds };
}

async function allRows(env, table, columns, where, binds, orderBy) {
  const rows = await env.DB.prepare(
    `SELECT ${columns} FROM ${table}${whereSql(where)} ORDER BY ${orderBy} LIMIT 20000`,
  ).bind(...binds).all();
  return rows.results;
}

async function exportCsv(kind, env, viewer, params) {
  const stamp = new Date().toISOString().slice(0, 10);
  if (kind === "sessions") {
    const { where, binds } = sessionFilters(params);
    const rows = (await allRows(env, "sessions", SESSION_COLS, where, binds, "entry_ts DESC")).map(shapeSession(viewer));
    const heads = ["Ticket", "Nombre", "Placa", "Teléfono", "Tipo", "Torre/Apto", "Visita a", "Vehículo", "Origen",
      "Registró entrada", "Registró salida", "Espacio", "Entrada", "Salida", "Minutos", "Estado", "Valor", "Moneda"];
    return csvResponse(`parqueadero_ingresos_${stamp}.csv`, heads, rows.map(r => [
      r.ticket_id, r.customer_name, r.plate, r.phone ?? "", r.person_type, r.unit, r.visiting, r.vehicle, r.source,
      r.checked_in_by, r.checked_out_by, r.space_number, r.entry_ts, r.exit_ts, r.duration_minutes, r.status,
      r.final_amount, r.currency]));
  }
  if (kind === "monthly-events") {
    const { where, binds } = monthlyFilters(params);
    const rows = await allRows(env, "monthly_events", MONTHLY_COLS, where, binds, "ts DESC");
    return csvResponse(`parqueadero_mensualistas_${stamp}.csv`,
      ["Fecha y hora", "Movimiento", "Nombre", "Placa", "Espacio", "Registró"],
      rows.map(r => [r.ts, r.direction === "IN" ? "Entrada" : "Salida", r.customer_name, r.plate, r.space_number, r.recorded_by]));
  }
  if (kind === "audit") {
    const { where, binds } = auditFilters(params);
    const rows = await allRows(env, "audit", AUDIT_COLS, where, binds, "ts DESC");
    return csvResponse(`parqueadero_bitacora_${stamp}.csv`,
      ["Fecha y hora", "Usuario", "Rol", "Acción", "Sobre", "Detalle"],
      rows.map(r => [r.ts, r.username, r.role, r.action, r.subject, r.details]));
  }
  return fail(404, "Exportación desconocida.");
}

// -------------------------------------------------------------- viewers --
async function listViewers(env) {
  const viewers = await env.DB.prepare(
    "SELECT id, name, role, created_at, last_used_at, revoked_at FROM viewers ORDER BY CASE role WHEN 'OWNER' THEN 0 ELSE 1 END, id ASC",
  ).all();
  const logins = await env.DB.prepare(
    `SELECT l.ts, l.ip, v.name FROM viewer_logins l JOIN viewers v ON v.id = l.viewer_id ORDER BY l.id DESC LIMIT 100`,
  ).all();
  return json({ ok: true, viewers: viewers.results, logins: logins.results });
}

async function createViewer(request, env) {
  const body = await readJson(request);
  const name = String(body.name ?? "").trim().slice(0, 60);
  if (name.length < 2) return fail(400, "Escribe el nombre de la persona (mínimo 2 letras).");
  const active = (await env.DB.prepare("SELECT COUNT(*) AS n FROM viewers WHERE revoked_at IS NULL").first()).n;
  if (active >= MAX_VIEWERS) return fail(400, `Máximo ${MAX_VIEWERS} accesos activos.`);
  const key = KEY_PREFIX + randomToken(32);
  const res = await env.DB.prepare(
    "INSERT INTO viewers (name, role, key_hash, created_at) VALUES (?, 'VIEWER', ?, ?)",
  ).bind(name, await sha256Hex(key), isoNow()).run();
  return json({ ok: true, id: res.meta.last_row_id, name, key }, 201);
}

async function revokeViewer(env, id, me) {
  if (!Number.isInteger(id)) return fail(400, "Identificador inválido.");
  if (id === me.id) return fail(400, "No puedes revocar tu propio acceso.");
  const target = await env.DB.prepare("SELECT role FROM viewers WHERE id = ?").bind(id).first();
  if (!target) return fail(404, "No existe ese acceso.");
  if (target.role === "OWNER") return fail(400, "El acceso del propietario no se puede revocar desde el panel.");
  await env.DB.batch([
    env.DB.prepare("UPDATE viewers SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(isoNow(), id),
    env.DB.prepare("DELETE FROM web_sessions WHERE viewer_id = ?").bind(id),   // signed-in browsers are cut off now
  ]);
  return json({ ok: true });
}

// --------------------------------------------------------------- router --
export async function handleMonitor(request, env, path) {
  const method = request.method;
  const params = new URL(request.url).searchParams;

  if (path === "/api/monitor/login" && method === "POST") return login(request, env);
  if (path === "/api/monitor/logout" && method === "POST") return logout(request, env);

  const me = await currentViewer(request, env);
  if (!me) return fail(401, "Inicia sesión con tu llave de acceso.");
  const owner = me.role === "OWNER";
  const ownerOnly = () => fail(403, "Solo el propietario puede ver esto.");

  if (method !== "GET" && !sameOriginOrNone(request)) return fail(403, "Origen no permitido.");

  if (path === "/api/monitor/me" && method === "GET") return json({ ok: true, name: me.name, role: me.role });
  if (path === "/api/monitor/now" && method === "GET") return now(request, env, me, params);

  if (path === "/api/monitor/sessions" && method === "GET") {
    const { where, binds } = sessionFilters(params);
    return json({ ok: true, ...(await page(env, "sessions", SESSION_COLS, where, binds, "entry_ts DESC", params, shapeSession(me))) });
  }
  if (path === "/api/monitor/monthly-events" && method === "GET") {
    const { where, binds } = monthlyFilters(params);
    return json({ ok: true, ...(await page(env, "monthly_events", MONTHLY_COLS, where, binds, "ts DESC", params)) });
  }
  if (path === "/api/monitor/audit" && method === "GET") {
    if (!owner) return ownerOnly();
    const { where, binds } = auditFilters(params);
    return json({ ok: true, ...(await page(env, "audit", AUDIT_COLS, where, binds, "ts DESC", params)) });
  }

  const csv = path.match(/^\/api\/monitor\/export\/(sessions|monthly-events|audit)\.csv$/);
  if (csv && method === "GET") {
    if (csv[1] === "audit" && !owner) return ownerOnly();
    return exportCsv(csv[1], env, me, params);
  }

  if (path === "/api/monitor/viewers") {
    if (!owner) return ownerOnly();
    if (method === "GET") return listViewers(env);
    if (method === "POST") return createViewer(request, env);
  }
  const one = path.match(/^\/api\/monitor\/viewers\/(\d+)$/);
  if (one && method === "DELETE") {
    if (!owner) return ownerOnly();
    return revokeViewer(env, Number(one[1]), me);
  }
  return fail(404, "No encontrado.");
}
