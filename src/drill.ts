/**
 * Incident drill runner and integration fakes for Mimir notifier.
 *
 * Simulates long-running Stellar and Telegram failures without requiring live
 * Testnet RPC or Telegram credentials:
 *  - RPC failures (transient and prolonged, cursor untouched)
 *  - Telegram failures (lossy delivery, bounded retries, cursor advances)
 *  - Stale cursors (RPC rejection, preserved cursor, degraded health)
 *  - Corrupt cursors (unparseable cursor file, safe cold start fallback)
 *  - Malformed events (decoding safety, skip without crashing)
 *  - Rate limits / bursts (capped notifications per cycle, skip extras)
 *  - Process restarts (unpersisted operator pause, version-1 cursor reload)
 *  - Scanner diagnostic (credential-free pagination, empty pages walk)
 *
 * Enforces key operational invariants:
 *  - Stellar chain is the source of truth
 *  - Notifier is read-only (never holds signing keys or private keys)
 *  - Zero bot tokens, private keys, payment proofs, or unbounded remote payloads in logs/status
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { nativeToScVal, type rpc } from "@stellar/stellar-sdk";

import type { BotConfig } from "./config.js";
import { buildHealthReport } from "./health.js";
import { createPoller, type Poller } from "./poller.js";
import { eventCursorLedger, readContractEvents, type WatchTarget } from "./stellar/events.js";

export type DrillScenarioName =
  | "rpc-failure"
  | "telegram-failure"
  | "stale-cursor"
  | "corrupt-cursor"
  | "malformed-event"
  | "rate-limit"
  | "restart"
  | "scanner-diagnostic";

export interface DrillScenarioResult {
  name: DrillScenarioName;
  passed: boolean;
  durationMs: number;
  details: string[];
  error?: string;
}

export interface DrillReport {
  passed: boolean;
  totalScenarios: number;
  passedScenarios: number;
  failedScenarios: number;
  totalDurationMs: number;
  results: DrillScenarioResult[];
}

export interface DrillOptions {
  scenario?: DrillScenarioName | "all";
  json?: boolean;
  verbose?: boolean;
}

const SECRET_BOT_TOKEN = "123456789:TEST-ONLY-TOKEN-NEVER-USE";
const SECRET_PRIVATE_KEY = "S" + "A".repeat(55);

export function makeDrillCursor(ledger: number, index = 0): string {
  return `${(BigInt(ledger) << 32n).toString()}-${index}`;
}

export function createDrillConfig(cursorFile: string, overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    marketContractId: "CFIXTUREMARKET00000000000000000000000000000000000000000",
    squadContractId: "CFIXTURESQUAD0000000000000000000000000000000000000000000",
    rpcUrl: "https://example.invalid/rpc",
    horizonUrl: "https://example.invalid/horizon",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://example.invalid/explorer",
    botToken: SECRET_BOT_TOKEN,
    chatId: "-1001234567890",
    operatorTelegramUserId: "42",
    pollIntervalMs: 5_000,
    startLookbackLedgers: 60,
    cursorFile,
    maxNotificationsPerCycle: 20,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
    ...overrides,
  };
}

export interface MockEventOptions {
  contractId: string;
  ledger: number;
  index?: number;
  txHash?: string;
}

export function createMockClaimCreatedEvent(
  opts: MockEventOptions & { claimId: number; creator: string; category: string },
): rpc.Api.EventResponse {
  const index = opts.index ?? 0;
  return {
    type: "contract",
    ledger: opts.ledger,
    ledgerClosedAt: new Date(1724000000000 + opts.ledger * 1000).toISOString(),
    contractId: opts.contractId,
    id: `${opts.ledger}-${index}`,
    pagingToken: makeDrillCursor(opts.ledger, index),
    topic: [
      nativeToScVal("claim_created"),
      nativeToScVal(BigInt(opts.claimId)),
      nativeToScVal(opts.creator),
    ],
    value: nativeToScVal({ category: opts.category }),
    txHash: opts.txHash ?? "00".repeat(32),
    inSuccessfulContractCall: true,
  } as unknown as rpc.Api.EventResponse;
}

export function createMockClaimChallengedEvent(
  opts: MockEventOptions & { claimId: number; challenger: string; stake: bigint },
): rpc.Api.EventResponse {
  const index = opts.index ?? 0;
  return {
    type: "contract",
    ledger: opts.ledger,
    ledgerClosedAt: new Date(1724000000000 + opts.ledger * 1000).toISOString(),
    contractId: opts.contractId,
    id: `${opts.ledger}-${index}`,
    pagingToken: makeDrillCursor(opts.ledger, index),
    topic: [
      nativeToScVal("claim_challenged"),
      nativeToScVal(BigInt(opts.claimId)),
      nativeToScVal(opts.challenger),
    ],
    value: nativeToScVal({ stake: opts.stake }),
    txHash: opts.txHash ?? "00".repeat(32),
    inSuccessfulContractCall: true,
  } as unknown as rpc.Api.EventResponse;
}

export function createMockMalformedEvent(
  opts: MockEventOptions & { eventName?: string; reason?: string },
): rpc.Api.EventResponse {
  const index = opts.index ?? 0;
  return {
    type: "contract",
    ledger: opts.ledger,
    ledgerClosedAt: new Date(1724000000000 + opts.ledger * 1000).toISOString(),
    contractId: opts.contractId,
    id: `${opts.ledger}-${index}`,
    pagingToken: makeDrillCursor(opts.ledger, index),
    topic: [
      nativeToScVal(opts.eventName ?? "claim_created"),
      nativeToScVal("not-a-valid-number"),
    ],
    value: nativeToScVal({ malformed: opts.reason ?? "invalid topic" }),
    txHash: opts.txHash ?? "00".repeat(32),
    inSuccessfulContractCall: true,
  } as unknown as rpc.Api.EventResponse;
}

export interface FakeRpcServerController {
  server: rpc.Server;
  setHealth(oldest: number, latest: number): void;
  queueEvents(contractId: string, events: rpc.Api.EventResponse[]): void;
  setFailure(fn: (request: rpc.Server.GetEventsRequest) => Error | null): void;
  clearFailure(): void;
  setEmptyPagesUntilEvents(count: number): void;
  getRecordedCalls(): rpc.Server.GetEventsRequest[];
}

export function createFakeRpcServer(initialOldest = 1, initialLatest = 100): FakeRpcServerController {
  let oldestLedger = initialOldest;
  let latestLedger = initialLatest;
  const eventsByContract = new Map<string, rpc.Api.EventResponse[]>();
  let failureFn: ((request: rpc.Server.GetEventsRequest) => Error | null) | null = null;
  let emptyPagesRemaining = 0;
  let currentEmptyLedger = initialOldest;
  const recordedCalls: rpc.Server.GetEventsRequest[] = [];

  const server = {
    getHealth: async (): Promise<rpc.Api.GetHealthResponse> => ({
      status: "healthy",
      oldestLedger,
      latestLedger,
      ledgerRetentionWindow: 120_960,
    }),

    getEvents: async (request: rpc.Server.GetEventsRequest): Promise<rpc.Api.GetEventsResponse> => {
      recordedCalls.push(request);

      if (failureFn) {
        const error = failureFn(request);
        if (error) throw error;
      }

      const nowIso = new Date().toISOString();

      if (emptyPagesRemaining > 0) {
        emptyPagesRemaining -= 1;
        currentEmptyLedger += 10;
        // Return an empty page with an advancing cursor
        return {
          events: [],
          latestLedger,
          oldestLedger,
          latestLedgerCloseTime: nowIso,
          oldestLedgerCloseTime: nowIso,
          cursor: makeDrillCursor(Math.min(latestLedger, currentEmptyLedger)),
        };
      }

      const filters = request.filters ?? [];
      const contractId = filters[0]?.contractIds?.[0] ?? "";
      const queue = eventsByContract.get(contractId) ?? [];

      const cursor = request.cursor;
      let startIndex = 0;
      if (cursor) {
        const cursorLedger = eventCursorLedger(cursor);
        if (cursorLedger !== null) {
          startIndex = queue.findIndex((e) => Number(e.ledger) > cursorLedger);
          if (startIndex === -1) startIndex = queue.length;
        } else {
          const idx = queue.findIndex((e) => (e as unknown as { pagingToken?: string }).pagingToken === cursor);
          if (idx !== -1) startIndex = idx + 1;
        }
      } else if (request.startLedger !== undefined) {
        startIndex = queue.findIndex((e) => Number(e.ledger) >= (request.startLedger ?? 0));
        if (startIndex === -1) startIndex = queue.length;
      }

      const limit = Math.max(1, request.limit ?? 200);
      const slice = queue.slice(startIndex, startIndex + limit);

      let nextCursor: string;
      if (slice.length > 0) {
        const last = slice[slice.length - 1];
        nextCursor = (last as unknown as { pagingToken?: string })?.pagingToken ?? makeDrillCursor(Number(last?.ledger ?? latestLedger));
      } else {
        nextCursor = makeDrillCursor(latestLedger);
      }

      return {
        events: slice,
        latestLedger,
        oldestLedger,
        latestLedgerCloseTime: nowIso,
        oldestLedgerCloseTime: nowIso,
        cursor: nextCursor,
      };
    },
  } as unknown as rpc.Server;

  return {
    server,
    setHealth(oldest: number, latest: number) {
      oldestLedger = oldest;
      latestLedger = latest;
    },
    queueEvents(contractId: string, events: rpc.Api.EventResponse[]) {
      const existing = eventsByContract.get(contractId) ?? [];
      eventsByContract.set(contractId, [...existing, ...events]);
    },
    setFailure(fn) {
      failureFn = fn;
    },
    clearFailure() {
      failureFn = null;
    },
    setEmptyPagesUntilEvents(count: number) {
      emptyPagesRemaining = count;
    },
    getRecordedCalls() {
      return [...recordedCalls];
    },
  };
}

export interface FakeTelegramNotifier {
  send: (text: string) => Promise<void>;
  sent: string[];
  setFailureMode(mode: "ok" | "fail-always" | "fail-count", count?: number, error?: Error): void;
  assertNoSecrets(secrets: string[]): void;
}

export function createFakeTelegramNotifier(): FakeTelegramNotifier {
  const sent: string[] = [];
  let mode: "ok" | "fail-always" | "fail-count" = "ok";
  let failCount = 0;
  let customError: Error | null = null;

  return {
    sent,
    send: async (text: string): Promise<void> => {
      if (mode === "fail-always") {
        throw customError ?? new Error("Telegram API unavailable (500)");
      }
      if (mode === "fail-count" && failCount > 0) {
        failCount -= 1;
        throw customError ?? new Error("Telegram rate limited (429)");
      }
      sent.push(text);
    },
    setFailureMode(newMode, count = 0, error) {
      mode = newMode;
      failCount = count;
      customError = error ?? null;
    },
    assertNoSecrets(secrets: string[]) {
      for (const msg of sent) {
        for (const secret of secrets) {
          if (secret && msg.includes(secret)) {
            throw new Error(`Secret leaked in Telegram message: ${secret}`);
          }
        }
      }
    },
  };
}

async function withTempCursorFile<T>(
  initialContent: string | null,
  fn: (cursorFile: string, dir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mimir-drill-"));
  const cursorFile = path.join(dir, "cursor.json");
  if (initialContent !== null) {
    await writeFile(cursorFile, initialContent, "utf8");
  }
  try {
    return await fn(cursorFile, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const noopSleep = async (_ms: number): Promise<void> => undefined;

// ── 1. RPC Failure Drill ─────────────────────────────────────────────────────

export async function runRpcFailureDrill(): Promise<DrillScenarioResult> {
  const start = Date.now();
  const details: string[] = [];

  const initialCursor = JSON.stringify({
    version: 1,
    updatedAt: "2026-09-24T00:00:00.000Z",
    targets: {
      market: { cursor: makeDrillCursor(40), lastEventLedger: 40 },
      squad: { cursor: makeDrillCursor(40), lastEventLedger: 40 },
    },
  });

  return withTempCursorFile(initialCursor, async (cursorFile) => {
    const config = createDrillConfig(cursorFile);
    const rpcController = createFakeRpcServer(1, 100);
    const notifier = createFakeTelegramNotifier();

    const loggedErrors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => loggedErrors.push(args.join(" "));

    // Inject prolonged RPC failure for market contract containing secret bot token and unbounded remote payload
    const sensitivePayload = `RPC upstream failure ${SECRET_BOT_TOKEN} ${SECRET_PRIVATE_KEY} ${"unbounded_data_".repeat(50)}`;
    rpcController.setFailure((req) => {
      const contract = req.filters?.[0]?.contractIds?.[0];
      if (contract === config.marketContractId) {
        return new Error(sensitivePayload);
      }
      return null;
    });

    const poller: Poller = createPoller({
      config,
      server: rpcController.server,
      send: notifier.send,
      sleep: noopSleep,
    });

    try {
      // Cycle 1: RPC fails for market
      await poller.pollOnce();
      const status1 = poller.status();

      const marketTarget = status1.targets.find((t) => t.source === "market");
      if (!marketTarget) throw new Error("Missing market target in status");

      // Invariant 1: Cursor for failing target must NOT move or be wiped
      if (marketTarget.cursor !== makeDrillCursor(40)) {
        throw new Error(`Cursor moved during RPC failure: expected ${makeDrillCursor(40)}, got ${marketTarget.cursor}`);
      }
      details.push("Market target cursor preserved unchanged during RPC failure");

      // Invariant 2: Secrets and unbounded remote payloads must be redacted
      if (!status1.lastError) throw new Error("Expected status.lastError to be populated");
      if (status1.lastError.message.includes(SECRET_BOT_TOKEN)) {
        throw new Error("Bot token leaked in status.lastError");
      }
      if (status1.lastError.message.includes(SECRET_PRIVATE_KEY)) {
        throw new Error("Private key leaked in status.lastError");
      }
      if (status1.lastError.message.length > 250) {
        throw new Error(`Status error message not bounded: length ${status1.lastError.message.length}`);
      }
      for (const log of loggedErrors) {
        if (log.includes(SECRET_BOT_TOKEN) || log.includes(SECRET_PRIVATE_KEY)) {
          throw new Error("Secret leaked in console.error");
        }
      }
      details.push("Status error and console logs bounded and redacted (no secrets or unbounded payloads)");

      // Invariant 3: Health reflects degradation under consecutive failures
      const healthReport = buildHealthReport(config, status1);
      if (healthReport.poller.targets.find((t) => t.source === "market")?.hasError !== true) {
        throw new Error("Health report did not flag market target error");
      }
      details.push("Health report correctly flagged degraded target without leaking secrets");

      // Cycle 2: RPC recovers; queue new event at ledger 50
      rpcController.clearFailure();
      rpcController.queueEvents(config.marketContractId, [
        createMockClaimCreatedEvent({
          contractId: config.marketContractId,
          ledger: 50,
          claimId: 1,
          creator: "G" + "A".repeat(55),
          category: "crypto",
        }),
      ]);

      await poller.pollOnce();
      const status2 = poller.status();
      const recoveredMarket = status2.targets.find((t) => t.source === "market");

      if (!recoveredMarket) throw new Error("Missing market target after recovery");
      if (recoveredMarket.cursor === makeDrillCursor(40)) {
        throw new Error("Cursor failed to advance after RPC recovery");
      }
      if (recoveredMarket.lastEventLedger !== 50) {
        throw new Error(`lastEventLedger expected 50, got ${recoveredMarket.lastEventLedger}`);
      }
      if (status2.consecutiveFailures !== 0) {
        throw new Error(`consecutiveFailures not reset: ${status2.consecutiveFailures}`);
      }
      details.push("Poller recovered seamlessly, advanced cursor, and reset consecutive failures");

      return {
        name: "rpc-failure",
        passed: true,
        durationMs: Date.now() - start,
        details,
      };
    } finally {
      console.error = origError;
      poller.stop();
    }
  });
}

// ── 2. Telegram Failure Drill ────────────────────────────────────────────────

export async function runTelegramFailureDrill(): Promise<DrillScenarioResult> {
  const start = Date.now();
  const details: string[] = [];

  const initialCursor = JSON.stringify({
    version: 1,
    updatedAt: "2026-09-24T00:00:00.000Z",
    targets: {
      market: { cursor: makeDrillCursor(40), lastEventLedger: 40 },
      squad: { cursor: makeDrillCursor(40), lastEventLedger: 40 },
    },
  });

  return withTempCursorFile(initialCursor, async (cursorFile) => {
    const config = createDrillConfig(cursorFile);
    const rpcController = createFakeRpcServer(1, 45);
    const notifier = createFakeTelegramNotifier();

    // Queue event at ledger 45
    rpcController.queueEvents(config.marketContractId, [
      createMockClaimChallengedEvent({
        contractId: config.marketContractId,
        ledger: 45,
        claimId: 7,
        challenger: "G" + "B".repeat(55),
        stake: 20_000_000n,
      }),
    ]);

    // Telegram fails permanently for all 3 retry attempts
    const secretError = new Error(`Telegram HTTP 429 Too Many Requests: ${SECRET_BOT_TOKEN}`);
    notifier.setFailureMode("fail-always", 0, secretError);

    const loggedErrors: string[] = [];
    const origError = console.error;
    const origWarn = console.warn;
    console.error = (...args: unknown[]) => loggedErrors.push(args.join(" "));
    console.warn = (...args: unknown[]) => loggedErrors.push(args.join(" "));

    const poller: Poller = createPoller({
      config,
      server: rpcController.server,
      send: notifier.send,
      sleep: noopSleep,
    });

    try {
      // Cycle 1: Event notification fails send
      await poller.pollOnce();
      const status = poller.status();

      // Invariant 1: Telegram send failure is counted
      if (status.notificationsFailed !== 1) {
        throw new Error(`Expected 1 failed notification, got ${status.notificationsFailed}`);
      }
      details.push("Telegram send failure recorded in notificationsFailed");

      // Invariant 2: Cursor STILL ADVANCES (lossy delivery avoids infinite replay loops)
      const marketTarget = status.targets.find((t) => t.source === "market");
      if (!marketTarget?.cursor || marketTarget.cursor === makeDrillCursor(40)) {
        throw new Error("Cursor must still advance despite Telegram send failure to avoid infinite loops");
      }
      details.push("Cursor still advanced past failed notification (lossy Telegram delivery invariant)");

      // Invariant 3: Logs do not leak bot token
      for (const log of loggedErrors) {
        if (log.includes(SECRET_BOT_TOKEN)) {
          throw new Error("Bot token leaked in Telegram failure error logs");
        }
      }
      details.push("Telegram retry and failure logs redacted secret tokens");

      // Cycle 2: Telegram recovers, queue next event at ledger 46
      notifier.setFailureMode("ok");
      rpcController.setHealth(1, 46);
      rpcController.queueEvents(config.marketContractId, [
        createMockClaimCreatedEvent({
          contractId: config.marketContractId,
          ledger: 46,
          claimId: 8,
          creator: "G" + "C".repeat(55),
          category: "crypto",
        }),
      ]);

      await poller.pollOnce();
      const status2 = poller.status();

      // Invariant 4: No infinite replay of ledger 45; ledger 46 is sent
      if (status2.notificationsSent !== 1) {
        throw new Error(`Expected 1 notification sent on recovery, got ${status2.notificationsSent}`);
      }
      if (notifier.sent.length !== 1) {
        throw new Error(`Expected exactly 1 sent message in Telegram, got ${notifier.sent.length}`);
      }
      details.push("Recovered cycle notified only new events; failed event was not replayed infinitely");

      return {
        name: "telegram-failure",
        passed: true,
        durationMs: Date.now() - start,
        details,
      };
    } finally {
      console.error = origError;
      console.warn = origWarn;
      poller.stop();
    }
  });
}

// ── 3. Stale Cursor Drill ────────────────────────────────────────────────────

export async function runStaleCursorDrill(): Promise<DrillScenarioResult> {
  const start = Date.now();
  const details: string[] = [];

  const staleCursor = makeDrillCursor(10);
  const initialCursor = JSON.stringify({
    version: 1,
    updatedAt: "2026-09-24T00:00:00.000Z",
    targets: {
      market: { cursor: staleCursor, lastEventLedger: 10 },
      squad: { cursor: makeDrillCursor(50), lastEventLedger: 50 },
    },
  });

  return withTempCursorFile(initialCursor, async (cursorFile) => {
    const config = createDrillConfig(cursorFile);
    // Chain has moved far ahead; oldest retained is 1000
    const rpcController = createFakeRpcServer(1000, 2000);
    const notifier = createFakeTelegramNotifier();

    // RPC rejects the stale cursor
    rpcController.setFailure((req) => {
      if (req.cursor === staleCursor) {
        return new Error("start ledger 10 is before oldest ledger 1000");
      }
      return null;
    });

    const poller: Poller = createPoller({
      config,
      server: rpcController.server,
      send: notifier.send,
      sleep: noopSleep,
    });

    try {
      await poller.pollOnce();
      const status = poller.status();
      const marketTarget = status.targets.find((t) => t.source === "market");

      // Invariant 1: Stale cursor is preserved, NOT guess-reset to an arbitrary ledger
      if (marketTarget?.cursor !== staleCursor) {
        throw new Error(`Stale cursor was modified or wiped: ${marketTarget?.cursor}`);
      }
      details.push("Stale cursor preserved without guessing or rewinding");

      // Invariant 2: Bounded error reported in status and health
      if (!status.lastError?.message.includes("oldest ledger 1000")) {
        throw new Error("Expected stale cursor error reported in status.lastError");
      }
      const health = buildHealthReport(config, status);
      if (health.poller.targets.find((t) => t.source === "market")?.hasError !== true) {
        throw new Error("Health report did not reflect degraded market target");
      }
      details.push("Actionable error exposed in status and health report");

      // Invariant 3: Persisted cursor file on disk remains valid version 1 with original cursor
      const diskContent = JSON.parse(await readFile(cursorFile, "utf8"));
      if (diskContent.version !== 1 || diskContent.targets?.market?.cursor !== staleCursor) {
        throw new Error("Disk cursor file corrupted or modified during stale cursor handling");
      }
      details.push("Cursor file compatibility (version 1) preserved on disk");

      return {
        name: "stale-cursor",
        passed: true,
        durationMs: Date.now() - start,
        details,
      };
    } finally {
      poller.stop();
    }
  });
}

// ── 4. Corrupt Cursor Drill ──────────────────────────────────────────────────

export async function runCorruptCursorDrill(): Promise<DrillScenarioResult> {
  const start = Date.now();
  const details: string[] = [];

  const corruptContent = "CORRUPT_NOT_JSON_BINARY_GARBAGE\x00\x01\x02";

  return withTempCursorFile(corruptContent, async (cursorFile) => {
    const config = createDrillConfig(cursorFile, { startLookbackLedgers: 20 });
    const rpcController = createFakeRpcServer(100, 200);
    const notifier = createFakeTelegramNotifier();

    const loggedWarnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => loggedWarnings.push(args.join(" "));

    const poller: Poller = createPoller({
      config,
      server: rpcController.server,
      send: notifier.send,
      sleep: noopSleep,
    });

    try {
      // Invariant 1: Unreadable cursor triggers safe cold-start fallback rather than crashing
      await poller.pollOnce();
      const status = poller.status();

      if (status.running !== true) {
        throw new Error("Poller failed to run after encountering corrupt cursor file");
      }
      if (!loggedWarnings.some((w) => w.includes("cursor file unreadable, starting cold"))) {
        throw new Error("Missing cold start warning on corrupt cursor file");
      }
      details.push("Corrupt cursor treated as safe cold start without crashing");

      // Invariant 2: Poller heals cursor file on save with valid version 1 shape
      const diskRaw = await readFile(cursorFile, "utf8");
      const diskParsed = JSON.parse(diskRaw);
      if (diskParsed.version !== 1) {
        throw new Error(`Persisted cursor file has invalid version: ${diskParsed.version}`);
      }
      if (!diskParsed.targets?.market || !diskParsed.targets?.squad) {
        throw new Error("Persisted cursor file missing target definitions");
      }
      details.push("Cursor file healed and rewritten with valid version-1 structure");

      return {
        name: "corrupt-cursor",
        passed: true,
        durationMs: Date.now() - start,
        details,
      };
    } finally {
      console.warn = origWarn;
      poller.stop();
    }
  });
}

// ── 5. Malformed Event Drill ─────────────────────────────────────────────────

export async function runMalformedEventDrill(): Promise<DrillScenarioResult> {
  const start = Date.now();
  const details: string[] = [];

  return withTempCursorFile(null, async (cursorFile) => {
    const config = createDrillConfig(cursorFile);
    const rpcController = createFakeRpcServer(1, 100);
    const notifier = createFakeTelegramNotifier();

    // Queue 1 malformed event followed by 1 valid event
    rpcController.queueEvents(config.marketContractId, [
      createMockMalformedEvent({
        contractId: config.marketContractId,
        ledger: 50,
        index: 0,
        eventName: "claim_challenged",
        reason: "corrupted topic type",
      }),
      createMockClaimCreatedEvent({
        contractId: config.marketContractId,
        ledger: 50,
        index: 1,
        claimId: 99,
        creator: "G" + "D".repeat(55),
        category: "crypto",
      }),
    ]);

    const poller: Poller = createPoller({
      config,
      server: rpcController.server,
      send: notifier.send,
      sleep: noopSleep,
    });

    try {
      await poller.pollOnce();
      const status = poller.status();

      // Invariant 1: Malformed event safely decoded as unknown and skipped
      if (status.eventsSkipped !== 1) {
        throw new Error(`Expected 1 event skipped, got ${status.eventsSkipped}`);
      }
      details.push("Malformed event safely detected, logged, and skipped");

      // Invariant 2: Valid event is notified
      if (status.notificationsSent !== 1) {
        throw new Error(`Expected 1 notification sent, got ${status.notificationsSent}`);
      }
      if (notifier.sent.length !== 1 || !notifier.sent[0]?.includes("New claim")) {
        throw new Error("Valid event was not notified");
      }
      details.push("Subsequent valid event in the same ledger successfully notified");

      // Invariant 3: Cursor moves past malformed event to latest ledger
      const marketTarget = status.targets.find((t) => t.source === "market");
      if (marketTarget?.lastEventLedger !== 50) {
        throw new Error(`lastEventLedger expected 50, got ${marketTarget?.lastEventLedger}`);
      }
      details.push("Cursor safely advanced past malformed event without blocking queue");

      return {
        name: "malformed-event",
        passed: true,
        durationMs: Date.now() - start,
        details,
      };
    } finally {
      poller.stop();
    }
  });
}

// ── 6. Rate Limit / Burst Drill ──────────────────────────────────────────────

export async function runRateLimitDrill(): Promise<DrillScenarioResult> {
  const start = Date.now();
  const details: string[] = [];

  const initialCursor = JSON.stringify({
    version: 1,
    updatedAt: "2026-09-24T00:00:00.000Z",
    targets: {
      market: { cursor: makeDrillCursor(40), lastEventLedger: 40 },
      squad: { cursor: makeDrillCursor(40), lastEventLedger: 40 },
    },
  });

  return withTempCursorFile(initialCursor, async (cursorFile) => {
    const maxPerCycle = 10;
    const config = createDrillConfig(cursorFile, { maxNotificationsPerCycle: maxPerCycle });
    const rpcController = createFakeRpcServer(1, 100);
    const notifier = createFakeTelegramNotifier();

    // Queue a burst of 25 events starting at ledger 41
    const burstEvents: rpc.Api.EventResponse[] = [];
    for (let i = 1; i <= 25; i++) {
      burstEvents.push(
        createMockClaimCreatedEvent({
          contractId: config.marketContractId,
          ledger: 40 + i,
          claimId: i,
          creator: "G" + "E".repeat(55),
          category: "crypto",
        }),
      );
    }
    rpcController.queueEvents(config.marketContractId, burstEvents);

    const poller: Poller = createPoller({
      config,
      server: rpcController.server,
      send: notifier.send,
      sleep: noopSleep,
    });

    try {
      await poller.pollOnce();
      const status = poller.status();

      // Invariant 1: Cycle notification cap is strictly enforced
      if (status.notificationsSent !== maxPerCycle) {
        throw new Error(`Expected exactly ${maxPerCycle} sent notifications, got ${status.notificationsSent}`);
      }
      if (notifier.sent.length !== maxPerCycle) {
        throw new Error(`Expected exactly ${maxPerCycle} Telegram calls, got ${notifier.sent.length}`);
      }
      details.push(`Notification burst strictly bounded by maxNotificationsPerCycle (${maxPerCycle})`);

      // Invariant 2: Remaining events in the burst are counted as skipped
      const expectedSkipped = 25 - maxPerCycle;
      if (status.eventsSkipped !== expectedSkipped) {
        throw new Error(`Expected ${expectedSkipped} skipped events, got ${status.eventsSkipped}`);
      }
      details.push(`${expectedSkipped} overflowing events skipped to prevent chat flooding`);

      // Invariant 3: Cursor advances to the latest ledger (ledger 65) to avoid infinite loops
      const marketTarget = status.targets.find((t) => t.source === "market");
      if (marketTarget?.lastEventLedger !== 65) {
        throw new Error(`Expected lastEventLedger 65, got ${marketTarget?.lastEventLedger}`);
      }
      details.push("Cursor moved to highest burst ledger to avoid re-notifying burst on next cycle");

      return {
        name: "rate-limit",
        passed: true,
        durationMs: Date.now() - start,
        details,
      };
    } finally {
      poller.stop();
    }
  });
}

// ── 7. Restart & Operator Pause Drill ────────────────────────────────────────

export async function runRestartDrill(): Promise<DrillScenarioResult> {
  const start = Date.now();
  const details: string[] = [];

  const initialCursor = JSON.stringify({
    version: 1,
    updatedAt: "2026-09-24T00:00:00.000Z",
    targets: {
      market: { cursor: makeDrillCursor(60), lastEventLedger: 60 },
      squad: { cursor: makeDrillCursor(70), lastEventLedger: 70 },
    },
  });

  return withTempCursorFile(initialCursor, async (cursorFile) => {
    const config = createDrillConfig(cursorFile);
    const rpcController = createFakeRpcServer(1, 100);
    const notifier = createFakeTelegramNotifier();

    const poller1: Poller = createPoller({
      config,
      server: rpcController.server,
      send: notifier.send,
      sleep: noopSleep,
    });

    let expectedMarket: string | null = null;
    let expectedSquad: string | null = null;

    try {
      await poller1.pollOnce();
      if (poller1.status().paused !== false) throw new Error("Poller 1 should start unpaused");

      const savedStatus = poller1.status();
      expectedMarket = savedStatus.targets.find((t) => t.source === "market")?.cursor ?? null;
      expectedSquad = savedStatus.targets.find((t) => t.source === "squad")?.cursor ?? null;

      // Operator pauses poller
      const pauseResult = poller1.pause();
      if (pauseResult !== "paused" || poller1.status().paused !== true) {
        throw new Error("Failed to pause poller");
      }
      details.push("Operator pause successfully applied to poller");

      // Invariant 1: Operator pause must NOT mutate version-1 cursor file
      const raw = await readFile(cursorFile, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed.version !== 1 || (parsed as unknown as { paused?: unknown }).paused !== undefined) {
        throw new Error("Cursor file structure mutated by operator pause");
      }
      details.push("Cursor file remains strict version 1 without persisting pause state");
    } finally {
      poller1.stop();
    }

    // Simulate process restart: create a new poller instance with the same cursor file
    const poller2: Poller = createPoller({
      config,
      server: rpcController.server,
      send: notifier.send,
      sleep: noopSleep,
    });

    try {
      await poller2.pollOnce();
      const status2 = poller2.status();

      // Invariant 2: Process restart starts unpaused (pause state is process-local)
      if (status2.paused !== false) {
        throw new Error("Poller 2 remained paused across process restart");
      }
      if (status2.running !== true) {
        throw new Error("Poller 2 not running after restart");
      }
      details.push("Process restart resumes polling automatically (pause state does not persist across deploys)");

      // Invariant 3: Persisted cursors loaded cleanly
      const market = status2.targets.find((t) => t.source === "market");
      const squad = status2.targets.find((t) => t.source === "squad");
      if (market?.cursor !== expectedMarket || squad?.cursor !== expectedSquad) {
        throw new Error("Saved cursors not loaded properly across restart");
      }
      details.push("Saved cursors reloaded accurately from persistent storage");

      return {
        name: "restart",
        passed: true,
        durationMs: Date.now() - start,
        details,
      };
    } finally {
      poller2.stop();
    }
  });
}

// ── 8. Scanner Diagnostic Drill ──────────────────────────────────────────────

export async function runScannerDiagnosticDrill(): Promise<DrillScenarioResult> {
  const start = Date.now();
  const details: string[] = [];

  const rpcController = createFakeRpcServer(100, 200);
  const target: WatchTarget = {
    source: "market",
    contractId: "CFIXTUREMARKET00000000000000000000000000000000000000000",
  };

  // Soroban RPC pattern: empty pages before reaching the event page
  rpcController.setEmptyPagesUntilEvents(2);
  rpcController.queueEvents(target.contractId, [
    createMockClaimCreatedEvent({
      contractId: target.contractId,
      ledger: 150,
      claimId: 10,
      creator: "G" + "F".repeat(55),
      category: "crypto",
    }),
  ]);

  // Invariant 1: Scanner operates without any Telegram token or credentials
  const scan = await readContractEvents(rpcController.server, target, {
    startLedger: 100,
    maxPages: 5,
  });

  if (scan.pages < 3) {
    throw new Error(`Expected at least 3 pages walked through empty pages, got ${scan.pages}`);
  }
  if (scan.events.length !== 1) {
    throw new Error(`Expected 1 event decoded, got ${scan.events.length}`);
  }
  if (scan.lastEventLedger !== 150) {
    throw new Error(`Expected lastEventLedger 150, got ${scan.lastEventLedger}`);
  }
  details.push("Scanner correctly walked multiple empty Soroban pages without premature exit");
  details.push("Scanner executed purely read-only without requiring signing keys or bot credentials");

  return {
    name: "scanner-diagnostic",
    passed: true,
    durationMs: Date.now() - start,
    details,
  };
}

// ── Drill Suite Orchestrator ─────────────────────────────────────────────────

const SCENARIO_RUNNERS: Record<DrillScenarioName, () => Promise<DrillScenarioResult>> = {
  "rpc-failure": runRpcFailureDrill,
  "telegram-failure": runTelegramFailureDrill,
  "stale-cursor": runStaleCursorDrill,
  "corrupt-cursor": runCorruptCursorDrill,
  "malformed-event": runMalformedEventDrill,
  "rate-limit": runRateLimitDrill,
  restart: runRestartDrill,
  "scanner-diagnostic": runScannerDiagnosticDrill,
};

export async function runIncidentDrill(options: DrillOptions = {}): Promise<DrillReport> {
  const selected = options.scenario ?? "all";
  const scenarioNames: DrillScenarioName[] =
    selected === "all"
      ? (Object.keys(SCENARIO_RUNNERS) as DrillScenarioName[])
      : [selected];

  const results: DrillScenarioResult[] = [];
  const start = Date.now();

  for (const name of scenarioNames) {
    const runner = SCENARIO_RUNNERS[name];
    if (!runner) {
      results.push({
        name,
        passed: false,
        durationMs: 0,
        details: [],
        error: `Unknown scenario: ${name}`,
      });
      continue;
    }

    try {
      const res = await runner();
      results.push(res);
    } catch (err) {
      results.push({
        name,
        passed: false,
        durationMs: 0,
        details: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const passedScenarios = results.filter((r) => r.passed).length;
  const failedScenarios = results.length - passedScenarios;

  return {
    passed: failedScenarios === 0,
    totalScenarios: results.length,
    passedScenarios,
    failedScenarios,
    totalDurationMs: Date.now() - start,
    results,
  };
}

// ── CLI Runner ───────────────────────────────────────────────────────────────

export async function runIncidentDrillCli(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Mimir Incident Drill Runner
Usage: npm run drill [-- [options]]
       npm run scan -- --drill

Options:
  --scenario <name>   Run a specific scenario (default: all)
                      Scenarios: ${Object.keys(SCENARIO_RUNNERS).join(", ")}
  --json              Output machine-readable JSON report
  --verbose           Show detailed invariant checks
  --help, -h          Show this help message
`);
    return;
  }

  const scenarioIndex = args.indexOf("--scenario");
  const scenarioArg = scenarioIndex !== -1 ? args[scenarioIndex + 1] : undefined;
  const scenario = (scenarioArg as DrillScenarioName | "all") ?? "all";
  const isJson = args.includes("--json");
  const isVerbose = args.includes("--verbose") || !isJson;

  const report = await runIncidentDrill({ scenario, json: isJson, verbose: isVerbose });

  if (isJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log("\n=======================================================");
    console.log("   Mimir Notifier Incident Drill Simulation");
    console.log("=======================================================");
    console.log("Operating Principles verified:");
    console.log("  * Chain state is the source of truth");
    console.log("  * Notifier is strictly read-only (no signing keys)");
    console.log("  * Bounded cursor movement and safe error redaction");
    console.log("-------------------------------------------------------\n");

    for (const res of report.results) {
      const tag = res.passed ? "[PASS]" : "[FAIL]";
      console.log(`${tag} ${res.name} (${res.durationMs}ms)`);
      if (res.error) {
        console.error(`       Error: ${res.error}`);
      }
      for (const d of res.details) {
        console.log(`       - ${d}`);
      }
    }

    console.log("\n-------------------------------------------------------");
    console.log(
      `Summary: ${report.passedScenarios} passed, ${report.failedScenarios} failed in ${report.totalDurationMs}ms`,
    );
    console.log("=======================================================\n");
  }

  if (!report.passed) {
    process.exit(1);
  }
}

// Only when executed directly via CLI
const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  runIncidentDrillCli().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
