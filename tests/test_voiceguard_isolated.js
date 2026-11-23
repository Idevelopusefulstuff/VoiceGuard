// Offline-only release gate. Explicitly excludes live Discord and browser drivers.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const source = path.join(__dirname, "..", "VoiceGuard.plugin.js");
const candidateSha256 = crypto.createHash("sha256").update(fs.readFileSync(source)).digest("hex");
const suites = [
  "test_voiceguard_plugin.js",
    "test_voiceguard_public_security.js",
  "test_voiceguard_regressions.js",
  "test_voiceguard_hardening.js",
  "test_voiceguard_persistence_edges.js",
  "test_voiceguard_ui_edges.js",
  "test_voiceguard_resize_resilience.js",
  "test_voiceguard_preferences_fuzz.js",
  "test_voiceguard_stress.js",
];
const results = [];
for (const suite of suites) {
  const started = Date.now();
  const args = [path.join(__dirname, suite)];
  if (suite === "test_voiceguard_resize_resilience.js") args.push("--stress");
    if (suite === "test_voiceguard_stress.js" && process.argv.includes("--short-soak")) {
        args.push("--seeds=464367618,12648430,1592594996,826366246", "--steps=4000");
    }
    if (suite === "test_voiceguard_stress.js" && process.argv.includes("--seed-smoke")) {
        args.push("--seed-only", "--seeds=464367618,12648430", "--steps=3000");
    }
  const result = spawnSync(process.execPath, args, {
        cwd: __dirname, encoding: "utf8", windowsHide: true, timeout: suite === "test_voiceguard_stress.js" ? 360000 : 180000,
    maxBuffer: 4 * 1024 * 1024,
  });
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  if (result.error) console.error(result.error.message);
  results.push({ suite, passed: result.status === 0 && !result.error, elapsedMs: Date.now() - started });
}
console.log(JSON.stringify({ candidateSha256, scope: "Synthetic VM fixtures only; no live Discord or browser automation", results }, null, 2));
process.exitCode = results.every(result => result.passed) ? 0 : 1;
