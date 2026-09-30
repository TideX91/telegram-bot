import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildHealthReport } from "../dist/health.js";
import { formatSuppressedRepeats, LogSampler } from "../dist/log-sampler.js";
import { createPoller } from "../dist/poller.js";

/** Deterministic clock so sampling windows are exercised without sleeping. */
function clock(start = 0) {
  let value = start;
  return {
    now: () => value,
    advance: (ms) => {
      value += ms;
    },
  };
}

test("a key logs its first N occurrences and suppresses the rest", () => {
  const time = clock();
  const sampler = new LogSampler({ maxPerWindow: 3, windowMs: 1_000, now: time.now });

  const decisions = [1, 2, 3, 4, 5].map(() => sampler.record("scan:market").log);

  assert.deepEqual(decisions, [true, true, true, false, false]);
  assert.equal(sampler.pending("scan:market"), 2);
  assert.equal(sampler.suppressedTotal(), 2);
});

test("boundary: exactly maxPerWindow logs and the next repeat is the first suppressed", () => {
  const time = clock();
  const sampler = new LogSampler({ maxPerWindow: 2, windowMs: 1_000, now: time.now });

  assert.deepEqual(sampler.record("k"), { log: true, suppressed: 0 });
  assert.deepEqual(sampler.record("k"), { log: true, suppressed: 0 });
  assert.deepEqual(sampler.record("k"), { log: false, suppressed: 0 });
  assert.equal(sampler.pending("k"), 1);
  assert.equal(sampler.suppressedTotal(), 1);
});

test("a window roll reports the suppressed repeats once, then resets", () => {
  const time = clock();
  const sampler = new LogSampler({ maxPerWindow: 1, windowMs: 1_000, now: time.now });

  assert.deepEqual(sampler.record("scan:squad"), { log: true, suppressed: 0 });
  for (let i = 0; i < 4; i += 1) assert.equal(sampler.record("scan:squad").log, false);
  assert.equal(sampler.pending("scan:squad"), 4);

  time.advance(1_000);
  // The line that opens the new window is the one that accounts for the old.
  assert.deepEqual(sampler.record("scan:squad"), { log: true, suppressed: 4 });
  assert.equal(sampler.pending("scan:squad"), 0);

  // The fresh window allows its own first line before suppressing again.
  assert.equal(sampler.record("scan:squad").log, false);
  assert.equal(sampler.suppressedTotal(), 5);
});

test("formatSuppressedRepeats renders nothing, once, or a plural count", () => {
  assert.equal(formatSuppressedRepeats(0, 300_000), "");
  assert.equal(
    formatSuppressedRepeats(1, 300_000),
    " (suppressed 1 identical repeat in the previous 300s)",
  );
  assert.equal(
    formatSuppressedRepeats(42, 30_000),
    " (suppressed 42 identical repeats in the previous 30s)",
  );
  // A sub-second window is still reported in whole seconds, never as "0s".
  assert.equal(
    formatSuppressedRepeats(2, 500),
    " (suppressed 2 identical repeats in the previous 1s)",
  );
});

test("distinct keys are sampled independently", () => {
  const time = clock();
  const sampler = new LogSampler({ maxPerWindow: 1, windowMs: 1_000, now: time.now });

  assert.equal(sampler.record("scan:market").log, true);
  assert.equal(sampler.record("scan:market").log, false);
  // A noisy key must not silence a different one.
  assert.equal(sampler.record("scan:squad").log, true);
  assert.equal(sampler.record("cycle").log, true);
  assert.equal(sampler.size(), 3);
});

test("maxPerWindow and windowMs are clamped to at least 1", () => {
  const time = clock();
  const sampler = new LogSampler({ maxPerWindow: 0, windowMs: 0, now: time.now });

  assert.equal(sampler.maxPerWindow, 1);
  assert.equal(sampler.windowMs, 1);
  assert.equal(sampler.record("k").log, true);
  assert.equal(sampler.record("k").log, false);
});

test("defaults apply, and a restart starts with empty sampling state", () => {
  const time = clock();
  const first = new LogSampler({ now: time.now });

  assert.equal(first.maxPerWindow, 3);
  assert.equal(first.windowMs, 300_000);
  assert.equal(first.record("scan:market").log, true);
  assert.equal(first.record("scan:market").log, true);
  assert.equal(first.record("scan:market").log, true);
  assert.equal(first.record("scan:market").log, false);
  assert.equal(first.suppressedTotal(), 1);

  // Sampling is in-memory only: a restart must not inherit suppression state.
  const restarted = new LogSampler({ now: time.now });
  assert.equal(restarted.record("scan:market").log, true);
  assert.equal(restarted.suppressedTotal(), 0);
  assert.equal(restarted.pending("scan:market"), 0);
});

function baseConfig(overrides = {}) {
  return {
    marketContractId: "C" + "A".repeat(55),
    squadContractId: "C" + "B".repeat(55),
    rpcUrl: "https://example.invalid/rpc",
    horizonUrl: "https://example.invalid/horizon",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://example.invalid/explorer",
    botToken: "123456789:TEST-ONLY-TOKEN-NEVER-USE",
    chatId: "-1001234567890",
    operatorTelegramUserId: "42",
    pollIntervalMs: 1,
    startLookbackLedgers: 60,
    cursorFile: "/tmp/unused-mimir-log-sample-cursor.json",
    maxNotificationsPerCycle: 20,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
    logSampleMaxPerWindow: 2,
    logSampleWindowMs: 60_000,
    ...overrides,
  };
}

/** Every health call rejects, so one cycle fails both contracts. */
function failingServer() {
  return {
    getHealth: async () => {
      throw new Error("rpc unavailable");
    },
  };
}

async function waitForCycles(poller, target) {
  for (let attempt = 0; attempt < 4_000; attempt += 1) {
    if (poller.status().cycles >= target) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`poller only reached ${poller.status().cycles} cycles`);
}

test("poller samples repetitive RPC scan failures instead of logging every cycle", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mimir-log-sample-"));
  const poller = createPoller({
    config: baseConfig({ cursorFile: path.join(directory, "cursor.json") }),
    server: failingServer(),
    send: async () => undefined,
  });
  const originalError = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args.join(" "));

  try {
    await poller.start();
    await waitForCycles(poller, 8);

    const status = poller.status();
    assert.ok(status.cycles >= 8);
    const marketLines = logs.filter((line) => line.includes("[poller] market scan failed"));
    const squadLines = logs.filter((line) => line.includes("[poller] squad scan failed"));
    assert.equal(marketLines.length, 2, "only maxPerWindow lines per key");
    assert.equal(squadLines.length, 2);
    // The repeats are counted, not lost, and the error text is still visible.
    assert.equal(status.suppressedLogs, status.cycles * 2 - 4);
    assert.ok(status.suppressedLogs >= 1);
    assert.equal(logs.some((line) => line.includes("rpc unavailable")), true);
    assert.equal(logs.some((line) => line.includes("scan failed")), true);
  } finally {
    console.error = originalError;
    poller.stop();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

test("maxPerWindow=1 keeps a single line per failing key", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mimir-log-keys-"));
  const poller = createPoller({
    config: baseConfig({
      cursorFile: path.join(directory, "cursor.json"),
      logSampleMaxPerWindow: 1,
    }),
    server: failingServer(),
    send: async () => undefined,
  });
  const originalError = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args.join(" "));

  try {
    await poller.start();
    await waitForCycles(poller, 4);

    const status = poller.status();
    const marketLines = logs.filter((line) => line.includes("market scan failed"));
    const squadLines = logs.filter((line) => line.includes("squad scan failed"));
    assert.equal(marketLines.length, 1, "maxPerWindow=1 keeps a single line");
    assert.equal(squadLines.length, 1);
    // Two keys, so suppression is counted per target rather than merged.
    assert.equal(status.suppressedLogs, status.cycles * 2 - 2);
  } finally {
    console.error = originalError;
    poller.stop();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

test("health report exposes the suppressed log counter and tolerates its absence", () => {
  const status = {
    running: true,
    paused: false,
    startedAt: 1_000,
    cycles: 4,
    lastPollAt: 5_000,
    lastSuccessAt: 5_000,
    latestLedger: 42,
    oldestLedger: 1,
    notificationsSent: 0,
    notificationsFailed: 0,
    eventsSkipped: 0,
    consecutiveFailures: 0,
    lastError: null,
    suppressedLogs: 7,
    targets: [],
  };

  assert.equal(buildHealthReport(baseConfig(), status, 5_500).poller.suppressedLogs, 7);
  // Older status snapshots (and tests) without the field must still report 0.
  assert.equal(
    buildHealthReport(baseConfig(), { ...status, suppressedLogs: undefined }, 5_500).poller
      .suppressedLogs,
    0,
  );
});
