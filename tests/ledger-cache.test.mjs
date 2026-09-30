/**
 * Tests for src/stellar/ledger-cache.ts and the poller's use of it.
 *
 * The chain tip (`getHealth()`) is a per-cycle fact. These tests pin down that
 * it is fetched once and reused, that a failed fetch is never cached, and that
 * the two watched contracts no longer each pay for their own health read.
 *
 * Covered:
 *   - one getHealth() per TTL window, reused across callers
 *   - reset() forces a refetch (one fetch per poll cycle)
 *   - concurrent callers share a single in-flight request
 *   - a failed fetch is not cached and the next caller retries
 *   - TTL expiry against the injected clock
 *   - the poller fetches the tip exactly once for two targets in one cycle
 */

import assert from "node:assert/strict";
import test from "node:test";

import { LedgerCache, DEFAULT_LEDGER_TTL_MS } from "../dist/stellar/ledger-cache.js";
import { createPoller } from "../dist/poller.js";
import { createTempDataDir } from "./helpers/temp-data.mjs";

const HEALTH = { status: "healthy", oldestLedger: 4_000, latestLedger: 5_000 };
const MARKET_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const SQUAD_ID = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBF4";

/** Fake rpc.Server that counts health/event reads and can fail the first N. */
function countingServer({ health = HEALTH, delayMs = 0, failHealthTimes = 0 } = {}) {
  const counters = { healthCalls: 0, getEventsCalls: 0 };
  let failures = failHealthTimes;
  counters.server = {
    async getHealth() {
      counters.healthCalls += 1;
      if (failures > 0) {
        failures -= 1;
        throw new Error("getHealth down");
      }
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return health;
    },
    async getEvents() {
      counters.getEventsCalls += 1;
      return { events: [], cursor: "5000-0", latestLedger: 5_000 };
    },
  };
  return counters;
}

const TIP = { oldestLedger: 4_000, latestLedger: 5_000 };

test("ledger cache: one getHealth per ttl window, reused across callers", async () => {
  const cache = new LedgerCache({ ttlMs: 1_000 });
  const counters = countingServer();
  const { server } = counters;

  const first = await cache.get(server);
  const second = await cache.get(server);

  assert.deepEqual(first, TIP);
  assert.deepEqual(second, TIP);
  assert.equal(counters.healthCalls, 1, "second read must come from the cache");
  assert.deepEqual(cache.stats(), { hits: 1, misses: 1 });
});

test("ledger cache: reset forces a refetch (one fetch per poll cycle)", async () => {
  const cache = new LedgerCache({ ttlMs: 1_000 });
  const counters = countingServer();
  const { server } = counters;

  await cache.get(server);
  cache.reset();
  assert.equal(cache.peek(), null, "reset must drop the cached tip");
  await cache.get(server);

  assert.equal(counters.healthCalls, 2);
  assert.deepEqual(cache.stats(), { hits: 0, misses: 2 });
});

test("ledger cache: concurrent callers share one in-flight request", async () => {
  const cache = new LedgerCache({ ttlMs: 1_000 });
  const counters = countingServer({ delayMs: 20 });
  const { server } = counters;

  const results = await Promise.all([cache.get(server), cache.get(server), cache.get(server)]);

  assert.equal(counters.healthCalls, 1, "a burst must coalesce onto one getHealth");
  assert.deepEqual(cache.stats(), { hits: 2, misses: 1 });
  for (const result of results) assert.deepEqual(result, TIP);
});

test("ledger cache: a failed fetch is not cached and the next caller retries", async () => {
  const cache = new LedgerCache({ ttlMs: 1_000 });
  const counters = countingServer({ failHealthTimes: 1 });
  const { server } = counters;

  await assert.rejects(() => cache.get(server), /getHealth down/);
  assert.equal(cache.peek(), null, "a failure must not populate the cache");

  const tip = await cache.get(server);
  assert.deepEqual(tip, TIP);
  assert.equal(counters.healthCalls, 2, "the retry must reach getHealth again");
});

test("ledger cache: ttl expiry refetches against the injected clock", async () => {
  let now = 0;
  const cache = new LedgerCache({ ttlMs: 1_000, now: () => now });
  const counters = countingServer();
  const { server } = counters;

  await cache.get(server);
  now = 999;
  await cache.get(server);
  assert.equal(counters.healthCalls, 1, "still inside the ttl");

  now = 1_000;
  await cache.get(server);
  assert.equal(counters.healthCalls, 2, "ttl boundary is exclusive");
});

test("ledger cache: the default ttl is positive", () => {
  assert.ok(DEFAULT_LEDGER_TTL_MS > 0);
});

test("poller: two targets share one chain-tip fetch per cycle", async () => {
  const dir = await createTempDataDir("mimir-ledger-cache-");
  const counters = countingServer();
  const { server } = counters;

  const poller = createPoller({
    config: {
      botToken: "fake-token",
      chatId: "-1001234567890",
      marketContractId: MARKET_ID,
      squadContractId: SQUAD_ID,
      rpcUrl: "https://example.invalid/rpc",
      horizonUrl: "https://example.invalid/horizon",
      networkPassphrase: "Test SDF Network ; September 2015",
      pollIntervalMs: 100_000, // large: only the first cycle runs during the test
      startLookbackLedgers: 60,
      cursorFile: dir.file("cursor.json"),
      maxNotificationsPerCycle: 5,
    },
    server,
    send: async () => {},
  });

  try {
    await poller.start();
    const deadline = Date.now() + 2_000;
    while (
      !(poller.status().ledgerCache.misses === 1 && poller.status().ledgerCache.hits === 1) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    poller.stop();

    const status = poller.status();
    assert.ok(status.cycles >= 1, "one cycle ran");
    assert.equal(counters.healthCalls, 1, "two targets, one getHealth call");
    assert.deepEqual(status.ledgerCache, { hits: 1, misses: 1 });
    assert.equal(status.latestLedger, 5_000);
    assert.equal(status.oldestLedger, 4_000);
    for (const target of status.targets) {
      assert.equal(target.lastError, null, `${target.source} scanned without error`);
    }
  } finally {
    poller.stop();
    await dir.cleanup();
  }
});
