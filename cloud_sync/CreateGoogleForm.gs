/**
 * ParkingManager -- creates the customer registration GOOGLE FORM and the
 * GOOGLE SHEET that stores its answers, in one click.
 *
 * Why a script: Google only lets a Form be created from inside your own
 * Google account, so this has to run there (it takes about two minutes, and
 * you only do it once). Nothing here talks to ParkingManager or to anyone
 * else's account -- it just builds a Form and a Sheet in YOUR Drive.
 *
 * HOW TO RUN IT (full walkthrough with screenshots-in-words: FORMULARIO_GOOGLE.md)
 *   1. Go to https://script.google.com  ->  "Nuevo proyecto" (New project).
 *   2. Delete the sample code, paste this whole file, and save (Ctrl+S).
 *   3. Optional: edit CONFIG just below (business name, wording).
 *   4. In the function drop-down choose  crearFormularioDeRegistro  ->  Run.
 *      Google asks you to authorise the script (it needs Forms + Sheets +
 *      Drive access to YOUR files only) -> "Advanced" -> "Go to ... (unsafe)"
 *      is the normal message for a script you wrote/pasted yourself.
 *   5. Open "Execution log": it prints the link to share (the Form), the link
 *      to edit it, and the link to the Sheet where answers are saved.
 *
 * WHAT YOU GET
 *   - A Form asking for: full name, plate, phone (optional), and a
 *     data-processing consent tick-box. Answers are validated (a plate can
 *     only be letters/digits/hyphens; a name can't start with = + - @ so it
 *     can never act as a spreadsheet formula).
 *   - A Sheet "ParkingManager - Registros del formulario". Every submission is
 *     added automatically as a new row. The first column ("Marca temporal" /
 *     "Timestamp") is stamped by GOOGLE's servers when the person presses
 *     Submit -- the customer cannot type or change it, so it is a trustworthy
 *     entry time. The customer also cannot choose a space, a rate or an amount:
 *     the Form simply has no such fields.
 *
 * IMPORTANT LIMITS (be aware of them when deciding how to use this Form)
 *   - A Google Form can't show the customer a live fare or a personal status
 *     link afterwards. The app's own QR page (/mobile/register) does, so keep
 *     that as the main entry and use this Form as the backup / no-Wi-Fi
 *     channel, or when you just want the data in a Sheet.
 *   - Rows are NOT pushed into the ParkingManager window by themselves; the
 *     attendant reads them in the Sheet and assigns the space as usual.
 *   - Do not point the "Cloud Backup" Apps Script at this same spreadsheet
 *     unless you keep its tab name "Sesiones" (it already uses that name).
 */

var CONFIG = {
  businessName: "Parqueadero",
  formTitle: "Registro de ingreso al parqueadero",
  spreadsheetTitle: "ParkingManager - Registros del formulario",
  description:
    "Registra tu vehículo al llegar. Tu hora de entrada queda guardada automáticamente " +
    "y no se puede modificar. Un encargado te asignará un espacio.",
  confirmation:
    "¡Listo! Tu ingreso quedó registrado. Un encargado te asignará un espacio en un momento. " +
    "El valor a pagar se calcula al momento de la salida.",
  consentText:
    "Autorizo el uso de mis datos personales únicamente para gestionar el servicio de parqueadero.",
};

// Property used to remember the Form between runs (so cerrarFormulario() etc.
// know which one to act on).
var PROP_FORM_ID = "PARKINGMANAGER_FORM_ID";

function crearFormularioDeRegistro() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty(PROP_FORM_ID)) {
    Logger.log(
      "Ya existe un formulario creado por este proyecto. Ejecuta mostrarEnlaces() para ver sus " +
      "enlaces (o borra la propiedad " + PROP_FORM_ID + " si quieres crear otro)."
    );
    return mostrarEnlaces();
  }

  var form = FormApp.create(CONFIG.formTitle);
  form.setDescription(CONFIG.description);
  form.setConfirmationMessage(CONFIG.confirmation);
  form.setCollectEmail(false);          // we don't need (or want) their e-mail
  form.setAllowResponseEdits(false);    // nobody can edit an answer after sending it
  form.setShowLinkToRespondAgain(false);
  form.setProgressBar(false);
  form.setPublishingSummary(false);     // never show other people's answers
  try {
    form.setRequireLogin(false);        // anyone with the link, no Google sign-in
  } catch (e) {
    // Some Workspace domains force sign-in; nothing to do, the Form still works.
  }

  // --- Full name ----------------------------------------------------------
  form.addTextItem()
    .setTitle("Nombre completo")
    .setRequired(true)
    .setValidation(
      FormApp.createTextValidation()
        .setHelpText("Escribe tu nombre (no puede empezar con = + - @).")
        .requireTextDoesNotMatchPattern("^[=+@\\-]")
        .build()
    );

  // --- Plate -------------------------------------------------------------
  form.addTextItem()
    .setTitle("Placa del vehículo")
    .setHelpText("Ejemplo: ABC123")
    .setRequired(true)
    .setValidation(
      FormApp.createTextValidation()
        .setHelpText("Solo letras, números y guiones (de 3 a 12 caracteres).")
        .requireTextMatchesPattern("^[A-Za-z0-9 -]{3,12}$")
        .build()
    );

  // --- Phone (optional) --------------------------------------------------
  form.addTextItem()
    .setTitle("Teléfono (opcional)")
    .setHelpText("Ejemplo: 300 000 0000")
    .setRequired(false)
    .setValidation(
      FormApp.createTextValidation()
        .setHelpText("Solo números, espacios, + y guiones.")
        .requireTextMatchesPattern("^\\+?\\(?[0-9][0-9 ()-]{5,28}$")
        .build()
    );

  // --- Consent -----------------------------------------------------------
  var consent = form.addCheckboxItem();
  consent
    .setTitle("Tratamiento de datos")
    .setChoices([consent.createChoice(CONFIG.consentText)])
    .setRequired(true);

  // --- Where the answers go ----------------------------------------------
  var ss = SpreadsheetApp.create(CONFIG.spreadsheetTitle);
  form.setDestination(FormApp.DestinationType.SPREADSHEET, ss.getId());

  props.setProperty(PROP_FORM_ID, form.getId());
  Logger.log("Formulario creado.");
  return mostrarEnlaces();
}

/** Prints (and returns) the three links you need. Safe to run any time. */
function mostrarEnlaces() {
  var id = PropertiesService.getScriptProperties().getProperty(PROP_FORM_ID);
  if (!id) {
    Logger.log("Aún no hay formulario. Ejecuta primero crearFormularioDeRegistro().");
    return null;
  }
  var form = FormApp.openById(id);
  var links = {
    compartir: form.getPublishedUrl(),     // give THIS one to customers / turn it into a QR
    editar: form.getEditUrl(),             // for you, to change questions or wording
    hojaDeRespuestas: form.getDestinationId()
      ? SpreadsheetApp.openById(form.getDestinationId()).getUrl()
      : "(sin hoja vinculada)",
  };
  Logger.log("ENLACE PARA COMPARTIR (QR): " + links.compartir);
  Logger.log("ENLACE PARA EDITAR EL FORMULARIO: " + links.editar);
  Logger.log("HOJA DE GOOGLE CON LAS RESPUESTAS: " + links.hojaDeRespuestas);
  return links;
}

/** Stop accepting answers (e.g. the lot is closed). Re-open with abrirFormulario(). */
function cerrarFormulario() {
  _setAccepting(false);
}

function abrirFormulario() {
  _setAccepting(true);
}

function _setAccepting(accepting) {
  var id = PropertiesService.getScriptProperties().getProperty(PROP_FORM_ID);
  if (!id) {
    Logger.log("Aún no hay formulario. Ejecuta primero crearFormularioDeRegistro().");
    return;
  }
  FormApp.openById(id).setAcceptingResponses(accepting);
  Logger.log(accepting ? "El formulario vuelve a recibir respuestas." : "El formulario ya no recibe respuestas.");
}
