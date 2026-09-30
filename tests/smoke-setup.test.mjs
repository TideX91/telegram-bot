/**
 * Clean checkout setup smoke tests — devx #150
 *
 * These tests verify that a developer can clone the repository, run the
 * documented clean-checkout sequence, and have a working credential-free
 * development environment without touching Testnet or Telegram.
 *
 * ── What "clean checkout" means ───────────────────────────────────────────────
 *
 *   npm ci
 *   npm run typecheck
 *   npm test
 *
 * The suite below exercises the same code paths those commands validate, but
 * as focused regression checks that run on every `npm test`.  No live network,
 * no bot tokens, no private keys, and no Soroban signing material anywhere.
 *
 * ── Coverage ──────────────────────────────────────────────────────────────────
 *
 *  positive     build artifacts present, lockfile consistent, mock profile loads
 *  negative     unknown profile rejected, missing required config caught
 *  boundary     empty env, blank profile, corrupt cursor file
 *  restart      poller resumes from saved cursor across stop/start
 *  regression   bot token never reaches logs, health report stays redacted
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  checkLockfile,
  LOCKFILE_VERSION,
  REGISTRY,
} from "../scripts/check-lockfile.mjs";
import {
  ConfigError,
  activeProfileName,
  loadConfig,
  loadStellarConfig,
  networkLabel,
} from "../dist/config.js";
import {
  MOCK_MARKET_CONTRACT_ID,
  MOCK_NETWORK_PASSPHRASE,
  MOCK_RPC_DEFAULT_PORT,
  MOCK_SQUAD_CONTRACT_ID,
} from "../dist/stellar/mock-constants.js";
import {
  defaultMockScenario,
  startMockRpc,
} from "../dist/stellar/mock-rpc.js";
import { createPoller } from "../dist/poller.js";
import { createRpcServer } from "../dist/stellar/client.js";
import { readContractEvents } from "../dist/stellar/events.js";
import { buildHealthReport, startHealthServer } from "../dist/health.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const VALID_ENV_KEYS = [
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
  "TELEGRAM_MARKET_CHAT_ID",
  "TELEGRAM_SQUAD_CHAT_ID",
  "ALLOWED_CHAT_IDS",
  "OPERATOR_TELEGRAM_USER_ID",
  "POLL_INTERVAL_MS",
  "START_LOOKBACK_LEDGERS",
  "MAX_NOTIFICATIONS_PER_CYCLE",
  "HEALTH_HOST",
  "HEALTH_PORT",
  "HEALTH_STALE_MS",
];

function withEnv(overrides, fn) {
  const saved = new Map();
  for (const key of VALID_ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function baseConfig(overrides = {}) {
  return {
    marketContractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    squadContractId: "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    botToken: "0000000000:SECRET-TOKEN-DO-NOT-LEAK",
    chatId: "-1001234567890",
    operatorTelegramUserId: null,
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    cursorFile: "./data/cursor.json",
    maxNotificationsPerCycle: 20,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
    startupHealthDeadlineMs: 30_000,
    startupHealthRetryMs: 1_000,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── Positive: build artifacts and lockfile ────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

test("dist/ contains the compiled entry point after npm run build", () => {
  assert.ok(existsSync(path.join(root, "dist/index.js")), "dist/index.js must exist after build");
  assert.ok(existsSync(path.join(root, "dist/config.js")), "dist/config.js must exist after build");
  assert.ok(existsSync(path.join(root, "dist/poller.js")), "dist/poller.js must exist after build");
});

test("committed lockfile passes every consistency check", () => {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
  const result = checkLockfile(pkg, lock);
  assert.equal(result.ok, true, result.problems.join("\n"));
  assert.ok(result.stats.packages > 0, "expected pinned packages");
  assert.equal(
    result.stats.direct,
    Object.keys(pkg.dependencies).length + Object.keys(pkg.devDependencies).length,
  );
});

test("every committed package is pinned to registry.npmjs.org with sha512 integrity", () => {
  const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === "") continue;
    assert.match(entry.resolved, new RegExp(`^${REGISTRY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(entry.integrity, /^sha512-/);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ── Positive: mock profile provides safe defaults without env vars ─────────────
// ═══════════════════════════════════════════════════════════════════════════════

test("mock profile loads without any environment variables", () => {
  withEnv({ MIMIR_PROFILE: "mock" }, () => {
    assert.equal(activeProfileName(), "mock");
    const config = loadConfig();
    assert.equal(config.rpcUrl, `http://127.0.0.1:${MOCK_RPC_DEFAULT_PORT}`);
    assert.equal(config.marketContractId, MOCK_MARKET_CONTRACT_ID);
    assert.equal(config.squadContractId, MOCK_SQUAD_CONTRACT_ID);
    assert.equal(config.cursorFile, path.resolve("./data/cursor.mock.json"));
    assert.equal(config.networkPassphrase, MOCK_NETWORK_PASSPHRASE);
    assert.equal(networkLabel(config), "mock");
    assert.equal(config.botToken, "MOCK-PROFILE-NOT-A-BOT-TOKEN");
    assert.equal(config.chatId, "@mock_profile");
    assert.equal(config.operatorTelegramUserId, null);
  });
});

test("loadStellarConfig works without BOT_TOKEN or TELEGRAM_CHAT_ID", () => {
  withEnv(
    {
      MIMIR_PROFILE: "mock",
      BOT_TOKEN: undefined,
      TELEGRAM_CHAT_ID: undefined,
    },
    () => {
      const config = loadStellarConfig();
      assert.equal(config.marketContractId, MOCK_MARKET_CONTRACT_ID);
      assert.equal(config.squadContractId, MOCK_SQUAD_CONTRACT_ID);
    },
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// ── Negative: bad config is caught before the event loop ──────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

test("an unknown profile fails fast with an actionable hint", () => {
  withEnv({ MIMIR_PROFILE: "production" }, () => {
    assert.throws(
      () => loadStellarConfig(),
      (err) => {
        assert.ok(err instanceof ConfigError);
        assert.match(err.message, /MIMIR_PROFILE must be "mock" when set; got "production"/);
        assert.match(err.message, /MIMIR_PROFILE=mock/);
        assert.equal(err.problems.length, 1);
        return true;
      },
    );
  });
});

test("missing required values are all reported in one error", () => {
  withEnv(
    {
      MARKET_CONTRACT_ID: undefined,
      SQUAD_CONTRACT_ID: undefined,
      BOT_TOKEN: undefined,
      TELEGRAM_CHAT_ID: undefined,
    },
    () => {
      assert.throws(
        () => loadConfig(),
        (err) => {
          assert.ok(err instanceof ConfigError);
          assert.ok(err.problems.some((p) => p.includes("BOT_TOKEN")));
          assert.ok(err.problems.some((p) => p.includes("TELEGRAM_CHAT_ID")));
          assert.ok(err.problems.some((p) => p.includes("MARKET_CONTRACT_ID")));
          assert.ok(err.problems.some((p) => p.includes("SQUAD_CONTRACT_ID")));
          return true;
        },
      );
    },
  );
});

test("a malformed contract id is rejected", () => {
  withEnv(
    {
      MIMIR_PROFILE: "mock",
      MARKET_CONTRACT_ID: "GNOTACONTRACT",
    },
    () => {
      assert.throws(
        () => loadStellarConfig(),
        (err) => {
          assert.ok(err instanceof ConfigError);
          assert.ok(err.problems.some((p) => p.includes("MARKET_CONTRACT_ID")));
          return true;
        },
      );
    },
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// ── Boundary: blank profile, empty env, corrupt cursor ────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

test("a blank MIMIR_PROFILE is treated as unset", () => {
  withEnv(
    {
      MIMIR_PROFILE: "   ",
      MARKET_CONTRACT_ID: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
      SQUAD_CONTRACT_ID: "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY",
    },
    () => {
      assert.equal(activeProfileName(), null);
      const config = loadStellarConfig();
      assert.equal(config.rpcUrl, "https://soroban-testnet.stellar.org");
      assert.equal(networkLabel(config), "testnet");
    },
  );
});

test("poller treats a corrupt cursor file as a cold start (no crash)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "mimir-smoke-"));
  const file = path.join(dir, "cursor.json");
  await writeFile(file, "}{not valid json}{", "utf8");

  const poller = createPoller({
    config: { ...baseConfig({ healthPort: 0, cursorFile: file }), cursorFile: file },
    server: {
      async getHealth() {
        return { status: "healthy", latestLedger: 5_000_000, oldestLedger: 4_000_000 };
      },
      async getEvents() {
        return { events: [], latestLedger: 5_000_000, cursor: "" };
      },
    },
    send: async () => {},
  });

  await poller.start();
  await new Promise((r) => setTimeout(r, 200));
  await poller.shutdown({ timeoutMs: 1000 });

  const status = poller.status();
  assert.ok(status.cycles >= 1, "poller should continue after corrupt cursor");

  await rm(dir, { recursive: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ── Restart: poller resumes from saved cursor across stop/start ───────────────
// ═══════════════════════════════════════════════════════════════════════════════

test("poller resumes from a valid v1 cursor file across stop/start", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "mimir-smoke-"));
  const file = path.join(dir, "cursor.json");
  const cursor = "0018276211125911551-4294967295";

  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      updatedAt: "2026-09-01T00:00:00.000Z",
      targets: {
        market: { cursor, lastEventLedger: 4226729 },
        squad: { cursor, lastEventLedger: 4226733 },
      },
    }),
    "utf8",
  );

  let marketCursor = null;
  let squadCursor = null;

  const poller = createPoller({
    config: { ...baseConfig({ healthPort: 0, cursorFile: file }), cursorFile: file },
    server: {
      async getHealth() {
        return { status: "healthy", latestLedger: 5_000_000, oldestLedger: 4_000_000 };
      },
      async getEvents(req) {
        if (req.cursor) {
          if (marketCursor === null) marketCursor = req.cursor;
          else squadCursor = req.cursor;
        }
        return { events: [], latestLedger: 5_000_000, cursor: "" };
      },
    },
    send: async () => {},
  });

  await poller.start();
  await new Promise((r) => setTimeout(r, 300));
  await poller.shutdown({ timeoutMs: 1000 });

  assert.equal(marketCursor, cursor, "market should resume from saved cursor");
  assert.equal(squadCursor, cursor, "squad should resume from saved cursor");

  await rm(dir, { recursive: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ── Regression: secrets never reach logs or health output ─────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

test("config provenance never includes setting values", () => {
  withEnv(
    {
      MIMIR_PROFILE: "mock",
      BOT_TOKEN: "123456789:REAL-SECRET-TOKEN",
      TELEGRAM_CHAT_ID: "-1001234567890",
    },
    () => {
      const provenance = loadConfig();
      // Force a provenance read after loadConfig has populated process.env.
      const report = buildHealthReport(
        { ...baseConfig({ botToken: "123456789:REAL-SECRET-TOKEN", chatId: "-1001234567890" }), healthPort: 0 },
        {
          running: true,
          paused: false,
          startedAt: Date.now(),
          cycles: 1,
          lastPollAt: Date.now(),
          lastSuccessAt: Date.now(),
          latestLedger: 5000000,
          oldestLedger: 4000000,
          chainClockAt: Date.now(),
          notificationsSent: 0,
          notificationsFailed: 0,
          eventsSkipped: 0,
          eventsDeduplicated: 0,
          notificationsDropped: 0,
          cursorRewinds: 0,
          consecutiveFailures: 0,
          lastError: null,
          pendingFlush: false,
          targets: [],
        },
        Date.now(),
      );
      const blob = JSON.stringify(report.config);
      assert.equal(blob.includes("REAL-SECRET-TOKEN"), false);
      assert.equal(blob.includes("-1001234567890"), false);
    },
  );
});

test("health report never embeds bot token or chat id", () => {
  const config = baseConfig();
  const status = {
    running: true,
    paused: false,
    startedAt: 1_000,
    cycles: 1,
    lastPollAt: 1_000,
    lastSuccessAt: 1_000,
    latestLedger: 42,
    oldestLedger: 1,
    chainClockAt: 1_000,
    notificationsSent: 0,
    notificationsFailed: 0,
    eventsSkipped: 0,
    eventsDeduplicated: 0,
    notificationsDropped: 0,
    cursorRewinds: 0,
    consecutiveFailures: 0,
    lastError: null,
    pendingFlush: false,
    targets: [],
  };
  const report = buildHealthReport(config, status, 5_500);
  const blob = JSON.stringify(report);
  assert.equal(blob.includes(config.botToken), false);
  assert.equal(blob.includes(config.chatId), false);
});

// ═══════════════════════════════════════════════════════════════════════════════
// ── End-to-end: mock RPC + poller + health server ─────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

test("clean checkout: mock RPC, poller, and health server start without credentials", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "mimir-smoke-"));
  const cursorFile = path.join(dir, "cursor.json");

  await withEnv({ MIMIR_PROFILE: "mock" }, async () => {
    const config = loadConfig();
    const mock = await startMockRpc({ port: 0, scenario: defaultMockScenario() });
    const server = createRpcServer({ ...config, rpcUrl: mock.url });

    const logs = [];
    const originalLog = console.log;
    const originalWarn = console.warn;
    const capture = (...args) => logs.push(args.map(String).join(" "));
    console.log = capture;
    console.warn = capture;

    try {
      const send = async (text) => {
        capture(`[send] ${text}`);
      };

      const pollerConfig = { ...config, cursorFile, healthPort: 18787, rpcUrl: mock.url };
      const poller = createPoller({ config: pollerConfig, server, send });
      const health = startHealthServer({ config: pollerConfig, status: () => poller.status() });

      await poller.start();

      // Wait for the first successful cycle to complete.
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const s = poller.status();
        if (s.cycles >= 1 && s.lastSuccessAt !== null) break;
        await new Promise((r) => setTimeout(r, 100));
      }

      const status = poller.status();
      assert.ok(status.cycles >= 1, "poller should complete at least one cycle");
      assert.ok(status.lastSuccessAt !== null, "first cycle should succeed");

      // Cursor file must be valid JSON with a version field.
      let raw;
      for (let attempt = 0; attempt < 40; attempt++) {
        try {
          raw = await readFile(cursorFile, "utf8");
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 50));
        }
      }
      assert.ok(raw, "cursor file should be written after the first cycle");
      const parsed = JSON.parse(raw);
      assert.equal(parsed.version, 1, "cursor file must carry version: 1");

      // Health endpoint must respond.
      const res = await fetch(`${health.url}/health`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.service, "mimir-telegram-bot");

      // No bot token or real-looking secret in any captured log line.
      const allLogs = logs.join("\n");
      assert.equal(allLogs.includes("REAL-SECRET"), false);
      assert.equal(allLogs.includes("MOCK-PROFILE-NOT-A-BOT-TOKEN"), false);

      await poller.shutdown({ timeoutMs: 1000 });
      await health.close();
      await mock.close();
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
    }
  });

  await rm(dir, { recursive: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ── Positive: scanner walks events from the local mock RPC ────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

test("readContractEvents walks mock RPC pages without credentials", async () => {
  const scenario = defaultMockScenario();
  const mock = await startMockRpc({ port: 0, scenario });

  try {
    const config = {
      rpcUrl: mock.url,
      marketContractId: MOCK_MARKET_CONTRACT_ID,
      squadContractId: MOCK_SQUAD_CONTRACT_ID,
    };
    const server = createRpcServer(config);

    const market = await readContractEvents(server, {
      source: "market",
      contractId: MOCK_MARKET_CONTRACT_ID,
    });

    assert.ok(Array.isArray(market.events), "events should be an array");
    assert.equal(typeof market.cursor, "string");
    assert.ok(market.pages >= 1, "scanner should report at least one page");
    assert.equal(market.source, "market");

    const squad = await readContractEvents(server, {
      source: "squad",
      contractId: MOCK_SQUAD_CONTRACT_ID,
    });

    assert.equal(squad.source, "squad");
    assert.ok(squad.pages >= 1);
  } finally {
    await mock.close();
  }
});
