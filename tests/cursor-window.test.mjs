/**
 * Restart gaps: a resume position that fell out of the RPC's retained window.
 *
 * The retained window is a rolling one (~120,960 ledgers on Testnet, roughly a
 * week), so a long enough downtime leaves the persisted cursor pointing at a
 * ledger the RPC no longer serves. Everything between that cursor and the floor
 * is unrecoverable, and the poller must say so once rather than retry the same
 * position forever.
 *
 * The poller already recovers from the case Soroban *rejects*. This suite covers
 * the two states that recovery cannot see:
 *
 *   - the same below-floor position answered with an **empty page instead of an
 *     error** — a walk that advances nothing and would otherwise stay silent
 *     forever. It is caught by placing the cursor against the floor the last
 *     successful scan proved, before asking the RPC anything;
 *   - a cursor whose ledger **cannot be read** out of the opaque token, which is
 *     reported (`cursorUnreadable`) and left untouched rather than treated as a
 *     gap, because an unreadable token is not evidence of a stale position.
 *
 * Everything here is an in-process fake: fake RPC, fake Telegram send, temporary
 * cursor paths and a fake clock. No network, no live Telegram, no credentials.
 */

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { classifyCursorWindow, createPoller } from "../dist/poller.js";
import { statusMessage } from "../dist/bot.js";
import { buildHealthReport } from "../dist/health.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

const TOKEN = "123456789:TEST-ONLY-TOKEN-NEVER-USE";
const MARKET_ID = "C" + "A".repeat(55);
const SQUAD_ID = "C" + "B".repeat(55);

const FLOOR = 900;
const TIP = 1000;
const WINDOW = { status: "healthy", oldestLedger: FLOOR, latestLedger: TIP };
const STALE_LEDGER = 500;

/** Soroban TOID cursor for a ledger, matching `eventCursorLedger`. */
const makeCursor = (ledger) => `${(BigInt(ledger) << 32n) | 1n}-0`;

/** Ledger the TOID half of a cursor encodes. */
function ledgerOf(cursor) {
  const toid = String(cursor).split("-")[0];
  return Number(BigInt(toid) >> 32n);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, label, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(5);
  }
}

// ── Harness ─────────────────────────────────────────────────────────────────

/**
 * A server that answers a cursor walk honestly and never rejects it: an empty
 * page that hands the same cursor back. That is the shape of the gap this
 * suite is about — no error to react to, and nothing that advances.
 */
function makeServer({ health = WINDOW, onEvents } = {}) {
  const requests = [];
  return {
    requests,
    async getHealth() {
      const value = typeof health === "function" ? health() : health;
      if (value instanceof Error) throw value;
      return value;
    },
    async getEvents(req) {
      requests.push(req);
      if (onEvents) return onEvents(req);
      if (typeof req.cursor === "string") {
        return { events: [], cursor: req.cursor, latestLedger: TIP };
      }
      return { events: [], cursor: makeCursor(TIP), latestLedger: TIP };
    },
  };
}

function makeConfig(cursorFile, overrides = {}) {
  return {
    marketContractId: MARKET_ID,
    squadContractId: SQUAD_ID,
    rpcUrl: "https://example.invalid/rpc",
    horizonUrl: "https://example.invalid/horizon",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://example.invalid/explorer",
    botToken: TOKEN,
    chatId: "-1001234567890",
    operatorTelegramUserId: null,
    pollIntervalMs: 20,
    startLookbackLedgers: 60,
    cursorFile,
    lockFile: `${cursorFile}.lock`,
    statusFile: path.join(path.dirname(cursorFile), "status.json"),
    maxNotificationsPerCycle: 20,
    dedupWindow: 64,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
    shutdownTimeoutMs: 50,
    channelPreviewMode: false,
    ...overrides,
  };
}

function cursorFileJson(targets) {
  return `${JSON.stringify(
    { version: 1, updatedAt: "2026-01-01T00:00:00.000Z", targets },
    null,
    2,
  )}\n`;
}

/** Monotonic fake clock so status timestamps never depend on the wall clock. */
function fakeClock(start = 1_700_000_000_000) {
  let value = start;
  return () => (value += 1_000);
}

function targetOf(poller, source) {
  return poller.status().targets.find((t) => t.source === source);
}

/** Captures console output for the duration of `fn`. */
async function captureLogs(fn) {
  const lines = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  const record = (...args) => lines.push(args.join(" "));
  console.log = console.warn = console.error = record;
  try {
    await fn();
  } finally {
    Object.assign(console, original);
  }
  return lines;
}

function assertBoundedAndClean(lines) {
  for (const line of lines) {
    assert.ok(line.length <= 300, `log line exceeded 300 chars (${line.length}): ${line}`);
    assert.equal(line.includes(TOKEN), false, `bot token leaked into logs: ${line}`);
  }
}

// ── The classifier ──────────────────────────────────────────────────────────

test("classifyCursorWindow places a readable cursor exactly, and refuses to guess", () => {
  assert.deepEqual(classifyCursorWindow(null, FLOOR), { status: "no-cursor" });
  assert.deepEqual(classifyCursorWindow("", FLOOR), { status: "no-cursor" });

  // An unknown floor is not evidence of anything, so nothing is classified.
  assert.deepEqual(classifyCursorWindow(makeCursor(STALE_LEDGER), null), {
    status: "unknown-floor",
  });
  assert.deepEqual(classifyCursorWindow(makeCursor(STALE_LEDGER), 0), {
    status: "unknown-floor",
  });

  // A token with no readable ledger is its own verdict: never a gap.
  assert.deepEqual(classifyCursorWindow("opaque-token", FLOOR), {
    status: "unreadable",
    cursor: "opaque-token",
  });
  // Ledgers start at 1, so a TOID that packs none is unreadable rather than
  // "at ledger 0". Both shapes are forwarded to the RPC instead of being
  // treated as a position this build can call stale.
  assert.deepEqual(classifyCursorWindow("456-0", FLOOR), {
    status: "unreadable",
    cursor: "456-0",
  });
  assert.deepEqual(classifyCursorWindow("0-0", FLOOR), {
    status: "unreadable",
    cursor: "0-0",
  });

  // Exactly at the floor is still retained, so it is inside the window.
  assert.deepEqual(classifyCursorWindow(makeCursor(FLOOR), FLOOR), {
    status: "inside",
    cursorLedger: FLOOR,
    behind: 0,
  });
  assert.deepEqual(classifyCursorWindow(makeCursor(TIP), FLOOR), {
    status: "inside",
    cursorLedger: TIP,
    behind: TIP - FLOOR,
  });

  // One ledger below the floor is already unrecoverable.
  assert.deepEqual(classifyCursorWindow(makeCursor(FLOOR - 1), FLOOR), {
    status: "stale",
    cursorLedger: FLOOR - 1,
    missedLedgers: 1,
  });
  assert.deepEqual(classifyCursorWindow(makeCursor(STALE_LEDGER), FLOOR), {
    status: "stale",
    cursorLedger: STALE_LEDGER,
    missedLedgers: FLOOR - STALE_LEDGER,
  });
});

test("the documented stale-cursor fixture is a restart gap", async () => {
  const raw = JSON.parse(
    await readFile(new URL("./fixtures/cursor-stale.json", import.meta.url), "utf8"),
  );
  const cursor = raw.targets.market.cursor;
  assert.equal(ledgerOf(cursor), 4_250_000);
  assert.deepEqual(classifyCursorWindow(cursor, 4_300_000), {
    status: "stale",
    cursorLedger: 4_250_000,
    missedLedgers: 50_000,
  });
});

// ── Detection that does not need an RPC error ───────────────────────────────

test("a stale cursor the RPC answers with an empty page is still caught and reported", () =>
  withTempDataDir(async (dir) => {
    const cursorFile = dir.file("cursor.json");
    await writeFile(
      cursorFile,
      cursorFileJson({
        market: { cursor: makeCursor(STALE_LEDGER), lastEventLedger: STALE_LEDGER },
        squad: { cursor: makeCursor(TIP), lastEventLedger: TIP },
      }),
      "utf8",
    );

    const server = makeServer();
    const poller = createPoller({
      config: makeConfig(cursorFile),
      server,
      send: async () => {},
      sendOptions: { sendSpacingMs: 0 },
      now: fakeClock(),
    });

    const lines = await captureLogs(async () => {
      await poller.start();
      try {
        await until(
          () => poller.status().cursorRewinds >= 1,
          "the below-floor cursor is caught without an RPC error",
        );
        await until(
          () => targetOf(poller, "market").rewindFromLedger === null,
          "the floor walk completed",
        );
      } finally {
        poller.stop();
      }
    });

    const status = poller.status();
    const market = targetOf(poller, "market");

    assert.equal(status.restartGaps, 1, "one gap, detected once");
    assert.equal(market.gapLedgers, FLOOR - STALE_LEDGER, "ledgers lost are counted");
    assert.equal(typeof market.cursorResetAt, "number", "the recovery is timestamped");
    assert.equal(market.cursorUnreadable, false);
    assert.deepEqual(
      { ...status.lastRestartGap, at: 0 },
      {
        at: 0,
        source: "market",
        cursorLedger: STALE_LEDGER,
        oldestLedger: FLOOR,
        missedLedgers: FLOOR - STALE_LEDGER,
      },
      "the gap names the position, the floor and what was lost",
    );
    assert.equal(targetOf(poller, "squad").gapLedgers, 0, "a healthy target keeps no gap");

    // The recovery is the existing one: walk from the floor, never from the
    // stale cursor (the two are mutually exclusive in one request).
    assert.ok(
      server.requests.some(
        (req) => req.startLedger === FLOOR && !Object.prototype.hasOwnProperty.call(req, "cursor"),
      ),
      "expected a floor walk with startLedger 900 and no cursor",
    );
    // Reported once, not once per cycle.
    const gapLines = lines.filter((line) => line.includes("restart gap"));
    assert.equal(gapLines.length, 1, `expected one gap line, got:\n${gapLines.join("\n")}`);
    assert.match(gapLines[0], new RegExp(`${STALE_LEDGER}`));
    assert.match(gapLines[0], new RegExp(`${FLOOR}`));
    assertBoundedAndClean(lines);

    // Both operator surfaces carry the gap.
    const config = makeConfig(cursorFile);
    const report = buildHealthReport(config, status, Date.now());
    assert.equal(report.poller.restartGaps, 1);
    assert.equal(report.poller.lastRestartGap.missedLedgers, FLOOR - STALE_LEDGER);
    assert.equal(report.poller.lastRestartGap.oldestLedger, FLOOR);
    assert.match(report.poller.lastRestartGap.at, /^\d{4}-\d{2}-\d{2}T/);
    const healthMarket = report.poller.targets.find((t) => t.source === "market");
    assert.equal(healthMarket.gapLedgers, FLOOR - STALE_LEDGER);
    assert.match(healthMarket.cursorResetAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(healthMarket.cursorUnreadable, false);

    const message = statusMessage(config, status, Date.now());
    assert.match(message, /restart gap: 400 ledgers unrecoverable, cursor reset \d+[smh] ago/);
    assert.match(message, /Restart gaps detected since start: 1/);
  }));

test("a failing scan with the cursor inside the window records no gap", () =>
  withTempDataDir(async (dir) => {
    const cursorFile = dir.file("cursor.json");
    const inside = FLOOR + 50;
    await writeFile(
      cursorFile,
      cursorFileJson({
        market: { cursor: makeCursor(inside), lastEventLedger: inside },
        squad: { cursor: makeCursor(inside), lastEventLedger: inside },
      }),
      "utf8",
    );

    // The market scan fails for a reason that is *not* a stale rejection, while
    // the squad scan succeeds and proves the floor. A failure inside the window
    // is an RPC problem, not a retention gap: the position must be untouched.
    const server = makeServer({
      onEvents: (req) => {
        if (req.filters?.[0]?.contractIds?.[0] === MARKET_ID) {
          throw new Error("rpc unavailable");
        }
        return { events: [], cursor: makeCursor(TIP), latestLedger: TIP };
      },
    });

    const poller = createPoller({
      config: makeConfig(cursorFile),
      server,
      send: async () => {},
      sendOptions: { sendSpacingMs: 0 },
      now: fakeClock(),
    });

    const lines = await captureLogs(async () => {
      await poller.start();
      try {
        await until(() => poller.status().oldestLedger === FLOOR, "the floor is known");
        await until(() => poller.status().cycles >= 3, "a few cycles ran");
      } finally {
        poller.stop();
      }
    });

    const status = poller.status();
    const market = targetOf(poller, "market");
    assert.equal(status.restartGaps, 0, "a failure inside the window is not a restart gap");
    assert.equal(status.cursorRewinds, 0, "and nothing is rewound");
    assert.equal(status.lastRestartGap, null);
    assert.equal(market.gapLedgers, 0);
    assert.equal(market.cursorResetAt, null);
    assert.equal(market.cursor, makeCursor(inside), "the position is left exactly where it was");
    assert.equal(lines.join("\n").includes("restart gap"), false);
  }));

test("a cursor with no readable ledger is flagged and left untouched, never called a gap", () =>
  withTempDataDir(async (dir) => {
    const cursorFile = dir.file("cursor.json");
    const opaque = "opaque-token-from-another-build";
    await writeFile(
      cursorFile,
      cursorFileJson({
        market: { cursor: opaque, lastEventLedger: FLOOR + 50 },
        squad: { cursor: makeCursor(TIP), lastEventLedger: TIP },
      }),
      "utf8",
    );

    const server = makeServer();
    const poller = createPoller({
      config: makeConfig(cursorFile),
      server,
      send: async () => {},
      sendOptions: { sendSpacingMs: 0 },
      now: fakeClock(),
    });

    const lines = await captureLogs(async () => {
      await poller.start();
      try {
        await until(() => targetOf(poller, "market").cursorUnreadable === true, "the flag is set");
        await until(() => poller.status().cycles >= 4, "later cycles ran");
      } finally {
        poller.stop();
      }
    });

    const status = poller.status();
    const market = targetOf(poller, "market");
    assert.equal(market.cursorUnreadable, true);
    assert.equal(market.cursor, opaque, "an unreadable token is forwarded, not replaced");
    assert.equal(status.restartGaps, 0, "an unreadable token is not evidence of a stale one");
    assert.equal(status.cursorRewinds, 0);
    assert.equal(market.gapLedgers, 0);
    assert.equal(market.cursorResetAt, null);

    const unreadableLines = lines.filter((line) => line.includes("no readable ledger position"));
    assert.equal(unreadableLines.length, 1, "flagged once, not once per cycle");
    assertBoundedAndClean(lines);

    const report = buildHealthReport(makeConfig(cursorFile), status, Date.now());
    assert.equal(report.poller.targets.find((t) => t.source === "market").cursorUnreadable, true);
    assert.equal(report.poller.targets.find((t) => t.source === "squad").cursorUnreadable, false);
    assert.match(
      statusMessage(makeConfig(cursorFile), status, Date.now()),
      /cursor ledger unreadable: position left untouched/,
    );
  }));

test("a cursor whose TOID packs no ledger is flagged, not mistaken for a gap", () =>
  withTempDataDir(async (dir) => {
    const cursorFile = dir.file("cursor.json");
    // `456-0` is a well-formed TOID shape that packs ledger 0, which is what the
    // shutdown suites persist as a placeholder. Ledgers start at 1, so this is a
    // token this build cannot place: it must be forwarded and flagged, never
    // rewound on the strength of a ledger of 0.
    await writeFile(
      cursorFile,
      cursorFileJson({
        market: { cursor: "456-0", lastEventLedger: 200 },
        squad: { cursor: makeCursor(TIP), lastEventLedger: TIP },
      }),
      "utf8",
    );

    const server = makeServer();
    const poller = createPoller({
      config: makeConfig(cursorFile),
      server,
      send: async () => {},
      sendOptions: { sendSpacingMs: 0 },
      now: fakeClock(),
    });

    await poller.start();
    try {
      await until(() => targetOf(poller, "market").cursorUnreadable === true, "the flag is set");
      await until(() => poller.status().cycles >= 3, "later cycles ran");
    } finally {
      poller.stop();
    }

    assert.equal(targetOf(poller, "market").cursor, "456-0", "the token is left untouched");
    assert.equal(poller.status().restartGaps, 0);
    assert.equal(poller.status().cursorRewinds, 0);
    assert.equal(targetOf(poller, "market").gapLedgers, 0);
  }));

test("an unreadable cursor clears once the RPC accepts it and the walk advances", () =>
  withTempDataDir(async (dir) => {
    const cursorFile = dir.file("cursor.json");
    const opaque = "opaque-token-from-another-build";
    await writeFile(
      cursorFile,
      cursorFileJson({
        market: { cursor: opaque, lastEventLedger: FLOOR + 50 },
        squad: { cursor: makeCursor(TIP), lastEventLedger: TIP },
      }),
      "utf8",
    );

    // First the RPC accepts the token but hands it straight back (no progress,
    // so the flag stands), then it advances the walk — at which point the
    // position this build could not read is no longer the position it holds.
    let advancing = false;
    const server = makeServer({
      onEvents: (req) => {
        if (req.cursor === opaque && !advancing) {
          return { events: [], cursor: opaque, latestLedger: TIP };
        }
        return { events: [], cursor: makeCursor(TIP), latestLedger: TIP };
      },
    });

    const poller = createPoller({
      config: makeConfig(cursorFile),
      server,
      send: async () => {},
      sendOptions: { sendSpacingMs: 0 },
      now: fakeClock(),
    });

    await poller.start();
    try {
      await until(() => targetOf(poller, "market").cursorUnreadable === true, "the flag is set");
      advancing = true;
      await until(
        () => targetOf(poller, "market").cursorUnreadable === false,
        "the flag clears on its own",
      );
      assert.equal(targetOf(poller, "market").cursor, makeCursor(TIP));
      assert.equal(poller.status().restartGaps, 0);
    } finally {
      poller.stop();
    }
  }));
