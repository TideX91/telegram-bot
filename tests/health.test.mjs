import assert from "node:assert/strict";
import test from "node:test";

import { buildHealthReport, startHealthServer } from "../dist/health.js";

function baseConfig(overrides = {}) {
  return {
    marketContractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    squadContractId: "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    botToken: "0000000000:SECRET-TOKEN-DO-NOT-LEAK",
    chatId: "-1001234567890",
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    cursorFile: "./data/cursor.json",
    maxNotificationsPerCycle: 20,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
    ...overrides,
  };
}

function baseStatus(overrides = {}) {
  return {
    running: true,
    startedAt: 1_000,
    cycles: 4,
    lastPollAt: 5_000,
    lastSuccessAt: 5_000,
    latestLedger: 42,
    oldestLedger: 1,
    notificationsSent: 2,
    notificationsFailed: 0,
    eventsSkipped: 1,
    consecutiveFailures: 0,
    lastError: null,
    restartGaps: 0,
    lastRestartGap: null,
    targets: [
      {
        source: "market",
        contractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
        cursor: "0018276211125911551-4294967295",
        lastEventLedger: 40,
        gapLedgers: 0,
        cursorResetAt: null,
        cursorUnreadable: false,
        lastError: null,
      },
    ],
    ...overrides,
  };
}

test("buildHealthReport is ok for a fresh running poller", () => {
  const report = buildHealthReport(baseConfig(), baseStatus(), 5_500);
  assert.equal(report.ok, true);
  assert.equal(report.status, "ok");
  assert.equal(report.service, "mimir-telegram-bot");
  assert.equal(report.network, "testnet");
  assert.equal(report.uptimeMs, 4_500);
  assert.equal(report.poller.targets[0].cursorPreview.endsWith("…"), true);
});

test("buildHealthReport is stopped when the poller is not running", () => {
  const report = buildHealthReport(baseConfig(), baseStatus({ running: false }), 5_500);
  assert.equal(report.ok, false);
  assert.equal(report.status, "stopped");
});

test("buildHealthReport is degraded after repeated failures", () => {
  const report = buildHealthReport(
    baseConfig(),
    baseStatus({ consecutiveFailures: 10, lastSuccessAt: 5_000 }),
    5_500,
  );
  assert.equal(report.ok, false);
  assert.equal(report.status, "degraded");
});

test("buildHealthReport is degraded when success is stale", () => {
  const report = buildHealthReport(
    baseConfig({ healthStaleMs: 1_000 }),
    baseStatus({ lastSuccessAt: 1_000 }),
    5_000,
  );
  assert.equal(report.ok, false);
  assert.equal(report.status, "degraded");
});

test("buildHealthReport never embeds bot token or chat id", () => {
  const config = baseConfig();
  const report = buildHealthReport(config, baseStatus(), 5_500);
  const blob = JSON.stringify(report);
  assert.equal(blob.includes(config.botToken), false);
  assert.equal(blob.includes(config.chatId), false);
  assert.equal(blob.includes("SECRET-TOKEN"), false);
});

test("buildHealthReport surfaces a restart gap as ledger numbers, not secrets", () => {
  const report = buildHealthReport(
    baseConfig(),
    baseStatus({
      restartGaps: 1,
      lastRestartGap: {
        at: 5_000,
        source: "market",
        cursorLedger: 4_250_000,
        oldestLedger: 4_300_000,
        missedLedgers: 50_000,
      },
      targets: [{ ...baseStatus().targets[0], gapLedgers: 50_000, cursorResetAt: 5_000 }],
    }),
    5_500,
  );

  assert.equal(report.ok, true);
  assert.equal(report.poller.restartGaps, 1);
  assert.deepEqual(report.poller.lastRestartGap, {
    at: "1970-01-01T00:00:05.000Z",
    source: "market",
    cursorLedger: 4_250_000,
    oldestLedger: 4_300_000,
    missedLedgers: 50_000,
  });
  assert.equal(report.poller.targets[0].gapLedgers, 50_000);
  assert.equal(report.poller.targets[0].cursorResetAt, "1970-01-01T00:00:05.000Z");
  assert.equal(report.poller.targets[0].cursorUnreadable, false);
});

test("buildHealthReport flags an unreadable cursor position without a gap", () => {
  const report = buildHealthReport(
    baseConfig(),
    baseStatus({
      targets: [
        { ...baseStatus().targets[0], cursor: "legacy-opaque-cursor", cursorUnreadable: true },
      ],
    }),
    5_500,
  );

  assert.equal(report.poller.targets[0].cursorUnreadable, true);
  assert.equal(report.poller.targets[0].gapLedgers, 0);
  assert.equal(report.poller.restartGaps, 0);
  assert.equal(report.poller.lastRestartGap, null);
});

test("startHealthServer with HEALTH_PORT=0 does not bind", async () => {
  const server = startHealthServer({
    config: baseConfig({ healthPort: 0 }),
    status: () => baseStatus(),
  });
  assert.equal(server.url, null);
  assert.equal(server.port, 0);
  await server.close();
});

test("GET /health returns 200 and redacted JSON for a healthy poller", async () => {
  const config = baseConfig({ healthPort: 0 });
  // Port 0 on listen means ephemeral — override after constructing deps.
  config.healthPort = 0;
  // Use ephemeral port via listen(0) by setting a non-zero request... we pass
  // healthPort: 0 to disable. Instead bind ephemeral explicitly:
  const listenConfig = baseConfig({ healthPort: 0 });
  // Force ephemeral: Node treats listen(0) as ephemeral. Our disable switch is
  // also 0, so we start with a high explicit port of 0 via a wrapper: use port
  // assignment by setting healthPort to an OS-picked value through listen —
  // startHealthServer uses config.healthPort===0 as disable, so pick port 0
  // disable path already tested. Use an ephemeral free port:
  const ephemeral = baseConfig({ healthPort: 18787 });
  const secret = ephemeral.botToken;
  const chat = ephemeral.chatId;
  let current = baseStatus();
  const server = startHealthServer({
    config: ephemeral,
    status: () => current,
    now: () => 5_500,
  });
  assert.ok(server.url);

  try {
    const res = await fetch(`${server.url}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.status, "ok");
    const text = JSON.stringify(body);
    assert.equal(text.includes(secret), false);
    assert.equal(text.includes(chat), false);

    const live = await fetch(`${server.url}/health/live`);
    assert.equal(live.status, 200);
    assert.equal((await live.json()).status, "live");

    current = baseStatus({ running: false });
    const stopped = await fetch(`${server.url}/health`);
    assert.equal(stopped.status, 503);
    assert.equal((await stopped.json()).status, "stopped");

    const missing = await fetch(`${server.url}/nope`);
    assert.equal(missing.status, 404);
  } finally {
    await server.close();
  }
});

test("GET /health boundary: first boot before any success stays ok", () => {
  // No successful poll yet — do not mark degraded solely for a null lastSuccessAt.
  const report = buildHealthReport(
    baseConfig({ healthStaleMs: 1_000 }),
    baseStatus({ lastSuccessAt: null, lastPollAt: null, cycles: 0 }),
    5_000,
  );
  assert.equal(report.ok, true);
  assert.equal(report.status, "ok");
});
