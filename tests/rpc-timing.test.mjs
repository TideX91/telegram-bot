/**
 * Tests for src/stellar/metrics.ts and the RPC timing wired through
 * src/stellar/events.ts.
 *
 * Invariants:
 *   1. RpcTiming aggregates counts/durations per operation, exactly, with an
 *      injected clock (no real waiting).
 *   2. A failed RPC await is counted as a failure and is still rethrown.
 *   3. paginatedGetEvents reports one health request + one per events page.
 *   4. The scan JSON carries the timing and never leaks a secret.
 *   5. formatRpcTiming is a bounded, single-line, secret-free summary.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { formatRpcTiming, RpcTiming } from "../dist/stellar/metrics.js";
import {
  buildScanJsonReport,
  buildScanJsonTarget,
  formatScanJson,
  paginatedGetEvents,
} from "../dist/stellar/events.js";

// ── Recorder ──────────────────────────────────────────────────────────────────

test("RpcTiming aggregates requests, failures, and durations per operation", async () => {
  let now = 0;
  const timing = new RpcTiming(() => now);

  await timing.measure("health", async () => {
    now += 2;
    return "ok";
  });
  await timing.measure("events", async () => {
    now += 5;
    return 1;
  });
  await assert.rejects(
    timing.measure("events", async () => {
      now += 15;
      throw new Error("rpc down");
    }),
    /rpc down/,
  );

  const summary = timing.summary();
  assert.equal(summary.requests, 3);
  assert.equal(summary.failures, 1);
  assert.equal(summary.totalMs, 22);
  assert.equal(summary.minMs, 2);
  assert.equal(summary.maxMs, 15);
  assert.equal(summary.avgMs, Math.round((22 / 3) * 1000) / 1000);
  assert.equal(summary.operations.health.requests, 1);
  assert.equal(summary.operations.health.failures, 0);
  assert.equal(summary.operations.health.totalMs, 2);
  assert.equal(summary.operations.events.requests, 2);
  assert.equal(summary.operations.events.failures, 1);
  assert.equal(summary.operations.events.minMs, 5);
  assert.equal(summary.operations.events.maxMs, 15);
});

test("RpcTiming ignores non-finite/negative durations instead of poisoning the summary", () => {
  const timing = new RpcTiming(() => 0);
  timing.record("events", Number.NaN, true);
  timing.record("events", -100, false);

  const summary = timing.summary();
  assert.equal(summary.requests, 2);
  assert.equal(summary.failures, 1);
  assert.equal(summary.totalMs, 0);
  assert.equal(summary.maxMs, 0);
});

test("an empty recorder reports zeroes, not NaN", () => {
  const summary = new RpcTiming(() => 0).summary();
  assert.equal(summary.requests, 0);
  assert.equal(summary.avgMs, 0);
  assert.equal(summary.operations.health.requests, 0);
  assert.equal(summary.operations.events.requests, 0);
});

// ── Wired through the event walk ──────────────────────────────────────────────

function makeServer(health, pages) {
  const queue = [...pages];
  let callIndex = 0;
  return {
    async getHealth() {
      return health;
    },
    async getEvents() {
      const page = queue[callIndex] ?? queue[queue.length - 1];
      callIndex += 1;
      return {
        events: page.events ?? [],
        cursor: page.cursor ?? "",
        latestLedger: page.latestLedger ?? health.latestLedger,
      };
    },
  };
}

test("paginatedGetEvents records one health probe plus one events request per page", async () => {
  const server = makeServer(
    { oldestLedger: 1, latestLedger: 100 },
    [{ events: [], cursor: "", latestLedger: 100 }],
  );

  const scan = await paginatedGetEvents(
    server,
    [{ type: "contract", contractIds: ["CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI"] }],
    { startLedger: 1 },
  );

  assert.equal(scan.timing.operations.health.requests, 1);
  assert.equal(scan.timing.operations.events.requests, 1);
  assert.equal(scan.timing.requests, 2);
  assert.equal(scan.timing.failures, 0);
  assert.ok(scan.timing.totalMs >= 0);
});

test("paginatedGetEvents records every page of a multi-page walk", async () => {
  const cursor = (ledger) => `${(BigInt(ledger) << 32n) | 1n}-0`;
  const server = makeServer(
    { oldestLedger: 1, latestLedger: 300 },
    [
      { events: [], cursor: cursor(200), latestLedger: 300 },
      { events: [], cursor: cursor(300), latestLedger: 300 },
    ],
  );

  const scan = await paginatedGetEvents(
    server,
    [{ type: "contract", contractIds: ["CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI"] }],
    { startLedger: 100 },
  );

  assert.equal(scan.pages, 2);
  assert.equal(scan.timing.operations.events.requests, 2);
  assert.equal(scan.timing.operations.health.requests, 1);
  assert.equal(scan.timing.requests, 3);
});

test("paginatedGetEvents propagates a health failure (and does not swallow it)", async () => {
  const failing = {
    async getHealth() {
      throw new Error("rpc unreachable");
    },
    async getEvents() {
      throw new Error("must not be reached");
    },
  };
  await assert.rejects(
    paginatedGetEvents(failing, [{ type: "contract", contractIds: ["C"] }], { startLedger: 1 }),
    /rpc unreachable/,
  );
});

// ── Output surfaces ───────────────────────────────────────────────────────────

test("scan JSON carries per-target rpcTiming without leaking secrets", () => {
  const timing = new RpcTiming(() => 0);
  timing.record("health", 3, true);
  timing.record("events", 7, true);

  const scan = {
    source: "market",
    contractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    events: [],
    cursor: null,
    latestLedger: 50,
    oldestLedger: 1,
    truncated: false,
    pages: 1,
    duplicates: 0,
    startLedger: 1,
    startClamped: false,
    lastEventLedger: null,
    timing: timing.summary(),
  };

  const target = buildScanJsonTarget(scan, 0);
  assert.equal(target.rpcTiming.requests, 2);
  assert.equal(target.rpcTiming.operations.events.totalMs, 7);

  const text = formatScanJson(
    buildScanJsonReport({
      network: "testnet",
      rpcUrl: "https://soroban.example.invalid",
      oldestLedger: 1,
      latestLedger: 50,
      rpcTiming: timing.summary(),
      targets: [target],
    }),
  );

  const parsed = JSON.parse(text);
  assert.equal(parsed.rpcTiming.requests, 2);
  assert.equal(parsed.targets[0].rpcTiming.operations.health.totalMs, 3);
  assert.doesNotMatch(text, /BOT_TOKEN|ghp_|private.?key/i);
});

test("formatRpcTiming is a bounded, single-line, secret-free summary", () => {
  const timing = new RpcTiming(() => 0);
  timing.record("health", 1, true);
  timing.record("events", 4, true);
  timing.record("events", 4, false);

  const line = formatRpcTiming(timing.summary());
  assert.match(line, /^rpc requests=3 failures=1 total=9ms /);
  assert.match(line, /health=1 events=2$/);
  assert.equal(line.includes("\n"), false);
  assert.doesNotMatch(line, /BOT_TOKEN|ghp_|private.?key|token/i);
});
