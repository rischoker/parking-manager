/**
 * Client-side port of app/pricing_engine.py's calculate_hourly /
 * calculate_flat functions. This has to exist because this page has no
 * backend of its own -- it reads a session's entry time and pricing
 * config directly from the Google Sheet (via Apps Script) and computes
 * the live estimate right here in the browser, the same way
 * mobile_ui/js/mobile.js's local counterpart gets the SAME number from
 * the real backend.
 *
 * IMPORTANT: if you ever change the rounding-method math in
 * app/pricing_engine.py, mirror the change here too -- these two must
 * stay in lock-step or the local page and this page will disagree on a
 * customer's fare. There is deliberately no other cleverness in this
 * file beyond that mirroring.
 */

function calculateHourly(config, minutes) {
  const firstHour = Number(config.first_hour_price);
  const additionalHour = config.additional_hour_price != null ? Number(config.additional_hour_price) : firstHour;
  const method = config.rounding_method || "per_started_hour";
  minutes = Math.max(minutes, 0);

  if (minutes === 0) return round2(firstHour);

  if (method === "exact_fraction") {
    if (minutes <= 60) return round2(firstHour * (minutes / 60));
    return round2(firstHour + additionalHour * ((minutes - 60) / 60));
  }

  if (method === "blocks") {
    let blockMinutes = parseInt(config.block_minutes, 10);
    if (!blockMinutes || blockMinutes <= 0) blockMinutes = 30;
    const totalBlocks = Math.max(1, Math.ceil(minutes / blockMinutes));
    const firstBlockPrice = firstHour * (blockMinutes / 60);
    const otherBlockPrice = additionalHour * (blockMinutes / 60);
    return round2(firstBlockPrice + Math.max(0, totalBlocks - 1) * otherBlockPrice);
  }

  // default: "per_started_hour"
  const hours = Math.max(1, Math.ceil(minutes / 60));
  return round2(firstHour + Math.max(0, hours - 1) * additionalHour);
}

function calculateFlat(config) {
  return round2(Number(config.flat_rate));
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** entry: Date object. referenceEnd: Date object (now, or the real exit
 * time for a completed session). Returns {minutes, amount}. */
function priceSession(entry, referenceEnd, pricingType, configJson) {
  const minutes = Math.max((referenceEnd.getTime() - entry.getTime()) / 60000, 0);
  let config;
  try { config = JSON.parse(configJson || "{}"); } catch (e) { config = {}; }
  const amount = pricingType === "FLAT" ? calculateFlat(config) : calculateHourly(config, minutes);
  return { minutes, amount };
}
