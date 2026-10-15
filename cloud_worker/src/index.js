// ParkingManager cloud service. One Worker, three jobs:
//   1. receive the records the parking PC pushes          (/api/ingest)
//   2. serve the customer's "my fare" lookup               (/api/session)
//   3. serve the read-only monitor panel for the owner and the administration (/api/monitor/*)
// Static pages (customer page, /monitor/) are served from ./public by the assets binding.
import { handleIngest, handlePublicSession } from "./ingest.js";
import { handleMonitor, handleSetup } from "./monitor.js";
import { fail, json } from "./util.js";

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;

  if (path === "/api/health" && method === "GET") return json({ ok: true, service: "parking-cloud", protocol: 2 });
  if (path === "/api/ingest") {
    return method === "POST" ? handleIngest(request, env) : fail(405, "Use POST.");
  }
  if (path === "/api/session" && method === "GET") return handlePublicSession(request, env);
  if (path === "/api/setup") return handleSetup(request, env);
  if (path.startsWith("/api/monitor/")) return handleMonitor(request, env, path);
  if (path.startsWith("/api/")) return fail(404, "No encontrado.");

  // Anything else is a static page (the assets binding answers 404 itself).
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (e) {
      if (e && e.status) return fail(e.status, e.message);
      console.error("unhandled", e && e.stack || e);
      return fail(500, "Error interno.");
    }
  },
};
