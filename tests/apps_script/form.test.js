// Tests for cloud_sync/CreateGoogleForm.gs against a strict mock of the FormApp calls it uses.
// Run: node tests/apps_script/form.test.js
const fs = require("fs"), vm = require("vm"), assert = require("assert");

// --- strict mock of just the FormApp / SpreadsheetApp surface the script uses
const ITEM_METHODS = new Set(["setTitle", "setHelpText", "setRequired", "setValidation", "setChoices", "createChoice"]);
const FORM_METHODS = new Set(["setDescription","setConfirmationMessage","setCollectEmail","setAllowResponseEdits","setShowLinkToRespondAgain",
  "setProgressBar","setPublishingSummary","setRequireLogin","addTextItem","addCheckboxItem","setDestination","getId","getPublishedUrl",
  "getEditUrl","getDestinationId","setAcceptingResponses"]);
const VALIDATION_METHODS = new Set(["setHelpText","requireTextDoesNotMatchPattern","requireTextMatchesPattern","build"]);
function strict(obj, allowed, label) {
  return new Proxy(obj, { get(t, p) { if (typeof p === "symbol" || p in t) return t[p]; throw new Error(`${label}: unknown method ${String(p)}()`); } });
}
const calls = { items: [], validations: [] };
function makeItem(kind) {
  const item = { kind, title: null, required: false, validation: null, choices: null };
  for (const m of ITEM_METHODS) item[m] = () => item;
  item.setTitle = (t) => { item.title = t; return item; };
  item.setRequired = (r) => { item.required = r; return item; };
  item.setValidation = (v) => { assert.strictEqual(kind, "text", "validation only on text items"); item.validation = v; return item; };
  item.setChoices = (c) => { item.choices = c; return item; };
  item.createChoice = (v) => ({ choice: v });
  item.setHelpText = () => item;
  calls.items.push(item);
  return strict(item, ITEM_METHODS, "Item");
}
function makeForm() {
  const state = { accepting: true, dest: null };
  const form = {};
  for (const m of FORM_METHODS) form[m] = () => form;
  form.addTextItem = () => makeItem("text");
  form.addCheckboxItem = () => makeItem("checkbox");
  form.setDestination = (type, id) => { assert.strictEqual(type, "SPREADSHEET"); state.dest = id; };
  form.getDestinationId = () => state.dest;
  form.getId = () => "FORM_ID";
  form.getPublishedUrl = () => "https://docs.google.com/forms/d/e/FORM_ID/viewform";
  form.getEditUrl = () => "https://docs.google.com/forms/d/FORM_ID/edit";
  form.setAcceptingResponses = (v) => { state.accepting = v; return form; };
  form._state = state;
  return strict(form, FORM_METHODS, "Form");
}
let formInstance = null, propStore = {}, logs = [];
const env = {
  console, JSON, String, Object, Array, RegExp,
  Logger: { log: (m) => logs.push(m) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => propStore[k] || null, setProperty: (k, v) => { propStore[k] = v; } }) },
  SpreadsheetApp: { create: (t) => ({ getId: () => "SS_ID", getUrl: () => "https://docs.google.com/spreadsheets/d/SS_ID/edit", t }),
                    openById: (id) => ({ getUrl: () => "https://docs.google.com/spreadsheets/d/" + id + "/edit" }) },
  FormApp: {
    DestinationType: { SPREADSHEET: "SPREADSHEET" },
    create: (title) => { formInstance = makeForm(); return formInstance; },
    openById: () => formInstance,
    createTextValidation: () => {
      const v = { help: null, kind: null, pattern: null };
      const b = {
        setHelpText: (h) => { v.help = h; return b; },
        requireTextDoesNotMatchPattern: (p) => { v.kind = "not"; v.pattern = p; return b; },
        requireTextMatchesPattern: (p) => { v.kind = "match"; v.pattern = p; return b; },
        build: () => { calls.validations.push(v); return v; },
      };
      return strict(b, VALIDATION_METHODS, "TextValidationBuilder");
    },
  },
};
vm.createContext(env);
const path = require("path");
const file = process.argv[2] || path.join(__dirname, "..", "..", "cloud_sync", "CreateGoogleForm.gs");
vm.runInContext(fs.readFileSync(file, "utf8"), env);

const links = env.crearFormularioDeRegistro();
assert(links.compartir.includes("/viewform") && links.editar.includes("/edit") && links.hojaDeRespuestas.includes("spreadsheets"));
const [name, plate, phone, consent] = calls.items;
assert.deepStrictEqual([name.title, name.required], ["Nombre completo", true]);
assert.deepStrictEqual([plate.title, plate.required], ["Placa del vehículo", true]);
assert.deepStrictEqual([phone.title, phone.required], ["Teléfono (opcional)", false]);
assert.strictEqual(consent.kind, "checkbox"); assert.strictEqual(consent.required, true); assert.strictEqual(consent.choices.length, 1);
assert.strictEqual(calls.items.length, 4, "exactly the 4 intended fields: no time/space/price fields");
assert.strictEqual(formInstance._state.dest, "SS_ID", "answers are linked to the new spreadsheet");

// validation rules behave as intended (JS regex ~ RE2 for these simple patterns)
const rx = (v) => new RegExp(v.pattern);
const [vName, vPlate, vPhone] = calls.validations;
const nameBad = (s) => rx(vName).test(s);                 // "does not match" -> rejected if it matches
for (const bad of ["=1+1", "+cmd", "-2", "@SUM(A1)"]) assert(nameBad(bad), `name ${bad} must be rejected`);
for (const ok of ["Ana Gómez", "José Pérez", "O'Brien", "12 de Octubre SAS"]) assert(!nameBad(ok), `name ${ok} must be accepted`);
for (const ok of ["ABC123", "ABC12D", "abc 123", "XY-1234"]) assert(rx(vPlate).test(ok), `plate ${ok} accepted`);
for (const bad of ["<b>", "=A1", "AB", "ABCDEFGHIJKLM", "A;B1"]) assert(!rx(vPlate).test(bad), `plate ${bad} rejected`);
for (const ok of ["300 000 0000", "+57 300 123 4567", "(601) 234-5678", "3001234567"]) assert(rx(vPhone).test(ok), `phone ${ok} accepted`);
for (const bad of ["+1+1", "=1", "abc", "123", "-5000000"]) assert(!rx(vPhone).test(bad), `phone ${bad} rejected`);

// idempotent: a second run doesn't create a duplicate form
const before = calls.items.length;
env.crearFormularioDeRegistro();
assert.strictEqual(calls.items.length, before, "second run must not create another form");
env.cerrarFormulario(); assert.strictEqual(formInstance._state.accepting, false);
env.abrirFormulario(); assert.strictEqual(formInstance._state.accepting, true);
console.log("CreateGoogleForm.gs: all mock checks passed");
console.log(logs.filter(l => /ENLACE|HOJA/.test(l)).join("\n"));
