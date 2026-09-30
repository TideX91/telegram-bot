/**
 * SIGTERM / SIGINT shutdown behavior tests — issue #105
 *
 * The production shutdown sequence (index.ts and mock-run.ts) is:
 *
 *   1. SIGTERM (or SIGINT) received
 *   2. poller.stop() called — no new cycles, timer cleared
 *   3. healthServer.close() called — health HTTP stops accepting connections
 *   4. bot.stop() called (index.ts) / health+mock close (mock-run.ts)
 *   5. process.exit(0)
 *
 * These tests cover:
 *
 *   ── Shutdown sequence contract (in-process) ──────────────────────────────
 *   - shutdown() calls poller.stop(), healthServer.close(), then exit(0)
 *   - shutdown() logs the signal name
 *   - shutdown() calls poller.stop() before health server close
 *   - health server close failure is logged but does not prevent exit
 *   - SIGTERM and SIGINT both trigger the shutdown path
 *
 *   ── Subprocess clean-exit (mock-run.ts via dist) ─────────────────────────
 *   - Sending SIGTERM to a running mock:poll process causes exit code 0
 *   - The process logs "[dry-run] SIGTERM received, stopping" before exiting
 *   - Sending SIGINT also causes a clean exit (code 0)
 *
 * The subprocess tests use `mock-run.ts` (via dist/mock-run.js) because it
 * requires no Telegram credentials, no live RPC, and no Testnet. The in-process
 * tests exercise the same shutdown function shape used by index.ts.
 */

import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

// ── Helpers ───────────────────────────────────────────────────────────────────

const MOCK_RUN_CLI = fileURLToPath(new URL("../dist/mock-run.js", import.meta.url));

const ENV_STRIP = [
  "MIMIR_PROFILE",
  "MARKET_CONTRACT_ID",
  "SQUAD_CONTRACT_ID",
  "STELLAR_RPC_URL",
  "STELLAR_HORIZON_URL",
  "STELLAR_NETWORK_PASSPHRASE",
  "STELLAR_EXPLORER_BASE_URL",
  "CURSOR_FILE",
  "BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "OPERATOR_TELEGRAM_USER_ID",
  "POLL_INTERVAL_MS",
  "START_LOOKBACK_LEDGERS",
  "MAX_NOTIFICATIONS_PER_CYCLE",
  "HEALTH_HOST",
  "HEALTH_PORT",
  "HEALTH_STALE_MS",
];

function childEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of ENV_STRIP) delete env[key];
  return { ...env, ...overrides };
}

/**
 * Wait until the predicate returns true, polling every 50 ms.
 * Rejects with a message if the deadline (ms) is exceeded.
 */
async function waitFor(predicate, label, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timeout waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

// ── In-process shutdown sequence tests ───────────────────────────────────────
//
// We cannot call process.exit() in a test (it would kill the runner), so we
// build a minimal shutdown fixture that mirrors the shape of the real function
// but replaces process.exit() with a controllable stub.

function makeShutdownFixture() {
  const calls = { pollerStop: 0, healthClose: 0, botStop: 0, exitCode: null, logLines: [] };

  const poller = {
    stop() {
      calls.pollerStop++;
    },
  };

  const healthServer = {
    async close() {
      calls.healthClose++;
    },
  };

  const bot = {
    async stop() {
      calls.botStop++;
    },
  };

  const log = (line) => { calls.logLines.push(line); };
  const exit = (code) => { calls.exitCode = code; };

  /**
   * The shutdown function mirrors the real index.ts shutdown:
   *
   *   const shutdown = (signal) => {
   *     console.log(`[shutdown] ${signal} received, stopping`);
   *     poller.stop();
   *     void healthServer.close()
   *       .catch(...)
   *       .finally(() => { void bot.stop().finally(() => process.exit(0)); });
   *   };
   */
  function shutdown(signal) {
    log(`[shutdown] ${signal} received, stopping`);
    poller.stop();
    void healthServer
      .close()
      .catch((err) => {
        log(`[shutdown] health server close failed: ${err.message}`);
      })
      .finally(() => {
        void bot.stop().finally(() => exit(0));
      });
  }

  return { shutdown, calls, poller, healthServer, bot };
}

test("shutdown: poller.stop() is called first, before health server close", async () => {
  const order = [];
  const { shutdown } = (() => {
    const calls = { exitCode: null };
    const poller = { stop() { order.push("poller.stop"); } };
    const healthServer = {
      async close() {
        order.push("health.close");
      },
    };
    const bot = { async stop() { order.push("bot.stop"); } };
    const log = () => {};
    const exit = (code) => { calls.exitCode = code; };

    function shutdown(signal) {
      log(`[shutdown] ${signal} received, stopping`);
      poller.stop();
      void healthServer.close().finally(() => {
        void bot.stop().finally(() => exit(0));
      });
    }
    return { shutdown };
  })();

  shutdown("SIGTERM");
  // Flush microtasks so the promise chain runs
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  assert.equal(order[0], "poller.stop", "poller.stop must be called first");
  assert.ok(order.includes("health.close"), "health.close must be called");
  assert.ok(order.includes("bot.stop"), "bot.stop must be called");
  assert.ok(
    order.indexOf("poller.stop") < order.indexOf("health.close"),
    "poller.stop before health.close",
  );
  assert.ok(
    order.indexOf("health.close") < order.indexOf("bot.stop"),
    "health.close before bot.stop",
  );
});

test("shutdown: logs the signal name", () => {
  const { shutdown, calls } = makeShutdownFixture();

  shutdown("SIGTERM");

  assert.ok(
    calls.logLines.some((line) => line.includes("SIGTERM")),
    "must log SIGTERM signal name",
  );
});

test("shutdown: logs SIGINT when SIGINT is the signal", () => {
  const { shutdown, calls } = makeShutdownFixture();

  shutdown("SIGINT");

  assert.ok(
    calls.logLines.some((line) => line.includes("SIGINT")),
    "must log SIGINT signal name",
  );
});

test("shutdown: calls poller.stop()", async () => {
  const { shutdown, calls } = makeShutdownFixture();

  shutdown("SIGTERM");
  await new Promise((r) => setImmediate(r));

  assert.equal(calls.pollerStop, 1, "poller.stop() must be called exactly once");
});

test("shutdown: calls healthServer.close()", async () => {
  const { shutdown, calls } = makeShutdownFixture();

  shutdown("SIGTERM");
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  assert.equal(calls.healthClose, 1, "healthServer.close() must be called");
});

test("shutdown: calls bot.stop() after health server closes", async () => {
  const { shutdown, calls } = makeShutdownFixture();

  shutdown("SIGTERM");
  // Give the promise chain time to resolve
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(calls.botStop, 1, "bot.stop() must be called");
});

test("shutdown: exits with code 0", async () => {
  const { shutdown, calls } = makeShutdownFixture();

  shutdown("SIGTERM");
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(calls.exitCode, 0, "process must exit with code 0");
});

test("shutdown: health server close failure is logged, bot.stop and exit still called", async () => {
  const calls = { pollerStop: 0, botStop: 0, exitCode: null, logLines: [] };

  const poller = { stop() { calls.pollerStop++; } };
  const healthServer = {
    async close() { throw new Error("EADDRINUSE"); },
  };
  const bot = { async stop() { calls.botStop++; } };
  const log = (line) => { calls.logLines.push(line); };
  const exit = (code) => { calls.exitCode = code; };

  function shutdown(signal) {
    log(`[shutdown] ${signal} received, stopping`);
    poller.stop();
    void healthServer
      .close()
      .catch((err) => log(`[shutdown] health server close failed: ${err.message}`))
      .finally(() => { void bot.stop().finally(() => exit(0)); });
  }

  shutdown("SIGTERM");
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(calls.pollerStop, 1, "poller.stop() must still be called");
  assert.equal(calls.botStop, 1, "bot.stop() must still be called despite health.close() error");
  assert.equal(calls.exitCode, 0, "must still exit 0 despite health.close() error");
  assert.ok(
    calls.logLines.some((line) => line.includes("health server close failed")),
    "health close error must be logged",
  );
});

test("shutdown: repeated SIGTERM (idempotent via process.once semantics) — second call is independent", async () => {
  // process.once() in the real code means only the first SIGTERM fires the
  // registered handler. Here we verify the shutdown function itself is safe to
  // call twice (e.g. in tests that reuse the fixture).
  const { shutdown, calls } = makeShutdownFixture();

  shutdown("SIGTERM");
  shutdown("SIGTERM");
  await new Promise((r) => setTimeout(r, 20));

  // Both calls fire — the idempotency guarantee lives at process.once level.
  // What matters: no throw, no NaN exit code.
  assert.equal(typeof calls.exitCode, "number");
  assert.equal(calls.exitCode, 0);
});

// ── Subprocess clean-exit tests ────────────────────────────────────────────────
//
// These use dist/mock-run.js (MIMIR_PROFILE=mock, --port 0) so no credentials,
// no live Testnet RPC, and no Telegram are needed. The shutdown path in
// mock-run.ts mirrors the one in index.ts but closes the mock RPC too.

test("mock:poll exits with code 0 on SIGTERM", async () => {
  const child = spawn(
    process.execPath,
    [MOCK_RUN_CLI, "--port", "0"],
    {
      env: childEnv({ HEALTH_PORT: "0" }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { out += chunk; });

  try {
    // Wait until the first scan completes and a send is logged — at that
    // point the poller is idle (between cycles), the signal handlers are
    // registered, and mock.close() will not block on an in-flight request.
    await waitFor(
      () => out.includes("[dry-run] health") && out.includes("would send"),
      "first scan complete with send log",
      15_000,
    );

    child.kill("SIGTERM");
    const [code] = await once(child, "exit");

    assert.equal(code, 0, `expected exit 0 after SIGTERM, got ${code}\noutput:\n${out}`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

test("mock:poll logs SIGTERM received and stopping before exit", async () => {
  const child = spawn(
    process.execPath,
    [MOCK_RUN_CLI, "--port", "0"],
    {
      env: childEnv({ HEALTH_PORT: "0" }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { out += chunk; });

  try {
    await waitFor(
      () => out.includes("[dry-run] health") && out.includes("would send"),
      "first scan complete with send log",
      15_000,
    );

    child.kill("SIGTERM");
    await once(child, "exit");

    assert.ok(
      out.includes("[dry-run] SIGTERM received"),
      `expected SIGTERM shutdown log in output:\n${out}`,
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

test("mock:poll exits with code 0 on SIGINT", async () => {
  const child = spawn(
    process.execPath,
    [MOCK_RUN_CLI, "--port", "0"],
    {
      env: childEnv({ HEALTH_PORT: "0" }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { out += chunk; });

  try {
    // Wait until the first scan completes — at that point the process is idle
    // between cycles and the signal handlers are registered and ready.
    await waitFor(
      () => out.includes("[dry-run] health") && out.includes("would send"),
      "first scan complete with send log",
      15_000,
    );

    child.kill("SIGINT");
    const [code] = await once(child, "exit");

    assert.equal(code, 0, `expected exit 0 after SIGINT, got ${code}\noutput:\n${out}`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

test("mock:poll logs SIGINT received and stopping before exit", async () => {
  const child = spawn(
    process.execPath,
    [MOCK_RUN_CLI, "--port", "0"],
    {
      env: childEnv({ HEALTH_PORT: "0" }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { out += chunk; });

  try {
    await waitFor(
      () => out.includes("[dry-run] health") && out.includes("would send"),
      "first scan complete with send log",
      15_000,
    );

    child.kill("SIGINT");
    await once(child, "exit");

    assert.ok(
      out.includes("[dry-run] SIGINT received"),
      `expected SIGINT shutdown log in output:\n${out}`,
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

test("mock:poll does not exit non-zero on a clean SIGTERM (no error output)", async () => {
  const child = spawn(
    process.execPath,
    [MOCK_RUN_CLI, "--port", "0"],
    {
      env: childEnv({ HEALTH_PORT: "0" }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  try {
    await waitFor(
      () => stdout.includes("[dry-run] health") && stdout.includes("would send"),
      "first scan complete with send log",
      15_000,
    );

    child.kill("SIGTERM");
    const [code] = await once(child, "exit");

    assert.equal(code, 0, `expected exit 0\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    // Graceful shutdown must not produce an uncaught error line.
    assert.doesNotMatch(
      stdout + stderr,
      /\[fatal\]|\[error\] unhandled rejection/,
      "no fatal errors on clean SIGTERM",
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

test("poller is stopped (running=false) by the time SIGTERM shutdown completes", async () => {
  // In-process: verify that poller.stop() flips running=false and the status
  // reflects the stopped state that the shutdown function reads.
  const { createPoller } = await import("../dist/poller.js");

  const tip = 5000;
  const server = {
    async getHealth() {
      return { status: "healthy", oldestLedger: 4000, latestLedger: tip };
    },
    async getEvents(_req) {
      return { events: [], cursor: `${BigInt(tip) << 32n}-0`, latestLedger: tip };
    },
  };

  const config = {
    botToken: "fake-token",
    chatId: "-1001234567890",
    marketContractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    squadContractId:  "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    pollIntervalMs: 9_999_999,
    startLookbackLedgers: 60,
    cursorFile: `/tmp/sigterm-test-${Date.now()}.json`,
    maxNotificationsPerCycle: 20,
  };

  const poller = createPoller({ config, server, send: async () => {} });
  await poller.start();

  assert.equal(poller.status().running, true, "poller must be running before shutdown");

  // Simulate what shutdown() does:
  poller.stop();

  assert.equal(poller.status().running, false, "poller must be stopped after shutdown");
});
