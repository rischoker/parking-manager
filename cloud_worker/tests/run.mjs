// npm test: for each suite, start a local Worker + EMPTY D1 database, run it, stop it.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startLocalWorker } from "./local.mjs";

const here = dirname(fileURLToPath(import.meta.url));
let failed = false;
for (const suite of ["worker.test.mjs", "monitor_ui.test.mjs"]) {
  console.log(`\n=== ${suite} ===`);
  const w = await startLocalWorker();
  try {
    const r = spawnSync("node", [join(here, suite), w.base, w.ingest, w.setup], { stdio: "inherit" });
    if (r.status !== 0) failed = true;
  } finally {
    w.stop();
  }
}
process.exit(failed ? 1 : 0);
