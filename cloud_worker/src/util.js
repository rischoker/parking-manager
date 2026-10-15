// Small helpers shared by the Worker modules. No dependencies.

export const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...SECURITY_HEADERS, ...extraHeaders },
  });
}

export const fail = (status, message, extra = {}) => json({ ok: false, error: message, ...extra }, status);

// ---------------------------------------------------------------- crypto --
const enc = new TextEncoder();

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** `bytes` random bytes as URL-safe text. 32 bytes = 256 bits of entropy. */
export function randomToken(bytes = 32) {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Compares two strings without leaking, through timing, where they differ:
 * both are hashed first (so lengths match) and the digests are XOR-compared. */
export async function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// --------------------------------------------------------------- request --
export function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

export function getCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

const MAX_BODY_BYTES = 100_000;

/** Reads a JSON body with a size cap. Throws an Error with .status on bad input. */
export async function readJson(request) {
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > MAX_BODY_BYTES) throw httpError(413, "Cuerpo demasiado grande.");
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw httpError(413, "Cuerpo demasiado grande.");
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value;
  } catch {
    throw httpError(400, "El cuerpo debe ser un objeto JSON.");
  }
}

export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/** For state-changing browser requests: a cross-site page can make the browser
 * send our cookie, but it cannot forge a matching Origin. Requests with no
 * Origin (curl, the parking PC) carry no ambient browser credentials. */
export function sameOriginOrNone(request) {
  const origin = request.headers.get("Origin");
  return !origin || origin === new URL(request.url).origin;
}

// ------------------------------------------------------------ validation --
export const clip = (v, max = 200) => (v == null || v === "" ? null : String(v).slice(0, max));

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?$/;
export const isIso = v => typeof v === "string" && v.length <= 40 && ISO_RE.test(v);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Accepts only real calendar dates written YYYY-MM-DD. */
export function isDateOnly(v) {
  if (typeof v !== "string" || !DATE_RE.test(v)) return false;
  const d = new Date(v + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v);
}

export function nextDay(dateOnly) {
  const d = new Date(dateOnly + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Escapes % _ \ for use in LIKE ... ESCAPE '\' */
export const likeEscape = s => s.replace(/[\\%_]/g, c => "\\" + c);

// ------------------------------------------------------------------- csv --
/** Spreadsheet programs run cells that start with = + - @ as formulas, and
 * these values come from public forms: neutralise with a leading apostrophe.
 * Plain phone numbers such as "+57 300 1234567" are left alone. */
export function csvCell(value) {
  if (value == null) return "";
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s) && !/^\+?[\d\s()-]+$/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function csvResponse(filename, headers, rows) {
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) lines.push(row.map(csvCell).join(","));
  return new Response("\uFEFF" + lines.join("\r\n") + "\r\n", {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      ...SECURITY_HEADERS,
    },
  });
}
