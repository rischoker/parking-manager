// Minimal in-memory emulation of the Apps Script services the .gs files use.
// It is deliberately STRICT about the two Sheets behaviours that matter: on a
// cell that is not formatted as plain text, a string starting with "=" becomes
// a formula and an ISO-looking timestamp becomes a Date.
function makeEnv() {
  const log = { lockWaits: 0, lockReleases: 0 };
  class Sheet {
    constructor(name) { this.name = name; this.cells = {}; this.fmt = {}; this.maxRows = 1000; }
    getName() { return this.name; }
    setName(n) { this.name = n; }
    _key(r, c) { return r + ":" + c; }
    getLastRow() { let m = 0; for (const k in this.cells) { const v = this.cells[k]; if (v !== "" && v != null) m = Math.max(m, +k.split(":")[0]); } return m; }
    appendRow(arr) { const r = this.getLastRow() + 1; arr.forEach((v, i) => this._set(r, i + 1, v)); }
    _set(r, c, v) {
      const k = this._key(r, c);
      if (this.fmt[k] === "@") { this.cells[k] = typeof v === "string" ? v : v; return; }
      if (typeof v === "string" && v.startsWith("=")) { this.cells[k] = { formula: v }; return; }
      if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) { this.cells[k] = new Date(v + (v.endsWith("Z") ? "" : "Z")); return; } // Sheets parses ISO strings to dates
      this.cells[k] = v;
    }
    getRange(r, c, nr = 1, nc = 1) {
      const self = this;
      return {
        setValues(vals) { vals.forEach((row, i) => row.forEach((v, j) => self._set(r + i, c + j, v))); return this; },
        getValues() { const out = []; for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) { const v = self.cells[self._key(r + i, c + j)]; row.push(v === undefined ? "" : (v && v.formula ? v.formula : v)); } out.push(row); } return out; },
        getValue() { return this.getValues()[0][0]; },
        setNumberFormat(f) { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) self.fmt[self._key(r + i, c + j)] = f; return this; },
        setFontWeight() { return this; },
      };
    }
    setFrozenRows() {}
  }
  class Spreadsheet {
    constructor() { this.sheets = [new Sheet("Sheet1")]; }
    getSheets() { return this.sheets; }
    getSheetByName(n) { return this.sheets.find(s => s.name === n) || null; }
    insertSheet(n) { const s = new Sheet(n); this.sheets.push(s); return s; }
    getId() { return "SS_ID"; }
  }
  const ss = new Spreadsheet();
  const env = {
    log, ss, console, JSON, Date, String, Math, Object, Array,
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, flush() {} },
    LockService: { getScriptLock: () => ({ waitLock() { log.lockWaits++; }, releaseLock() { log.lockReleases++; } }) },
    ContentService: { MimeType: { JSON: "json" }, createTextOutput: (t) => ({ text: t, setMimeType() { return this; } }) },
  };
  return env;
}
module.exports = { makeEnv };
