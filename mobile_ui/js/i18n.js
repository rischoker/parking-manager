/* ParkingManager mobile pages -- i18n (Spanish / English). Spanish default. */
const LANG_STORAGE_KEY = "pm_lang";

const I18N = {
  es: {
    "brand.title": "ParkingManager",
    "brand.sub_register": "Registro de ingreso de vehículo",
    "brand.sub_session": "Tu sesión de parqueo",

    "register.title": "Registra tu vehículo",
    "register.hint": "Ingresa tus datos a continuación. Tu hora de llegada se registra automáticamente -- un encargado asignará tu espacio en un momento.",
    "field.full_name": "Nombre completo",
    "field.license_plate": "Placa",
    "field.phone_optional": "Teléfono (opcional)",
    "btn.register_vehicle": "Registrar vehículo",
    "btn.registering": "Registrando...",
    "register.legal": "Al registrarte confirmas que los datos anteriores son correctos. La hora de entrada, la asignación de espacio y el cargo final son establecidos por el encargado del parqueadero y no se pueden cambiar desde esta página.",
    "error.enter_name": "Por favor ingresa tu nombre completo.",
    "error.enter_plate": "Por favor ingresa una placa válida.",
    "error.plate_format": "La placa solo puede tener letras, números y guiones (de 2 a 12 caracteres).",
    "error.phone_format": "El teléfono solo puede tener números, espacios, + y guiones.",

    "session.loading": "Cargando tu sesión...",
    "session.eyebrow": "Sesión de parqueo",
    "session.space_label": "Espacio",
    "session.awaiting": "-- esperando asignación --",
    "session.entry": "Entrada",
    "session.exit": "Salida",
    "session.elapsed": "Transcurrido",
    "session.current_charge": "Cargo estimado actual",
    "session.final_charge": "Cargo final",
    "session.footnote_active": "El monto final se calcula cuando el encargado registra tu salida.",
    "session.footnote_final": "Pagado a la salida.",
    "session.complete": "Sesión completada. Gracias por parquear con nosotros.",
    "session.waiting_msg": "Esperando que el encargado asigne un espacio de parqueo.",
    "session.check_anywhere": "Guardar enlace para consultar desde cualquier lugar",
    "btn.refresh_now": "Actualizar ahora",
    "btn.retry": "Reintentar",

    "no_session.title": "No se encontró sesión activa",
    "no_session.sub": "Escanea el código QR en la entrada para registrar tu vehículo.",
    "session_gone.title": "La sesión ya no está disponible",
    "session_not_found.title": "Sesión no encontrada",
    "session_default.sub": "Por favor escanea el código QR de nuevo para iniciar un nuevo registro.",
    "connection_problem.title": "Problema de conexión",
    "connection_problem.sub": "No se pudo conectar con el servidor de parqueo. Verifica tu conexión Wi-Fi y toca Reintentar.",

    "err.plate_active": "La placa {plate} ya tiene una sesión de parqueo activa.",
    "err.phone_active": "Este número de teléfono ya tiene una sesión de parqueo activa registrada.",
    "err.too_many_registrations": "Demasiados registros desde este dispositivo. Espera unos minutos o pide ayuda al encargado.",
    "err.queue_full": "La fila de registro está llena en este momento. Por favor pide ayuda al encargado.",
    "err.invalid_data": "Revisa los datos ingresados e inténtalo de nuevo.",
  },
  en: {
    "brand.title": "ParkingManager",
    "brand.sub_register": "Vehicle entry registration",
    "brand.sub_session": "Your parking session",

    "register.title": "Register your vehicle",
    "register.hint": "Enter your details below. Your arrival time is recorded automatically -- an attendant will assign your parking space in a moment.",
    "field.full_name": "Full name",
    "field.license_plate": "License plate",
    "field.phone_optional": "Phone (optional)",
    "btn.register_vehicle": "Register vehicle",
    "btn.registering": "Registering...",
    "register.legal": "By registering you confirm the details above are accurate. Entry time, space assignment and final charges are set by the parking attendant and cannot be changed from this page.",
    "error.enter_name": "Please enter your full name.",
    "error.enter_plate": "Please enter a valid license plate.",
    "error.plate_format": "The plate may only contain letters, numbers and hyphens (2 to 12 characters).",
    "error.phone_format": "The phone number may only contain digits, spaces, + and hyphens.",

    "session.loading": "Loading your session...",
    "session.eyebrow": "Parking session",
    "session.space_label": "Space",
    "session.awaiting": "-- awaiting assignment --",
    "session.entry": "Entry",
    "session.exit": "Exit",
    "session.elapsed": "Elapsed",
    "session.current_charge": "Current estimated charge",
    "session.final_charge": "Final charge",
    "session.footnote_active": "Final amount is calculated when the attendant registers your exit.",
    "session.footnote_final": "Paid at exit.",
    "session.complete": "Session complete. Thank you for parking with us.",
    "session.waiting_msg": "Waiting for the attendant to assign a parking space.",
    "session.check_anywhere": "Save this link to check from anywhere",
    "btn.refresh_now": "Refresh now",
    "btn.retry": "Retry",

    "no_session.title": "No active session found",
    "no_session.sub": "Scan the QR code at the entrance to register your vehicle.",
    "session_gone.title": "Session no longer available",
    "session_not_found.title": "Session not found",
    "session_default.sub": "Please scan the QR code again to start a new registration.",
    "connection_problem.title": "Connection problem",
    "connection_problem.sub": "Could not reach the parking server. Check your Wi-Fi connection and tap Retry.",

    "err.plate_active": "Plate {plate} already has an active parking session.",
    "err.phone_active": "This phone number already has an active parking session registered.",
    "err.too_many_registrations": "Too many registrations from this device. Please wait a few minutes or ask the attendant for help.",
    "err.queue_full": "The registration queue is full right now. Please ask the attendant for help.",
    "err.invalid_data": "Please check the data you entered and try again.",
  },
};

function getLang() {
  return localStorage.getItem(LANG_STORAGE_KEY) || "es";
}
function setLang(lang) {
  localStorage.setItem(LANG_STORAGE_KEY, lang);
}
function t(key, vars) {
  const dict = I18N[getLang()] || I18N.es;
  let str = dict[key] ?? I18N.en[key] ?? key;
  if (vars) for (const k in vars) str = str.split(`{${k}}`).join(vars[k]);
  return str;
}

/** Best-effort translation of raw API error text (English, from
 * app/crud.py). Falls back to showing the original message untranslated
 * rather than hiding it when no pattern matches. */
function translateServerMessage(msg) {
  if (!msg) return msg;
  const exact = {
    "This phone number already has an active parking session registered.": "err.phone_active",
    "Too many registrations from this device. Please wait a few minutes or ask the attendant for help.": "err.too_many_registrations",
    "The registration queue is full right now. Please ask the attendant for help.": "err.queue_full",
    "Waiting for the attendant to assign a parking space.": "session.waiting_msg",
    "This session is complete. Thank you for parking with us.": "session.complete",
  };
  if (exact[msg]) return t(exact[msg]);
  const m = msg.match(/^Plate (.+?) already has an active parking session\.?/);
  if (m) return t("err.plate_active", { plate: m[1] });
  return msg;
}

function applyStaticTranslations(root) {
  root = root || document;
  root.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.getAttribute("data-i18n")); });
  root.querySelectorAll("[data-i18n-placeholder]").forEach((el) => { el.placeholder = t(el.getAttribute("data-i18n-placeholder")); });
}

function wireLanguageToggle(onChange) {
  document.querySelectorAll(".lang-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.lang === getLang());
    btn.addEventListener("click", () => {
      setLang(btn.dataset.lang);
      document.querySelectorAll(".lang-btn").forEach((b) => b.classList.toggle("active", b.dataset.lang === getLang()));
      applyStaticTranslations(document);
      document.documentElement.setAttribute("lang", getLang());
      if (onChange) onChange();
    });
  });
}
