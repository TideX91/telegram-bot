/**
 * Focused coverage for poller cursor-stall detection (issue #5).
 *
 * Uses a fake RPC that echoes the same mid-window cursor while the tip stays
 * ahead, temporary cursor files, and a short poll interval. No live Telegram
 * or live RPC calls.
 */

import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createPoller,
  CURSOR_STALL_CYCLES,
} from "../dist/poller.js";

const MARKET_ID = "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";
const SQUAD_ID = "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY";

function makeCursor(ledger, tx = 1) {
  const toid = (BigInt(ledger) << 32n) | BigInt(tx);
  return `${toid.toString().padStart(19, "0")}-0`;
}

function baseConfig(overrides = {}) {
  return {
    marketContractId: MARKET_ID,
    squadContractId: SQUAD_ID,
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer",
    botToken: "0000000000:FAKE-TOKEN-DO-NOT-LEAK",
    chatId: "-1001234567890",
    pollIntervalMs: 40,
    startLookbackLedgers: 60,
    cursorFile: "./data/cursor.json",
    maxNotificationsPerCycle: 20,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
    ...overrides,
  };
}

function fakeServer({ tip, cursorLedger }) {
  const stalledCursor = makeCursor(cursorLedger);
  return {
    async getHealth() {
      return { status: "healthy", oldestLedger: Math.max(1, tip - 10_000), latestLedger: tip };
    },
    async getEvents() {
      // Always echo the same cursor while tip stays ahead — the stall case.
      return { events: [], cursor: stalledCursor, latestLedger: tip };
    },
  };
}

function advancingServer({ tip, startLedger }) {
  let ledger = startLedger;
  return {
    async getHealth() {
      return { status: "healthy", oldestLedger: Math.max(1, tip - 10_000), latestLedger: tip };
    },
    async getEvents() {
      ledger = Math.min(tip, ledger + 50);
      return { events: [], cursor: makeCursor(ledger), latestLedger: tip };
    },
  };
}

async function waitFor(predicate, { timeoutMs = 8_000, intervalMs = 40 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("waitFor timed out");
}

test("cursor stall: warns and marks cursorStalled when cursor never advances behind tip", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cursor-stall-"));
  const cursorFile = path.join(dir, "cursor.json");
  const stalledLedger = 4_000;
  const tip = 5_000;
  const stalledCursor = makeCursor(stalledLedger);

  await writeFile(
    cursorFile,
    JSON.stringify(
      {
        version: 1,
        updatedAt: new Date().toISOString(),
        targets: {
          market: { cursor: stalledCursor, lastEventLedger: stalledLedger },
          squad: { cursor: stalledCursor, lastEventLedger: stalledLedger },
        },
      },
      null,
      2,
    ) + "\n",
  );

  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => {
    warnings.push(args.map(String).join(" "));
  };

  const poller = createPoller({
    config: baseConfig({ cursorFile, pollIntervalMs: 40 }),
    server: fakeServer({ tip, cursorLedger: stalledLedger }),
    send: async () => {
      throw new Error("send must not be called for empty scans");
    },
  });

  try {
    await poller.start();
    await waitFor(() => {
      const st = poller.status();
      return st.targets.some((t) => t.cursorStalled);
    });

    const st = poller.status();
    const market = st.targets.find((t) => t.source === "market");
    assert.ok(market, "market target present");
    assert.equal(market.cursor, stalledCursor);
    assert.equal(market.cursorStalled, true);
    assert.ok(
      market.cyclesWithoutAdvance >= CURSOR_STALL_CYCLES,
      `expected >= ${CURSOR_STALL_CYCLES} stalled cycles, got ${market.cyclesWithoutAdvance}`,
    );

    const stallWarn = warnings.find((w) => w.includes("CURSOR STALLED"));
    assert.ok(stallWarn, `expected CURSOR STALLED warning; got ${JSON.stringify(warnings)}`);
    assert.match(stallWarn, /market/);
    assert.doesNotMatch(stallWarn, /FAKE-TOKEN|BOT_TOKEN|ghp_/i);
  } finally {
    poller.stop();
    console.warn = origWarn;
    await rm(dir, { recursive: true, force: true });
  }
});

test("cursor stall: idle at tip does not mark cursorStalled", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cursor-tip-"));
  const cursorFile = path.join(dir, "cursor.json");
  const tip = 5_000;
  const tipCursor = makeCursor(tip);

  await writeFile(
    cursorFile,
    JSON.stringify(
      {
        version: 1,
        updatedAt: new Date().toISOString(),
        targets: {
          market: { cursor: tipCursor, lastEventLedger: tip },
          squad: { cursor: tipCursor, lastEventLedger: tip },
        },
      },
      null,
      2,
    ) + "\n",
  );

  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => {
    warnings.push(args.map(String).join(" "));
  };

  const poller = createPoller({
    config: baseConfig({ cursorFile, pollIntervalMs: 40 }),
    server: fakeServer({ tip, cursorLedger: tip }),
    send: async () => {},
  });

  try {
    await poller.start();
    await waitFor(() => poller.status().cycles >= CURSOR_STALL_CYCLES + 2);

    const st = poller.status();
    for (const t of st.targets) {
      assert.equal(t.cursorStalled, false, `${t.source} must not stall at tip`);
      assert.equal(t.cyclesWithoutAdvance, 0);
    }
    assert.equal(
      warnings.filter((w) => w.includes("CURSOR STALLED")).length,
      0,
      `unexpected stall warnings: ${JSON.stringify(warnings)}`,
    );
  } finally {
    poller.stop();
    console.warn = origWarn;
    await rm(dir, { recursive: true, force: true });
  }
});

test("cursor stall: advancing cursor resets stall counters", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cursor-adv-"));
  const cursorFile = path.join(dir, "cursor.json");
  const tip = 5_000;
  const startLedger = 4_000;

  await writeFile(
    cursorFile,
    JSON.stringify(
      {
        version: 1,
        updatedAt: new Date().toISOString(),
        targets: {
          market: { cursor: makeCursor(startLedger), lastEventLedger: startLedger },
          squad: { cursor: makeCursor(startLedger), lastEventLedger: startLedger },
        },
      },
      null,
      2,
    ) + "\n",
  );

  const poller = createPoller({
    config: baseConfig({ cursorFile, pollIntervalMs: 40 }),
    server: advancingServer({ tip, startLedger }),
    send: async () => {},
  });

  try {
    await poller.start();
    await waitFor(() => {
      const market = poller.status().targets.find((t) => t.source === "market");
      return market && market.cursor !== makeCursor(startLedger);
    });
    await waitFor(() => poller.status().cycles >= 3);

    const market = poller.status().targets.find((t) => t.source === "market");
    assert.ok(market);
    assert.equal(market.cursorStalled, false);
    assert.equal(market.cyclesWithoutAdvance, 0);
    assert.notEqual(market.cursor, makeCursor(startLedger));
  } finally {
    poller.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
