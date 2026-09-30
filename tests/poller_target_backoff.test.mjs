import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import tmp from "node:os";
import path from "node:path";
import { createPoller } from "../dist/poller.js";

const MARKET_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const SQUAD_ID  = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBF4";

function mockConfig(cursorFile) {
  return {
    botToken: "test-token",
    chatId: "-1001234567890",
    marketContractId: MARKET_ID,
    squadContractId: SQUAD_ID,
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    cursorFile,
    pollIntervalMs: 100000, // manual cycles or controlled clock
    startLookbackLedgers: 60,
    maxNotificationsPerCycle: 10,
  };
}

function makeCursor(ledger) {
  return `${BigInt(ledger) << 32n}-0`;
}

test("per-target RPC backoff: failing market target enters backoff while squad target continues polling", async () => {
  const dir = await mkdtemp(path.join(tmp.tmpdir(), "target-backoff-1-"));
  const cursorFile = path.join(dir, "cursor.json");
  const config = mockConfig(cursorFile);

  let marketScanCalls = 0;
  let squadScanCalls = 0;

  let currentTime = 1_000_000;
  const now = () => currentTime;

  const server = {
    getHealth: async () => ({ oldestLedger: 1000, latestLedger: 2000 }),
    getEvents: async (req) => {
      const contractId = req.filters?.[0]?.contractIds?.[0];
      if (contractId === MARKET_ID) {
        marketScanCalls++;
        throw new Error("Market RPC down");
      }
      if (contractId === SQUAD_ID) {
        squadScanCalls++;
        return { events: [], latestLedger: 2000, cursor: makeCursor(2000) };
      }
      return { events: [], latestLedger: 2000, cursor: makeCursor(2000) };
    },
  };

  const poller = createPoller({
    config,
    server,
    send: async () => {},
    now,
    targetBackoffOptions: { initialBackoffMs: 5000, maxBackoffMs: 20000, backoffFactor: 2 },
    circuitBreakerOptions: { failureThreshold: 100 }, // prevent global breaker from interfering
  });

  await poller.start();
  // Allow initial load to run
  await new Promise((r) => setTimeout(r, 20));

  const status1 = poller.status();
  const market1 = status1.targets.find((t) => t.source === "market");
  const squad1 = status1.targets.find((t) => t.source === "squad");

  assert.equal(marketScanCalls, 1, "market was attempted once");
  assert.equal(squadScanCalls, 1, "squad was attempted once");
  assert.equal(market1.consecutiveFailures, 1, "market failure count is 1");
  assert.equal(market1.nextEligibleAt, 1_000_000 + 5000, "market next eligible at now + 5000");
  assert.equal(squad1.consecutiveFailures, 0, "squad failure count is 0");
  assert.equal(squad1.nextEligibleAt, null, "squad has no backoff");

  // Advance clock by 1000ms (1_001_000) - market is in backoff window (< 1_005_000)
  currentTime = 1_001_000;

  // Trigger cycle by calling resume / cycle logic indirectly (e.g. pause + resume)
  poller.pause();
  poller.resume();
  await new Promise((r) => setTimeout(r, 20));

  const status2 = poller.status();
  const market2 = status2.targets.find((t) => t.source === "market");
  const squad2 = status2.targets.find((t) => t.source === "squad");

  assert.equal(marketScanCalls, 1, "market scan was SKIPPED because it is in backoff window");
  assert.equal(squadScanCalls, 2, "squad scan was attempted again");
  assert.equal(market2.consecutiveFailures, 1, "market failure count remains 1");
  assert.equal(squad2.cursor, makeCursor(2000), "squad cursor advanced");

  poller.stop();
  await rm(dir, { recursive: true, force: true });
});

test("per-target RPC backoff: repeated failures exponentially increase delay up to maxBackoff", async () => {
  const dir = await mkdtemp(path.join(tmp.tmpdir(), "target-backoff-2-"));
  const cursorFile = path.join(dir, "cursor.json");
  const config = mockConfig(cursorFile);

  let currentTime = 1_000_000;
  const now = () => currentTime;

  const server = {
    getHealth: async () => ({ oldestLedger: 1000, latestLedger: 2000 }),
    getEvents: async (req) => {
      const contractId = req.filters?.[0]?.contractIds?.[0];
      if (contractId === MARKET_ID) {
        throw new Error("Market RPC timeout");
      }
      return { events: [], latestLedger: 2000, cursor: makeCursor(2000) };
    },
  };

  const poller = createPoller({
    config,
    server,
    send: async () => {},
    now,
    targetBackoffOptions: { initialBackoffMs: 1000, maxBackoffMs: 5000, backoffFactor: 2 },
    circuitBreakerOptions: { failureThreshold: 100 },
  });

  await poller.start();
  await new Promise((r) => setTimeout(r, 20));

  // Failure 1 at t = 1_000_000 -> delay = min(1000 * 2^0, 5000) = 1000 -> nextEligibleAt = 1_001_000
  let m = poller.status().targets.find((t) => t.source === "market");
  assert.equal(m.consecutiveFailures, 1);
  assert.equal(m.nextEligibleAt, 1_001_000);

  // Advance time past 1_001_000 to t = 1_001_005
  currentTime = 1_001_005;
  poller.pause();
  poller.resume();
  await new Promise((r) => setTimeout(r, 20));

  // Failure 2 at t = 1_001_005 -> delay = min(1000 * 2^1, 5000) = 2000 -> nextEligibleAt = 1_003_005
  m = poller.status().targets.find((t) => t.source === "market");
  assert.equal(m.consecutiveFailures, 2);
  assert.equal(m.nextEligibleAt, 1_003_005);

  // Advance time past 1_003_005 to t = 1_003_010
  currentTime = 1_003_010;
  poller.pause();
  poller.resume();
  await new Promise((r) => setTimeout(r, 20));

  // Failure 3 at t = 1_003_010 -> delay = min(1000 * 2^2, 5000) = 4000 -> nextEligibleAt = 1_007_010
  m = poller.status().targets.find((t) => t.source === "market");
  assert.equal(m.consecutiveFailures, 3);
  assert.equal(m.nextEligibleAt, 1_007_010);

  // Advance time past 1_007_010 to t = 1_007_015
  currentTime = 1_007_015;
  poller.pause();
  poller.resume();
  await new Promise((r) => setTimeout(r, 20));

  // Failure 4 at t = 1_007_015 -> delay = min(1000 * 2^3, 5000) = capped at 5000 -> nextEligibleAt = 1_012_015
  m = poller.status().targets.find((t) => t.source === "market");
  assert.equal(m.consecutiveFailures, 4);
  assert.equal(m.nextEligibleAt, 1_012_015);

  poller.stop();
  await rm(dir, { recursive: true, force: true });
});

test("per-target RPC backoff: successful RPC scan resets backoff state for that target", async () => {
  const dir = await mkdtemp(path.join(tmp.tmpdir(), "target-backoff-3-"));
  const cursorFile = path.join(dir, "cursor.json");
  const config = mockConfig(cursorFile);

  let currentTime = 1_000_000;
  let marketFail = true;

  const server = {
    getHealth: async () => ({ oldestLedger: 1000, latestLedger: 2000 }),
    getEvents: async (req) => {
      const contractId = req.filters?.[0]?.contractIds?.[0];
      if (contractId === MARKET_ID && marketFail) {
        throw new Error("Market RPC down");
      }
      return { events: [], latestLedger: 2000, cursor: makeCursor(2000) };
    },
  };

  const poller = createPoller({
    config,
    server,
    send: async () => {},
    now: () => currentTime,
    targetBackoffOptions: { initialBackoffMs: 5000, maxBackoffMs: 20000, backoffFactor: 2 },
    circuitBreakerOptions: { failureThreshold: 100 },
  });

  await poller.start();
  await new Promise((r) => setTimeout(r, 20));

  let m = poller.status().targets.find((t) => t.source === "market");
  assert.equal(m.consecutiveFailures, 1);
  assert.equal(m.nextEligibleAt, 1_005_000);

  // Recovery: market RPC recovers and clock advances past backoff window
  marketFail = false;
  currentTime = 1_006_000;

  poller.pause();
  poller.resume();
  await new Promise((r) => setTimeout(r, 20));

  m = poller.status().targets.find((t) => t.source === "market");
  assert.equal(m.consecutiveFailures, 0, "consecutive failures reset to 0 on success");
  assert.equal(m.nextEligibleAt, null, "nextEligibleAt reset to null on success");
  assert.equal(m.lastError, null, "lastError cleared on success");

  poller.stop();
  await rm(dir, { recursive: true, force: true });
});

test("per-target RPC backoff: restart initializes fresh runtime backoff state while restoring persisted cursor", async () => {
  const dir = await mkdtemp(path.join(tmp.tmpdir(), "target-backoff-4-"));
  const cursorFile = path.join(dir, "cursor.json");
  const config = mockConfig(cursorFile);

  let currentTime = 1_000_000;

  const server = {
    getHealth: async () => ({ oldestLedger: 1000, latestLedger: 2000 }),
    getEvents: async (req) => {
      const contractId = req.filters?.[0]?.contractIds?.[0];
      if (contractId === MARKET_ID) {
        throw new Error("Market RPC error");
      }
      return { events: [], latestLedger: 2000, cursor: makeCursor(1500) };
    },
  };

  const poller1 = createPoller({
    config,
    server,
    send: async () => {},
    now: () => currentTime,
    targetBackoffOptions: { initialBackoffMs: 10000, maxBackoffMs: 60000 },
    circuitBreakerOptions: { failureThreshold: 100 },
  });

  await poller1.start();
  await new Promise((r) => setTimeout(r, 20));

  const status1 = poller1.status();
  const market1 = status1.targets.find((t) => t.source === "market");
  const squad1 = status1.targets.find((t) => t.source === "squad");

  assert.equal(market1.consecutiveFailures, 1);
  assert.equal(market1.nextEligibleAt, 1_010_000);
  assert.equal(squad1.cursor, makeCursor(1500));

  poller1.stop();

  // Restart poller with new instance
  const poller2 = createPoller({
    config,
    server,
    send: async () => {},
    now: () => currentTime,
    targetBackoffOptions: { initialBackoffMs: 10000, maxBackoffMs: 60000 },
    circuitBreakerOptions: { failureThreshold: 100 },
  });

  const statusBeforeStart = poller2.status();
  const market2Before = statusBeforeStart.targets.find((t) => t.source === "market");
  assert.equal(market2Before.consecutiveFailures, 0, "runtime backoff state starts fresh on new instance");
  assert.equal(market2Before.nextEligibleAt, null, "nextEligibleAt starts null on new instance");

  await poller2.start();
  await new Promise((r) => setTimeout(r, 20));

  const status2After = poller2.status();
  const squad2After = status2After.targets.find((t) => t.source === "squad");
  assert.equal(squad2After.cursor, makeCursor(1500), "persisted cursor was safely restored across restart");

  poller2.stop();
  await rm(dir, { recursive: true, force: true });
});
