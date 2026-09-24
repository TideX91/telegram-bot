/**
 * The poll loop: read new contract events, notify, persist the cursor.
 *
 * ── Failure policy ───────────────────────────────────────────────────────────
 *
 * This process is meant to stay up for weeks. Nothing in one cycle may end it:
 *
 *  - A failed RPC call fails ONE contract's scan for ONE cycle. Its cursor is
 *    left untouched, so the next cycle picks up exactly where it stopped.
 *  - A failed Telegram send drops ONE message. The cursor still advances.
 *    That is deliberate: holding the cursor back on a send failure means a
 *    broken bot token or a chat the bot was kicked from turns into an infinite
 *    replay of the same events forever, and recovering floods the channel.
 *    Notifications are lossy by design; the chain remains the record.
 *  - A cursor file that cannot be read is treated as a cold start; one that
 *    cannot be written is logged, and the in-memory cursor keeps working until
 *    the next restart.
 *  - A persisted cursor that has fallen BELOW the RPC's retained window — a
 *    restart (or a run of RPC failures) longer than the window — is detected
 *    against the retained floor, reported once, and reset to a cold start.
 *    The events in that gap are already unrecoverable: the RPC does not retain
 *    them. Retrying the stale cursor forever is the one answer that is never
 *    right, because it wedges the target until someone edits the file by hand.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { rpc } from "@stellar/stellar-sdk";

import type { BotConfig } from "./config.js";
import { formatEvent } from "./notifications/format.js";
import { eventCursorLedger, readContractEvents, type WatchTarget } from "./stellar/events.js";
import type { ContractSource, DecodedEvent } from "./stellar/decode.js";

export interface TargetState {
  source: ContractSource;
  contractId: string;
  cursor: string | null;
  /** Highest ledger an event was seen in, from this run or the cursor file. */
  lastEventLedger: number | null;
  /**
   * Ledgers whose events were lost because the persisted cursor sat below the
   * RPC's retained floor. `0` until a restart gap is detected for this target.
   */
  gapLedgers: number;
  /**
   * When a stale cursor was reset to a cold start, or `null` if that has never
   * happened for this target.
   */
  cursorResetAt: number | null;
  /**
   * A cursor is persisted but its ledger cannot be parsed. It is left untouched
   * (the RPC still gets to accept or reject it) and surfaced for operators.
   */
  cursorUnreadable: boolean;
  lastError: string | null;
}

/**
 * A resume position that fell out of the RPC's retained window: the events
 * between the cursor and the retained floor are gone for good.
 */
export interface RestartGap {
  /** When the gap was detected. */
  at: number;
  source: ContractSource;
  /** Ledger the persisted cursor pointed at. */
  cursorLedger: number;
  /** The RPC's retained floor at detection time. */
  oldestLedger: number;
  /** Ledgers whose events are unrecoverable (`oldestLedger - cursorLedger`). */
  missedLedgers: number;
}

export interface PollerStatus {
  running: boolean;
  startedAt: number;
  cycles: number;
  lastPollAt: number | null;
  lastSuccessAt: number | null;
  latestLedger: number | null;
  oldestLedger: number | null;
  notificationsSent: number;
  notificationsFailed: number;
  eventsSkipped: number;
  consecutiveFailures: number;
  lastError: { at: number; message: string } | null;
  /** How many times a stale cursor has been reset since this process started. */
  restartGaps: number;
  /** Details of the most recent restart gap, or `null` when none was seen. */
  lastRestartGap: RestartGap | null;
  targets: TargetState[];
}

interface CursorFile {
  version: 1;
  updatedAt: string;
  targets: Record<string, { cursor: string | null; lastEventLedger: number | null }>;
}

export interface PollerDeps {
  config: BotConfig;
  server: rpc.Server;
  /** Sends one already-formatted MarkdownV2 message. May reject. */
  send: (text: string) => Promise<void>;
  /** Optional clock for deterministic tests. */
  now?: () => number;
}

/**
 * Where a persisted cursor sits relative to the RPC's retained window.
 *
 * The RPC only keeps a rolling window of events, so a resume position can be
 * *older* than the oldest ledger it still serves. That is not an error in the
 * cursor — the cursor is exactly where it said it was — but the events between
 * it and the floor can never be read again, and the next scan must not pretend
 * otherwise.
 */
export type CursorWindowVerdict =
  | { status: "no-cursor" }
  | { status: "unknown-floor" }
  | { status: "unreadable"; cursor: string }
  | { status: "inside"; cursorLedger: number; behind: number }
  | { status: "stale"; cursorLedger: number; missedLedgers: number };

/**
 * Classify a cursor against the retained floor. Pure so the boundary cases
 * (cursor exactly at the floor, an unparseable cursor, an unknown floor) are
 * testable without an RPC.
 */
export function classifyCursorWindow(
  cursor: string | null,
  oldestLedger: number | null,
): CursorWindowVerdict {
  if (cursor === null || cursor === "") return { status: "no-cursor" };
  if (oldestLedger === null || !Number.isFinite(oldestLedger) || oldestLedger <= 0) {
    return { status: "unknown-floor" };
  }

  const cursorLedger = eventCursorLedger(cursor);
  if (cursorLedger === null) return { status: "unreadable", cursor };

  // Exactly at the floor is still inside the window: that ledger is retained.
  if (cursorLedger < oldestLedger) {
    return { status: "stale", cursorLedger, missedLedgers: oldestLedger - cursorLedger };
  }
  return { status: "inside", cursorLedger, behind: cursorLedger - oldestLedger };
}

/** Telegram tolerates ~20 messages/minute to one chat; stay under it. */
const SEND_SPACING_MS = 1_500;

/** Maximum number of retry attempts for a single Telegram send. */
const MAX_SEND_RETRIES = 3;

/** Initial backoff in milliseconds for Telegram send retries. */
const INITIAL_BACKOFF_MS = 1_000;

/** Maximum backoff in milliseconds for Telegram send retries. */
const MAX_BACKOFF_MS = 10_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Sends a message with bounded exponential backoff.
 *
 * If the Telegram API is temporarily unavailable (rate limit, network error,
 * or bad token), we retry a few times with increasing delays. This prevents
 * transient failures from dropping notifications while avoiding infinite
 * retries that would block the poller loop.
 */
async function sendWithRetry(
  send: (text: string) => Promise<void>,
  text: string,
): Promise<void> {
  let attempt = 0;
  let backoff = INITIAL_BACKOFF_MS;

  while (true) {
    try {
      await send(text);
      return;
    } catch (err) {
      attempt++;
      if (attempt >= MAX_SEND_RETRIES) {
        throw err; // Exhausted retries
      }
      console.warn(
        `[poller] send attempt ${attempt} failed, retrying in ${backoff}ms: ` +
          errMessage(err),
      );
      await sleep(backoff);
      // Exponential backoff with cap
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
  }
}

export function createPoller(deps: PollerDeps) {
  const { config, server, send } = deps;
  /** Injectable for deterministic tests; the process clock otherwise. */
  const now = deps.now ?? Date.now;

  const targets: WatchTarget[] = [
    { source: "market", contractId: config.marketContractId },
    { source: "squad", contractId: config.squadContractId },
  ];

  const state = new Map<ContractSource, TargetState>(
    targets.map((t) => [
      t.source,
      {
        source: t.source,
        contractId: t.contractId,
        cursor: null,
        lastEventLedger: null,
        gapLedgers: 0,
        cursorResetAt: null,
        cursorUnreadable: false,
        lastError: null,
      },
    ]),
  );

  const status: PollerStatus = {
    running: false,
    startedAt: 0,
    cycles: 0,
    lastPollAt: null,
    lastSuccessAt: null,
    latestLedger: null,
    oldestLedger: null,
    notificationsSent: 0,
    notificationsFailed: 0,
    eventsSkipped: 0,
    consecutiveFailures: 0,
    lastError: null,
    restartGaps: 0,
    lastRestartGap: null,
    targets: [],
  };

  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let inFlight = false;

  // ── Cursor persistence ─────────────────────────────────────────────────────

  async function loadCursors(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(config.cursorFile, "utf8");
    } catch {
      console.log(
        `[poller] no cursor file at ${config.cursorFile}; cold start ` +
          `${config.startLookbackLedgers} ledgers behind the tip`,
      );
      return;
    }

    try {
      const parsed = JSON.parse(raw) as CursorFile;
      for (const [source, saved] of Object.entries(parsed.targets ?? {})) {
        const target = state.get(source as ContractSource);
        if (!target) continue;
        target.cursor = saved.cursor ?? null;
        target.lastEventLedger = saved.lastEventLedger ?? null;
      }
      console.log(
        `[poller] resumed from ${config.cursorFile}: ` +
          [...state.values()].map((t) => `${t.source}@${t.cursor ?? "none"}`).join(" "),
      );
    } catch (err) {
      // A corrupt state file must not wedge the bot; a cold start is recoverable.
      console.warn(`[poller] cursor file unreadable, starting cold: ${errMessage(err)}`);
    }
  }

  async function saveCursors(): Promise<void> {
    const payload: CursorFile = {
      version: 1,
      updatedAt: new Date(now()).toISOString(),
      targets: Object.fromEntries(
        [...state.values()].map((t) => [
          t.source,
          { cursor: t.cursor, lastEventLedger: t.lastEventLedger },
        ]),
      ),
    };

    try {
      await mkdir(path.dirname(config.cursorFile), { recursive: true });
      // Write-then-rename: a crash mid-write must not leave a truncated file
      // that sends the next start back to the beginning of the retained window.
      const tmp = `${config.cursorFile}.tmp`;
      await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      await rename(tmp, config.cursorFile);
    } catch (err) {
      console.error(`[poller] could not persist cursor: ${errMessage(err)}`);
    }
  }

  // ── Restart-gap detection ──────────────────────────────────────────────────

  /**
   * Refresh the RPC's ledger window, best-effort. Returns the retained floor,
   * or `null` when the RPC cannot be reached — probing must never end the
   * process, because the poller exists to survive exactly this.
   */
  async function probeFloor(): Promise<number | null> {
    try {
      const health = await server.getHealth();
      status.latestLedger = health.latestLedger;
      status.oldestLedger = health.oldestLedger;
      return health.oldestLedger;
    } catch (err) {
      console.warn(`[poller] could not read the RPC ledger window: ${errMessage(err)}`);
      return null;
    }
  }

  /**
   * Compare one target's resume position with the retained floor and, when the
   * cursor has fallen out of the window, reset it to a cold start.
   *
   * Reset — rather than "start from the floor" — is deliberate: the retained
   * window is up to a week of events and replaying it into the chat is the
   * flood this bot's cold-start lookback exists to avoid. `MAX_NOTIFICATIONS_
   * PER_CYCLE` still bounds what a cold start can post.
   *
   * Detection is reported once per gap, not once per cycle: the cursor is reset
   * on the first detection, so a target can only be stale again after another
   * restart (or another RPC outage) leaves it behind a floor that has moved on.
   */
  function enforceCursorWindow(current: TargetState, oldestLedger: number | null): void {
    if (oldestLedger === null) return;

    const verdict = classifyCursorWindow(current.cursor, oldestLedger);

    if (verdict.status === "unreadable") {
      if (!current.cursorUnreadable) {
        current.cursorUnreadable = true;
        console.warn(
          `[poller] ${current.source}: persisted cursor has no readable ledger position; ` +
            `leaving it untouched and letting the RPC accept or reject it`,
        );
      }
      return;
    }
    current.cursorUnreadable = false;
    if (verdict.status !== "stale") return;

    const at = now();
    current.cursor = null;
    current.gapLedgers = verdict.missedLedgers;
    current.cursorResetAt = at;
    status.restartGaps += 1;
    status.lastRestartGap = {
      at,
      source: current.source,
      cursorLedger: verdict.cursorLedger,
      oldestLedger,
      missedLedgers: verdict.missedLedgers,
    };
    console.warn(
      `[poller] ${current.source}: restart gap — cursor at ledger ${verdict.cursorLedger} ` +
        `is ${verdict.missedLedgers} ledger(s) below the RPC retained floor ${oldestLedger}; ` +
        `those events are unrecoverable, so the cursor is reset to a cold start ` +
        `(up to ${config.startLookbackLedgers} ledgers behind the tip)`,
    );
  }

  // ── One cycle ──────────────────────────────────────────────────────────────

  async function notify(events: DecodedEvent[]): Promise<void> {
    let sentThisCycle = 0;

    for (const event of events) {
      if (event.payload.name === "unknown") {
        status.eventsSkipped += 1;
        console.log(
          `[poller] skipped ${event.source} event "${event.payload.eventName}" ` +
            `at ledger ${event.ledger}${event.payload.reason ? ` (${event.payload.reason})` : ""}`,
        );
        continue;
      }

      const text = formatEvent(config, event);
      if (text === null) {
        status.eventsSkipped += 1;
        continue;
      }

      if (sentThisCycle >= config.maxNotificationsPerCycle) {
        status.eventsSkipped += 1;
        console.warn(
          `[poller] cycle notification cap (${config.maxNotificationsPerCycle}) reached; ` +
            `dropping ${event.payload.name} at ledger ${event.ledger}`,
        );
        continue;
      }

      try {
        // Use bounded retry for Telegram sends to handle transient failures
        await sendWithRetry(send, text);
        status.notificationsSent += 1;
        sentThisCycle += 1;
      } catch (err) {
        // All retries exhausted; drop the message but continue processing others.
        status.notificationsFailed += 1;
        console.error(
          `[poller] send failed for ${event.payload.name} at ledger ${event.ledger} after retries: ` +
            errMessage(err),
        );
      }

      if (sentThisCycle < config.maxNotificationsPerCycle) await sleep(SEND_SPACING_MS);
    }
  }

  async function cycle(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    status.cycles += 1;
    status.lastPollAt = now();

    let anyOk = false;

    for (const target of targets) {
      const current = state.get(target.source);
      if (!current) continue;

      // A cursor left below the retained floor makes every scan fail the same
      // way, so check it against the last known floor before asking. The floor
      // is refreshed on the failure path below, which is what catches a window
      // that rolled past us while the scans were failing.
      enforceCursorWindow(current, status.oldestLedger);

      try {
        const scan = await readContractEvents(server, target, {
          cursor: current.cursor ?? undefined,
          lookbackLedgers: current.cursor ? undefined : config.startLookbackLedgers,
        });

        status.latestLedger = scan.latestLedger;
        status.oldestLedger = scan.oldestLedger;
        current.lastError = null;
        anyOk = true;

        if (scan.events.length > 0) {
          console.log(
            `[poller] ${target.source}: ${scan.events.length} event(s) ` +
              `up to ledger ${scan.lastEventLedger} in ${scan.pages} page(s)`,
          );
          await notify(scan.events);
        }

        if (scan.lastEventLedger !== null) current.lastEventLedger = scan.lastEventLedger;
        // Advance last — see the failure policy at the top of this file.
        if (scan.cursor) {
          current.cursor = scan.cursor;
          // The RPC accepted the resume position and moved it, so whatever we
          // could not read locally is no longer the position we hold.
          current.cursorUnreadable = false;
        }
      } catch (err) {
        const message = errMessage(err);
        current.lastError = message;
        status.lastError = { at: now(), message: `${target.source}: ${message}` };
        console.error(`[poller] ${target.source} scan failed: ${message}`);

        // A scan failing is exactly when the floor is unknown or has moved —
        // read it, then give a now-stale cursor its one bounded recovery
        // instead of retrying the same ledger every cycle forever.
        enforceCursorWindow(current, await probeFloor());
      }
    }

    if (anyOk) {
      status.lastSuccessAt = now();
      status.consecutiveFailures = 0;
    } else {
      status.consecutiveFailures += 1;
    }

    status.targets = [...state.values()].map((t) => ({ ...t }));
    await saveCursors();
    inFlight = false;
  }

  async function loop(): Promise<void> {
    if (stopped) return;
    try {
      await cycle();
    } catch (err) {
      // Belt and braces: `cycle` already swallows per-target failures, so this
      // only fires on a bug. Either way the loop survives it.
      status.consecutiveFailures += 1;
      status.lastError = { at: now(), message: errMessage(err) };
      console.error(`[poller] cycle threw: ${errMessage(err)}`);
      inFlight = false;
    }
    if (stopped) return;
    timer = setTimeout(() => void loop(), config.pollIntervalMs);
  }

  return {
    async start(): Promise<void> {
      await loadCursors();
      status.running = true;
      status.startedAt = now();

      // One bounded probe at boot so a cursor that fell out of the retained
      // window is reported (with the ledgers it lost) instead of showing up as
      // a scan that fails every cycle. An unreachable RPC is not fatal here:
      // the loop below retries, and `cycle` re-probes on failure.
      const floor = await probeFloor();
      for (const current of state.values()) enforceCursorWindow(current, floor);

      status.targets = [...state.values()].map((t) => ({ ...t }));
      console.log(
        `[poller] watching market=${config.marketContractId} squad=${config.squadContractId} ` +
          `every ${config.pollIntervalMs}ms`,
      );
      void loop();
    },

    stop(): void {
      stopped = true;
      status.running = false;
      if (timer) clearTimeout(timer);
      timer = null;
    },

    status(): PollerStatus {
      return { ...status, targets: [...state.values()].map((t) => ({ ...t })) };
    },
  };
}

export type Poller = ReturnType<typeof createPoller>;