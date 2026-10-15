// Starts the cloud service locally (wrangler dev --local with a throw-away D1 database).
//   import { startLocalWorker } from "./local.mjs"
//   node tests/local.mjs --serve --port 8787 --ingest SECRET --setup TOKEN   (prints READY, runs until killed)
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = join(root, "node_modules", ".bin", "wrangler");

const freePort = () => new Promise((resolve, reject) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on("error", reject);
});

export async function startLocalWorker({ ingest = "test-ingest-secret", setup = "test-setup-token", port } = {}) {
  port = port || await freePort();
  const home = mkdtempSync(join(tmpdir(), "pm-worker-"));
  const env = {
    ...process.env, CI: "1", NO_COLOR: "1", WRANGLER_SEND_METRICS: "false",
    XDG_CONFIG_HOME: join(home, "cfg"), WRANGLER_LOG_PATH: join(home, "logs"),
  };
  const persist = join(home, "state");

  let r = spawnSync("node", [join(root, "scripts", "prepare-public.mjs")], { cwd: root, env, encoding: "utf8" });
  if (r.status !== 0) throw new Error("prepare-public failed:\n" + r.stdout + r.stderr);
  r = spawnSync(wrangler, ["d1", "migrations", "apply", "parking", "--local", "--persist-to", persist], { cwd: root, env, encoding: "utf8" });
  if (r.status !== 0) throw new Error("migrations failed:\n" + r.stdout + r.stderr);

  const child = spawn(wrangler, ["dev", "--local", "--ip", "127.0.0.1", "--port", String(port), "--persist-to", persist,
    "--var", `INGEST_SECRET:${ingest}`, "--var", `SETUP_TOKEN:${setup}`],
    { cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", d => { log += d; });
  child.stderr.on("data", d => { log += d; });

  const base = `http://127.0.0.1:${port}`;
  const stop = () => {
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ }
    rmSync(home, { recursive: true, force: true });
  };
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(base + "/api/health")).ok) return { base, port, ingest, setup, stop }; } catch { /* not up yet */ }
    if (child.exitCode !== null) break;
    await new Promise(r => setTimeout(r, 500));
  }
  stop();
  throw new Error("the local Worker did not start:\n" + log.slice(-3000));
}

if (process.argv.includes("--serve")) {
  const arg = (name, dflt) => { const i = process.argv.indexOf("--" + name); return i > 0 ? process.argv[i + 1] : dflt; };
  const w = await startLocalWorker({ ingest: arg("ingest"), setup: arg("setup"), port: Number(arg("port")) || undefined });
  console.log("READY " + w.base);
  const bye = () => { w.stop(); process.exit(0); };
  process.on("SIGTERM", bye); process.on("SIGINT", bye);
  setInterval(() => {}, 1 << 30);
}
