import assert from "node:assert/strict";
import test from "node:test";

import {
  runIncidentDrill,
  runRpcFailureDrill,
  runTelegramFailureDrill,
  runStaleCursorDrill,
  runCorruptCursorDrill,
  runMalformedEventDrill,
  runRateLimitDrill,
  runRestartDrill,
  runScannerDiagnosticDrill,
} from "../dist/drill.js";

// ── Positive coverage ────────────────────────────────────────────────────────

test("runIncidentDrill runs all 8 incident scenarios and reports all passing", async () => {
  const report = await runIncidentDrill({ scenario: "all" });
  assert.equal(report.passed, true);
  assert.equal(report.totalScenarios, 8);
  assert.equal(report.passedScenarios, 8);
  assert.equal(report.failedScenarios, 0);
  assert.ok(report.totalDurationMs >= 0);

  const scenarioNames = report.results.map((r) => r.name);
  assert.deepEqual(scenarioNames, [
    "rpc-failure",
    "telegram-failure",
    "stale-cursor",
    "corrupt-cursor",
    "malformed-event",
    "rate-limit",
    "restart",
    "scanner-diagnostic",
  ]);
});

test("individual scenario drill functions complete successfully", async () => {
  const rpc = await runRpcFailureDrill();
  assert.equal(rpc.passed, true);
  assert.equal(rpc.name, "rpc-failure");

  const telegram = await runTelegramFailureDrill();
  assert.equal(telegram.passed, true);
  assert.equal(telegram.name, "telegram-failure");

  const stale = await runStaleCursorDrill();
  assert.equal(stale.passed, true);
  assert.equal(stale.name, "stale-cursor");

  const corrupt = await runCorruptCursorDrill();
  assert.equal(corrupt.passed, true);
  assert.equal(corrupt.name, "corrupt-cursor");

  const malformed = await runMalformedEventDrill();
  assert.equal(malformed.passed, true);
  assert.equal(malformed.name, "malformed-event");

  const rateLimit = await runRateLimitDrill();
  assert.equal(rateLimit.passed, true);
  assert.equal(rateLimit.name, "rate-limit");

  const restart = await runRestartDrill();
  assert.equal(restart.passed, true);
  assert.equal(restart.name, "restart");

  const scanner = await runScannerDiagnosticDrill();
  assert.equal(scanner.passed, true);
  assert.equal(scanner.name, "scanner-diagnostic");
});

// ── Negative coverage ────────────────────────────────────────────────────────

test("runIncidentDrill handles an invalid scenario name gracefully", async () => {
  const report = await runIncidentDrill({ scenario: "non-existent-scenario" });
  assert.equal(report.passed, false);
  assert.equal(report.failedScenarios, 1);
  assert.match(report.results[0].error, /Unknown scenario/);
});

// ── Boundary coverage ────────────────────────────────────────────────────────

test("runRateLimitDrill strictly caps sent messages and skips overflowing events", async () => {
  const res = await runRateLimitDrill();
  assert.equal(res.passed, true);
  assert.ok(res.details.some((d) => d.includes("strictly bounded by maxNotificationsPerCycle")));
  assert.ok(res.details.some((d) => d.includes("overflowing events skipped")));
});

// ── Restart coverage ─────────────────────────────────────────────────────────

test("runRestartDrill preserves version-1 cursor format and clears operator pause", async () => {
  const res = await runRestartDrill();
  assert.equal(res.passed, true);
  assert.ok(res.details.some((d) => d.includes("Cursor file remains strict version 1")));
  assert.ok(res.details.some((d) => d.includes("Process restart resumes polling automatically")));
});

// ── Regression coverage ──────────────────────────────────────────────────────

test("runRpcFailureDrill redacts bot tokens and secret keys in error messages", async () => {
  const res = await runRpcFailureDrill();
  assert.equal(res.passed, true);
  assert.ok(res.details.some((d) => d.includes("bounded and redacted")));
});
