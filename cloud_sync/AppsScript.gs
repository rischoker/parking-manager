/**
 * ParkingManager Cloud Backup + Live Status receiver.
 *
 * Paste this whole file into a Google Sheet's Extensions -> Apps Script
 * editor, then deploy it as a Web App (see CLOUD_BACKUP.md for the exact
 * click-by-click steps).
 *
 * This does two jobs:
 *   1. doPost -- ParkingManager pushes each session's current state here
 *      (on registration, space assignment, and exit), UPDATING the same
 *      row each time by matching on the session's token rather than
 *      always appending a new one. The sheet ends up as one row per
 *      session showing its latest known state -- both a live view of
 *      what's currently happening in the lot, and, once a session
 *      completes, a permanent backup record.
 *   2. doGet -- a free, public, read-only lookup used by the optional
 *      GitHub Pages "check my status from anywhere" page (see
 *      github_pages/ in the project and GITHUB_PAGES_STATUS.md). Given
 *      ?token=..., returns that one session's current data as JSON.
 *      This is deliberately as public as ParkingManager's own local
 *      /api/customer/session/{token} endpoint -- the unguessable token
 *      IS the access control, exactly the same model, just reachable
 *      from anywhere instead of only the local Wi-Fi.
 *
 * SETUP:
 *   1. Set SHARED_SECRET below to any password you choose -- it must match
 *      exactly what you enter in ParkingManager's Settings -> Cloud Backup.
 *      Only doPost (writing) checks this. doGet (reading one's own status
 *      by token) intentionally does not require it -- see above.
 *   2. Deploy -> New deployment -> Web app -> Execute as: Me,
 *      Who has access: Anyone. Copy the resulting URL into ParkingManager.
 *
 * Notes on how the sheet is handled (all deliberate):
 *   - Data lives in a tab called "Sesiones" (SHEET_NAME). Older installs kept
 *     it in the first tab; that tab is still used if it already holds the
 *     ParkingManager header row, so upgrading never splits your data.
 *     Using a named tab means adding other tabs (charts, the Google Form's
 *     "Respuestas", ...) can no longer redirect the backup into the wrong tab.
 *   - Text columns are formatted as plain text. Without that, Google Sheets
 *     "helpfully" turns ISO timestamps into dates (silently shifting times by
 *     the spreadsheet's time zone) and evaluates any value starting with "="
 *     as a formula -- and customer names come from a public form.
 *   - Writes are serialised with a lock, so two sessions arriving at the same
 *     moment can't both append a row or overwrite each other.
 */

var SHARED_SECRET = "CHANGE_ME_TO_A_LONG_RANDOM_VALUE";
var SHEET_NAME = "Sesiones";

var HEADERS = [
  "Token", "Ticket", "Customer", "Plate", "Phone", "Space",
  "Entry", "Exit", "Duration (min)", "Rate", "Rate Type", "Rate Config JSON",
  "Status", "Amount", "Currency", "Updated At",
];
// Every column except these two is stored as plain text.
var NUMERIC_COLUMNS = ["Duration (min)", "Amount"];
var COL = {}; // header name -> 1-based column index, filled in below
HEADERS.forEach(function (name, i) { COL[name] = i + 1; });

function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonResponse({ ok: false, error: "Invalid JSON body" });
  }

  if (!body || body.secret !== SHARED_SECRET) {
    return jsonResponse({ ok: false, error: "Invalid or missing secret" });
  }

  var r = body.record || {};
  if (!r.session_token) {
    return jsonResponse({ ok: false, error: "record.session_token is required" });
  }

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (err) {
    return jsonResponse({ ok: false, error: "Busy, try again" });
  }
  try {
    var sheet = getDataSheet();
    ensureHeaderRow(sheet);

    var rowValues = [
      r.session_token, r.ticket_id || "", r.customer_name || "", r.plate || "",
      r.phone || "", r.space_number || "", r.entry_timestamp || "", r.exit_timestamp || "",
      r.duration_minutes != null ? r.duration_minutes : "", r.pricing_rule_name || "",
      r.pricing_type || "", r.pricing_config_json || "", r.status || "",
      r.final_amount != null ? r.final_amount : "", r.currency || "",
      new Date().toISOString(),
    ];

    var existingRow = findRowByToken(sheet, r.session_token);
    var targetRow = existingRow || sheet.getLastRow() + 1;
    var range = sheet.getRange(targetRow, 1, 1, rowValues.length);
    // Format first, then write: a text-formatted cell stores "=1+1" as text.
    applyColumnFormats(sheet, targetRow, 1);
    range.setValues([rowValues]);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }

  return jsonResponse({ ok: true });
}

function doGet(e) {
  var token = e.parameter && e.parameter.token;
  if (!token) {
    return jsonResponse({ ok: true, message: "ParkingManager cloud backup endpoint is running." });
  }

  var sheet = getDataSheet();
  var rowNum = findRowByToken(sheet, token);
  if (!rowNum) {
    return jsonResponse({ ok: false, error: "No session found for this token." });
  }
  var values = sheet.getRange(rowNum, 1, 1, HEADERS.length).getValues()[0];
  var record = {};
  HEADERS.forEach(function (name, i) { record[name] = values[i]; });

  return jsonResponse({
    ok: true,
    record: {
      session_token: record["Token"],
      ticket_id: record["Ticket"],
      customer_name: record["Customer"],
      plate: record["Plate"],
      space_number: record["Space"],
      entry_timestamp: record["Entry"],
      exit_timestamp: record["Exit"],
      pricing_type: record["Rate Type"],
      pricing_config_json: record["Rate Config JSON"],
      status: record["Status"],
      final_amount: record["Amount"],
      currency: record["Currency"],
    },
  });
}

/** The tab ParkingManager reads and writes: "Sesiones", or -- for installs
 *  that started before that name existed -- the first tab if it already has
 *  our header row. Created on first use otherwise. */
function getDataSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var named = ss.getSheetByName(SHEET_NAME);
  if (named) return named;

  var first = ss.getSheets()[0];
  if (first && first.getLastRow() > 0 && first.getRange(1, 1).getValue() === HEADERS[0]) {
    return first; // legacy layout: keep using it
  }
  if (first && first.getLastRow() === 0) {
    first.setName(SHEET_NAME); // brand-new, empty spreadsheet: just rename Sheet1
    return first;
  }
  return ss.insertSheet(SHEET_NAME);
}

function applyColumnFormats(sheet, row, numRows) {
  HEADERS.forEach(function (name, i) {
    if (NUMERIC_COLUMNS.indexOf(name) === -1) {
      sheet.getRange(row, i + 1, numRows, 1).setNumberFormat("@");
    }
  });
}

function findRowByToken(sheet, token) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  var tokens = sheet.getRange(2, COL["Token"], lastRow - 1, 1).getValues();
  for (var i = 0; i < tokens.length; i++) {
    if (String(tokens[i][0]) === String(token)) return i + 2; // +2: 1-based, plus header row
  }
  return null;
}

function ensureHeaderRow(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight("bold");
    sheet.setFrozenRows(1);
  }
}

function jsonResponse(obj) {
  // IMPORTANT: Apps Script Web Apps always return HTTP 200, even for an
  // application-level error -- there's no way to set a custom status code.
  // Callers (see app/cloud_sync.py and github_pages/js/status.js) must
  // check the "ok" field in the JSON body, not the HTTP status.
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
