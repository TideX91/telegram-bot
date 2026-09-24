/**
 * Poller restart-gap coverage.
 *
 * The RPC keeps only a rolling window of events, so a resume position can end
 * up *older* than the oldest ledger it still serves — a restart (or a run of
 * RPC failures) longer than the window. Those events are gone; the cursor must
 * be detected, reported once, and reset to a cold start rather than retried
 * forever behind a floor that has already moved past it.
 *
 * Everything here is offline: a fake `rpc.Server`, a fake Telegram sender, a
 * temporary cursor file, and an injected clock. No live RPC, no bot token.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { statusMessage } from "../dist/bot.js";
import { classifyCursorWindow, createPoller } from "../dist/poller.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, "fixtures");

const MARKET_ID = "C".padEnd(56, "M");
const SQUAD_ID = "C".padEnd(56, "S");

/** A fixed clock, so gap timestamps are asserted rather than eyeballed. */
const FAKE_NOW = 1_700_000_000_000;

/** A `<TOID>-<index>` cursor, the encoding `getEvents` returns. */
function cursorFor(ledger, index = 0) {
  return `${(BigInt(ledger) << 32n) + BigInt(index)}-${index}`;
}

function baseConfig(overrides = {}) {
  return {
    marketContractId: MARKET_ID,
    squadContractId: SQUAD_ID,
    rpcUrl: "https://example.invalid/rpc",
    horizonUrl: "https://example.invalid/horizon",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer",
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

function cursorFileContents(targets) {
  return `${JSON.stringify(
    { version: 1, updatedAt: "2026-08-21T10:00:00.000Z", targets },
    null,
    2,
  )}\n`;
}

/**
 * Minimal `rpc.Server` stand-in. The poller only reaches for `getHealth` and
 * `getEvents`, both of which record what was asked so a test can assert the
 * request shape. `window` is read per call, so a test can roll the retained
 * floor forward between cycles — which is what a long outage looks like.
 */
function fakeServer({ window, respond }) {
  const calls = [];
  return {
    calls,
    eventsCalls() {
      return calls.filter((c) => c.kind === "events");
    },
    async getHealth() {
      calls.push({ kind: "health" });
      return {
        status: "healthy",
        oldestLedger: window.oldestLedger,
        latestLedger: window.latestLedger,
      };
    },
    async getEvents(request) {
      calls.push({ kind: "events", request });
      return respond(request);
    },
  };
}

/** One page that is already at the tip, so a scan stops after a single request. */
function emptyTailPage(tip) {
  return { events: [], cursor: cursorFor(tip), latestLedger: tip };
}

function contractIdOf(call) {
  return call.request.filters[0].contractIds[0];
}

async function withCursorFile(contents, run) {
  const dir = await mkdtemp(path.join(tmpdir(), "mimir-poller-"));
  const cursorFile = path.join(dir, "cursor.json");
  if (contents !== null) await writeFile(cursorFile, contents, "utf8");
  try {
    return await run(cursorFile);
  } finally {
    // Per docs/contributor-fixtures.md: always clean the temp state up. The
    // retries matter because a cycle that was still in flight when the poller
    // stopped may be mid write-then-rename of `cursor.json.tmp`.
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
}

/** Swallow the poller's operational logging, and hand it back for assertions. */
async function captureConsole(run) {
  const captured = { log: [], warn: [], error: [] };
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...args) => captured.log.push(args.map(String).join(" "));
  console.warn = (...args) => captured.warn.push(args.map(String).join(" "));
  console.error = (...args) => captured.error.push(args.map(String).join(" "));
  try {
    await run();
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
  return captured;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

async function waitFor(predicate, tries = 400) {
  for (let i = 0; i < tries; i += 1) {
    if (predicate()) return;
    await tick();
  }
  throw new Error("timed out waiting for poller state");
}

function storedCursor(cursorFile, source) {
  try {
    return JSON.parse(readFileSync(cursorFile, "utf8")).targets[source].cursor;
  } catch {
    return undefined;
  }
}

// ── boundary: the classification itself ─────────────────────────────────────

test("classifyCursorWindow draws the line at the retained floor", () => {
  const FLOOR = 4_300_000;

  assert.deepEqual(classifyCursorWindow(null, FLOOR), { status: "no-cursor" });
  assert.deepEqual(classifyCursorWindow("", FLOOR), { status: "no-cursor" });

  // No floor yet (a cold boot against an unreachable RPC): nothing to compare.
  assert.deepEqual(classifyCursorWindow(cursorFor(4_250_000), null), {
    status: "unknown-floor",
  });
  assert.deepEqual(classifyCursorWindow(cursorFor(4_250_000), 0), {
    status: "unknown-floor",
  });

  // Opaque/legacy cursor: the ledger is not recoverable from the string alone.
  assert.deepEqual(classifyCursorWindow("not-a-cursor", FLOOR), {
    status: "unreadable",
    cursor: "not-a-cursor",
  });

  // Exactly at the floor is still retained — that is the boundary.
  assert.deepEqual(classifyCursorWindow(cursorFor(4_300_000), FLOOR), {
    status: "inside",
    cursorLedger: 4_300_000,
    behind: 0,
  });
  assert.deepEqual(classifyCursorWindow(cursorFor(4_300_001), FLOOR), {
    status: "inside",
    cursorLedger: 4_300_001,
    behind: 1,
  });
  assert.deepEqual(classifyCursorWindow(cursorFor(4_299_999), FLOOR), {
    status: "stale",
    cursorLedger: 4_299_999,
    missedLedgers: 1,
  });
});

test("stale cursor fixture sits below the sample floor; the valid fixture sits above", async () => {
  const stale = JSON.parse(await readFile(path.join(fixturesDir, "cursor-stale.json"), "utf8"));
  const valid = JSON.parse(await readFile(path.join(fixturesDir, "cursor-valid.json"), "utf8"));

  assert.equal(stale.version, 1);
  const staleVerdict = classifyCursorWindow(stale.targets.market.cursor, 4_300_000);
  assert.equal(staleVerdict.status, "stale");
  assert.equal(staleVerdict.cursorLedger, 4_250_000);
  assert.equal(staleVerdict.missedLedgers, 50_000);

  const insideVerdict = classifyCursorWindow(valid.targets.market.cursor, 4_200_000);
  assert.equal(insideVerdict.status, "inside");
  assert.equal(insideVerdict.cursorLedger, 4_255_261);
});

// ── restart: the gap is detected, reported, and recovered from ──────────────

test("a cursor below the retained floor is reported once and reset to a cold start", async () => {
  const contents = cursorFileContents({
    market: { cursor: cursorFor(4_250_000), lastEventLedger: 4_250_000 },
    squad: { cursor: cursorFor(4_350_000), lastEventLedger: 4_350_000 },
  });

  await withCursorFile(contents, async (cursorFile) => {
    const window = { oldestLedger: 4_300_000, latestLedger: 4_400_000 };
    const server = fakeServer({
      window,
      respond: () => emptyTailPage(window.latestLedger),
    });
    const sent = [];
    const config = baseConfig({ cursorFile, startLookbackLedgers: 60 });
    const poller = createPoller({
      config,
      server,
      send: async (text) => {
        sent.push(text);
      },
      now: () => FAKE_NOW,
    });

    const captured = await captureConsole(async () => {
      await poller.start();

      // The gap is detected at boot, before the first scan can fail on it.
      const afterStart = poller.status();
      assert.equal(afterStart.restartGaps, 1);
      assert.deepEqual(afterStart.lastRestartGap, {
        at: FAKE_NOW,
        source: "market",
        cursorLedger: 4_250_000,
        oldestLedger: 4_300_000,
        missedLedgers: 50_000,
      });

      const market = afterStart.targets.find((t) => t.source === "market");
      assert.equal(market.cursor, null, "stale cursor must be dropped");
      assert.equal(market.gapLedgers, 50_000);
      assert.equal(market.cursorResetAt, FAKE_NOW);
      assert.equal(market.lastEventLedger, 4_250_000, "last seen ledger is history, keep it");

      // The other target was inside the window and keeps its resume position.
      const squad = afterStart.targets.find((t) => t.source === "squad");
      assert.equal(squad.cursor, cursorFor(4_350_000));
      assert.equal(squad.gapLedgers, 0);
      assert.equal(squad.cursorResetAt, null);

      await waitFor(() => poller.status().cycles >= 1);
      // The cursor file is written at the very end of a cycle, so it is the
      // signal that the cycle — not just the counter at its start — finished.
      await waitFor(() => storedCursor(cursorFile, "market") === cursorFor(4_400_000));
      poller.stop();
    });

    const warnings = captured.warn.filter((line) => line.includes("restart gap"));
    assert.equal(warnings.length, 1, "one gap, one warning");
    assert.match(warnings[0], /market: restart gap/);
    assert.match(warnings[0], /cursor at ledger 4250000/);
    assert.match(warnings[0], /retained floor 4300000/);
    assert.match(warnings[0], /50000 ledger/);
    for (const line of warnings) {
      assert.doesNotMatch(line, /SECRET-TOKEN/, "cycle logs must stay secret-free");
    }

    // The reset target is scanned from the configured lookback, not the cursor.
    const eventsCalls = server.eventsCalls();
    const marketCall = eventsCalls.find((c) => contractIdOf(c) === MARKET_ID);
    assert.equal(marketCall.request.cursor, undefined);
    assert.equal(marketCall.request.startLedger, 4_400_000 - 60);

    // The healthy target resumes from its persisted cursor.
    const squadCall = eventsCalls.find((c) => contractIdOf(c) === SQUAD_ID);
    assert.equal(squadCall.request.cursor, cursorFor(4_350_000));
    assert.equal(squadCall.request.startLedger, undefined);

    // A cold start of an empty window notifies nobody.
    assert.deepEqual(sent, []);

    // The persisted file now carries the freshly advanced cursor.
    assert.equal(storedCursor(cursorFile, "market"), cursorFor(4_400_000));
  });
});

test("a cold start with no cursor file reports no restart gap", async () => {
  await withCursorFile(null, async (cursorFile) => {
    const window = { oldestLedger: 4_300_000, latestLedger: 4_400_000 };
    const server = fakeServer({
      window,
      respond: () => emptyTailPage(window.latestLedger),
    });
    const poller = createPoller({
      config: baseConfig({ cursorFile, startLookbackLedgers: 60 }),
      server,
      send: async () => undefined,
      now: () => FAKE_NOW,
    });

    await captureConsole(async () => {
      await poller.start();
      // The cursor file is written at the very end of a cycle.
      await waitFor(() => storedCursor(cursorFile, "market") === cursorFor(4_400_000));
      poller.stop();
    });

    const status = poller.status();
    assert.equal(status.restartGaps, 0);
    assert.equal(status.lastRestartGap, null);
    for (const target of status.targets) {
      assert.equal(target.cursor, cursorFor(4_400_000), "the scan advanced it");
      assert.equal(target.gapLedgers, 0);
      assert.equal(target.cursorResetAt, null);
    }

    const marketCall = server.eventsCalls().find((c) => contractIdOf(c) === MARKET_ID);
    assert.equal(marketCall.request.startLedger, 4_400_000 - 60);
  });
});

test("a cursor that falls out of the window while scans fail is caught by the failure-path probe", async () => {
  const contents = cursorFileContents({
    market: { cursor: cursorFor(4_300_000), lastEventLedger: 4_300_000 },
    squad: { cursor: cursorFor(4_300_000), lastEventLedger: 4_300_000 },
  });

  await withCursorFile(contents, async (cursorFile) => {
    const calls = [];
    let healthCalls = 0;
    const server = {
      calls,
      async getHealth() {
        healthCalls += 1;
        calls.push({ kind: "health" });
        // The boot probe fails, so the poller starts without a floor and its
        // pre-scan check has nothing to compare against. By the time the scan
        // fails the window has rolled past the cursor.
        if (healthCalls === 1) throw new Error("RPC window unavailable");
        return { status: "healthy", oldestLedger: 4_360_000, latestLedger: 4_460_000 };
      },
      async getEvents(request) {
        calls.push({ kind: "events", request });
        throw new Error("RPC unavailable");
      },
    };

    const poller = createPoller({
      config: baseConfig({ cursorFile, startLookbackLedgers: 60 }),
      server,
      send: async () => undefined,
      now: () => FAKE_NOW,
    });

    const captured = await captureConsole(async () => {
      await poller.start();
      assert.equal(poller.status().oldestLedger, null, "no floor learned at boot");
      await waitFor(
        () => poller.status().restartGaps === 2 && poller.status().consecutiveFailures === 1,
      );
      poller.stop();
    });

    const status = poller.status();
    assert.equal(status.oldestLedger, 4_360_000, "the failure path refreshed the floor");
    assert.equal(status.lastRestartGap.cursorLedger, 4_300_000);
    assert.equal(status.lastRestartGap.missedLedgers, 60_000);
    assert.equal(status.consecutiveFailures, 1);
    for (const target of status.targets) {
      assert.equal(target.cursor, null);
      assert.equal(target.gapLedgers, 60_000);
      // The same RPC failure is still reported as the target's last error.
      assert.match(target.lastError, /RPC unavailable/);
    }
    assert.equal(
      captured.warn.filter((line) => line.includes("could not read the RPC ledger window")).length,
      1,
    );
  });
});

// ── negative / regression: what must NOT be reset ───────────────────────────

test("a failed scan inside the window leaves the cursor untouched", async () => {
  const contents = cursorFileContents({
    market: { cursor: cursorFor(4_350_000), lastEventLedger: 4_350_000 },
    squad: { cursor: cursorFor(4_350_000), lastEventLedger: 4_350_000 },
  });

  await withCursorFile(contents, async (cursorFile) => {
    const window = { oldestLedger: 4_300_000, latestLedger: 4_400_000 };
    const server = fakeServer({
      window,
      respond: () => {
        throw new Error("RPC unavailable");
      },
    });
    const poller = createPoller({
      config: baseConfig({ cursorFile }),
      server,
      send: async () => undefined,
      now: () => FAKE_NOW,
    });

    const captured = await captureConsole(async () => {
      await poller.start();
      await waitFor(
        () => poller.status().lastError !== null && poller.status().consecutiveFailures === 1,
      );
      poller.stop();
    });

    const status = poller.status();
    assert.equal(status.restartGaps, 0);
    assert.equal(status.lastRestartGap, null);
    assert.equal(status.consecutiveFailures, 1);
    for (const target of status.targets) {
      assert.equal(target.cursor, cursorFor(4_350_000), "an RPC error must not move it");
      assert.equal(target.gapLedgers, 0);
      assert.equal(target.cursorResetAt, null);
      assert.match(target.lastError, /RPC unavailable/);
    }
    assert.equal(storedCursor(cursorFile, "squad"), cursorFor(4_350_000));
    assert.equal(
      captured.warn.filter((line) => line.includes("restart gap")).length,
      0,
      "a failure inside the window is not a restart gap",
    );
  });
});

test("a cursor whose ledger cannot be parsed is reported once and left untouched", async () => {
  const legacy = "legacy-opaque-cursor";
  const contents = cursorFileContents({
    market: { cursor: legacy, lastEventLedger: 4_250_000 },
    squad: { cursor: cursorFor(4_350_000), lastEventLedger: 4_350_000 },
  });

  await withCursorFile(contents, async (cursorFile) => {
    const window = { oldestLedger: 4_300_000, latestLedger: 4_400_000 };
    // The RPC still rejects it, so the target never advances — but the poller
    // must not throw away a position it cannot interpret either.
    const server = fakeServer({
      window,
      respond: () => {
        throw new Error("invalid cursor");
      },
    });
    const poller = createPoller({
      config: baseConfig({ cursorFile, pollIntervalMs: 20 }),
      server,
      send: async () => undefined,
      now: () => FAKE_NOW,
    });

    const captured = await captureConsole(async () => {
      await poller.start();
      await waitFor(() => poller.status().cycles >= 2);
      poller.stop();
    });

    const status = poller.status();
    assert.equal(status.restartGaps, 0, "an unreadable position is not a gap");
    const market = status.targets.find((t) => t.source === "market");
    assert.equal(market.cursor, legacy, "leave it for the RPC to accept or reject");
    assert.equal(market.cursorUnreadable, true);
    assert.equal(market.gapLedgers, 0);

    // The parseable target is unaffected by its neighbour's opaque cursor.
    const squad = status.targets.find((t) => t.source === "squad");
    assert.equal(squad.cursor, cursorFor(4_350_000));
    assert.equal(squad.cursorUnreadable, false);

    assert.equal(
      captured.warn.filter((line) => line.includes("no readable ledger position")).length,
      1,
      "reported once, not once per cycle",
    );
  });
});

test("an unreadable cursor that the RPC accepts stops being flagged", async () => {
  const legacy = "legacy-opaque-cursor";
  const contents = cursorFileContents({
    market: { cursor: legacy, lastEventLedger: 4_250_000 },
    squad: { cursor: cursorFor(4_350_000), lastEventLedger: 4_350_000 },
  });

  await withCursorFile(contents, async (cursorFile) => {
    const window = { oldestLedger: 4_300_000, latestLedger: 4_400_000 };
    const server = fakeServer({
      window,
      respond: () => emptyTailPage(window.latestLedger),
    });
    const poller = createPoller({
      config: baseConfig({ cursorFile }),
      server,
      send: async () => undefined,
      now: () => FAKE_NOW,
    });

    await captureConsole(async () => {
      await poller.start();
      assert.equal(
        poller.status().targets.find((t) => t.source === "market").cursorUnreadable,
        true,
      );
      await waitFor(() => storedCursor(cursorFile, "market") === cursorFor(4_400_000));
      poller.stop();
    });

    const market = poller.status().targets.find((t) => t.source === "market");
    assert.equal(market.cursorUnreadable, false);
    assert.equal(market.cursor, cursorFor(4_400_000));
    assert.equal(poller.status().restartGaps, 0);
  });
});

// ── the operator-facing surfaces ────────────────────────────────────────────

test("/status reports a restart gap without leaking secrets", () => {
  const config = baseConfig();
  const status = {
    running: true,
    startedAt: 0,
    cycles: 3,
    lastPollAt: 0,
    lastSuccessAt: 0,
    latestLedger: 4_400_000,
    oldestLedger: 4_300_000,
    notificationsSent: 0,
    notificationsFailed: 0,
    eventsSkipped: 0,
    consecutiveFailures: 0,
    lastError: null,
    restartGaps: 1,
    lastRestartGap: {
      at: 0,
      source: "market",
      cursorLedger: 4_250_000,
      oldestLedger: 4_300_000,
      missedLedgers: 50_000,
    },
    targets: [
      {
        source: "market",
        contractId: MARKET_ID,
        cursor: null,
        lastEventLedger: 4_250_000,
        gapLedgers: 50_000,
        cursorResetAt: 0,
        cursorUnreadable: false,
        lastError: null,
      },
      {
        source: "squad",
        contractId: SQUAD_ID,
        cursor: cursorFor(4_400_000),
        lastEventLedger: null,
        gapLedgers: 0,
        cursorResetAt: null,
        cursorUnreadable: false,
        lastError: null,
      },
    ],
  };

  const message = statusMessage(config, status);
  assert.match(message, /restart gap: 50000 ledgers unrecoverable/);
  assert.match(message, /none \(cold start\)/);
  assert.match(message, /Restart gaps detected since start: 1/);
  assert.doesNotMatch(message, /SECRET-TOKEN/);
  assert.equal(message.includes(config.botToken), false);

  const flagged = statusMessage(config, {
    ...status,
    restartGaps: 0,
    targets: [
      {
        ...status.targets[0],
        cursor: "legacy-opaque-cursor",
        gapLedgers: 0,
        cursorResetAt: null,
        cursorUnreadable: true,
      },
    ],
  });
  assert.match(flagged, /cursor ledger unreadable: position left untouched/);
  assert.doesNotMatch(flagged, /restart gap/);
  assert.doesNotMatch(flagged, /Restart gaps detected/);
});
