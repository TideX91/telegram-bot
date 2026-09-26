/**
 * Read contract events from Soroban RPC, cursor-paginated.
 *
 * ── Why this is not a block-range scan ───────────────────────────────────────
 *
 * The instinct carried over from EVM is `eth_getLogs(fromBlock, toBlock)`:
 * addressable, chunkable, parallelisable, and done when a page comes back
 * short. Soroban's `getEvents` is none of those things:
 *
 *  - It returns an opaque `cursor` that must be fed into the next request, so
 *    the walk is inherently SEQUENTIAL. There is no chunk fan-out to tune.
 *  - `startLedger`/`endLedger` and `cursor` are MUTUALLY EXCLUSIVE in the
 *    request; sending both is rejected. Hence the two request shapes below.
 *  - The RPC keeps only a ROLLING WINDOW of events (~120_960 ledgers, about a
 *    week, on Testnet). A `startLedger` below the retained `oldestLedger` is an
 *    ERROR, not an empty result — so the floor is clamped from `getHealth()`
 *    before the first request. This is also why event history can never be the
 *    source of truth for current state.
 *  - **AN EMPTY PAGE DOES NOT MEAN THE SCAN IS DONE.** This is the trap. One
 *    request scans a bounded slice of ledgers and returns whatever it found
 *    there — frequently nothing — plus a cursor to carry on from. Stopping on a
 *    short or empty page (correct for `eth_getLogs`) silently returns zero
 *    events for any contract whose activity is far past the scan floor.
 *
 * So the walk terminates on the CURSOR, not on the payload: when the cursor
 * stops advancing, runs out, or passes the end of the requested range.
 *
 * ── Difference from a one-shot scan ──────────────────────────────────────────
 *
 * This reader is built for TAILING, so it returns the last cursor it saw even
 * when it reached the chain tip. That is the resume token the poller persists;
 * a scan that only returned a cursor when it gave up early would force the next
 * cycle to re-derive its position from a ledger number and re-notify.
 */

import { pathToFileURL } from "node:url";

import type { rpc } from "@stellar/stellar-sdk";

import { loadStellarConfig, networkLabel } from "../config.js";
import { createRpcServer } from "./client.js";
import { decodeEvent, formatUsdc, type ContractSource, type DecodedEvent } from "./decode.js";

/** Events per request. The RPC caps this; 200 is well inside it. */
export const EVENT_PAGE_LIMIT = 200;

/** Pages per scan. Bounds one poll cycle's worst case. */
export const EVENT_MAX_PAGES = 20;

export interface ScanOptions {
  /** Resume token from a previous scan. Ignored `startLedger` when set. */
  cursor?: string | undefined;
  /** Only used when there is no `cursor`. Clamped up to the retained floor. */
  startLedger?: number | undefined;
  /**
   * Used when neither `cursor` nor `startLedger` is given: start this many
   * ledgers behind the tip. A cold-start bound, so a fresh bot does not replay
   * a week of history into the chat.
   */
  lookbackLedgers?: number | undefined;
  limit?: number | undefined;
  maxPages?: number | undefined;
}

export interface RawScan {
  events: rpc.Api.EventResponse[];
  /** Last cursor observed — feed back as `cursor` next cycle. */
  cursor: string | null;
  latestLedger: number;
  /** Oldest ledger the RPC still retains. Anything earlier is invisible. */
  oldestLedger: number;
  /** True when `maxPages` stopped the walk before the tip. */
  truncated: boolean;
  pages: number;
}

/**
 * A cursor is `<TOID>-<index>`, and a TOID packs the ledger sequence into its
 * high 32 bits. Reading it lets the walk know it reached the end of the range
 * from the response it already has, instead of spending another round trip to
 * discover the cursor stopped moving.
 */
export function eventCursorLedger(cursor: string): number | null {
  if (typeof cursor !== "string") return null;
  const toid = cursor.split("-")[0];
  if (!toid || !/^\d+$/.test(toid)) return null;
  try {
    return Number(BigInt(toid) >> 32n);
  } catch {
    return null;
  }
}

export async function paginatedGetEvents(
  server: rpc.Server,
  filters: rpc.Api.EventFilter[],
  opts: ScanOptions = {},
): Promise<RawScan> {
  const limit = Math.max(1, opts.limit ?? EVENT_PAGE_LIMIT);
  const maxPages = Math.max(1, opts.maxPages ?? EVENT_MAX_PAGES);

  const health = await server.getHealth();
  const oldestLedger = health.oldestLedger;

  const events: rpc.Api.EventResponse[] = [];
  let cursor: string | undefined = opts.cursor;
  let lastCursor: string | null = opts.cursor ?? null;
  let previousCursor = "";
  let latestLedger = health.latestLedger;
  let truncated = false;
  let pages = 0;

  for (;;) {
    if (pages >= maxPages) {
      truncated = true;
      break;
    }
    pages += 1;

    const requestedStart =
      opts.startLedger ?? Math.max(1, health.latestLedger - (opts.lookbackLedgers ?? 0));

    // The two request shapes are a discriminated union on `cursor`, so they are
    // built separately rather than spread into one object.
    const response: rpc.Api.GetEventsResponse = cursor
      ? await server.getEvents({ filters, cursor, limit })
      : await server.getEvents({
          filters,
          startLedger: Math.max(requestedStart, oldestLedger),
          limit,
        });

    const rawEvents = Array.isArray(response?.events) ? response.events : [];
    events.push(...rawEvents);
    latestLedger = response?.latestLedger ?? latestLedger;

    const nextCursor = response.cursor || "";
    // Out of cursor, or the server stopped moving: nothing left to read.
    if (!nextCursor || nextCursor === previousCursor) break;

    lastCursor = nextCursor;

    // The cursor's ledger says how far the scan actually got. At or past the
    // chain tip and there is no more to ask for — but keep the cursor, that is
    // exactly where the next cycle resumes.
    const reached = eventCursorLedger(nextCursor);
    if (reached !== null && reached >= latestLedger) break;

    previousCursor = nextCursor;
    cursor = nextCursor;
  }

  return { events, cursor: lastCursor, latestLedger, oldestLedger, truncated, pages };
}

export interface WatchTarget {
  source: ContractSource;
  contractId: string;
}

export interface ContractScan extends Omit<RawScan, "events"> {
  source: ContractSource;
  contractId: string;
  events: DecodedEvent[];
  /** Highest ledger among the returned events, or null when there were none. */
  lastEventLedger: number | null;
}

/** Scan one contract and decode everything it returned. */
export async function readContractEvents(
  server: rpc.Server,
  target: WatchTarget,
  opts: ScanOptions = {},
): Promise<ContractScan> {
  const scan = await paginatedGetEvents(
    server,
    [{ type: "contract", contractIds: [target.contractId] }],
    opts,
  );

  const events = scan.events.map((event) => decodeEvent(target.source, event));
  const ledgers = events.map((e) => e.ledger).filter((l) => l > 0);

  return {
    source: target.source,
    contractId: target.contractId,
    events,
    cursor: scan.cursor,
    latestLedger: scan.latestLedger,
    oldestLedger: scan.oldestLedger,
    truncated: scan.truncated,
    pages: scan.pages,
    lastEventLedger: ledgers.length > 0 ? Math.max(...ledgers) : null,
  };
}

// ── Standalone verification CLI ───────────────────────────────────────────────
//
//   npm run scan                  # both contracts, from the retained floor
//   npm run scan -- --pages 40    # walk further
//   npm run scan -- --show 5      # print 5 decoded events per contract
//   npm run scan -- --from 123456 # explicit start ledger
//   npm run scan -- --json        # machine-readable JSON on stdout (progress on stderr)
//
// Needs no BOT_TOKEN: the public Testnet RPC is unauthenticated, so this reads
// live chain data with nothing but the contract ids.
//
// `--json` prints one mimir-scan-v1 document to stdout so the scan can be piped
// into jq / CI. Progress and errors go to stderr so they never corrupt the JSON.
//   npm run scan -- --mock        # local mock profile: no network, no credentials
//
// Needs no BOT_TOKEN: the public Testnet RPC is unauthenticated, so this reads
// live chain data with nothing but the contract ids. `--mock` instead points
// the same reader at a local mock Soroban RPC (`npm run mock:rpc`), selecting
// the `MIMIR_PROFILE=mock` defaults for anything the environment leaves unset.

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

/** True when `--name` appears anywhere in argv (boolean CLI switches). */
export function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** JSON.stringify replacer: bigint becomes a decimal string (never leaked as Number). */
export function scanJsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  return value;
}

export interface ScanJsonEvent {
  ledger: number;
  txHash: string;
  eventId: string;
  summary: string;
  /** Decoded payload; bigints serialize as decimal strings via {@link scanJsonReplacer}. */
  payload: DecodedEvent["payload"];
}

export interface ScanJsonTarget {
  source: ContractSource;
  contractId: string;
  pages: number;
  eventCount: number;
  truncated: boolean;
  lastEventLedger: number | null;
  cursor: string | null;
  histogram: Record<string, number>;
  /** Last N decoded events (controlled by `--show`); never includes secrets. */
  events: ScanJsonEvent[];
}

export interface ScanJsonReport {
  format: "mimir-scan-v1";
  network: string;
  rpcUrl: string;
  ledgers: { oldest: number; latest: number };
  targets: ScanJsonTarget[];
}

/** Event-name histogram used by both the human CLI and JSON report. */
export function eventHistogram(events: DecodedEvent[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const event of events) {
    const key =
      event.payload.name === "unknown"
        ? `unknown:${event.payload.eventName || "?"}`
        : event.payload.name;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries([...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

/** Build one contract's JSON target from a completed {@link ContractScan}. */
export function buildScanJsonTarget(scan: ContractScan, show: number): ScanJsonTarget {
  const limit = Number.isFinite(show) && show > 0 ? Math.floor(show) : 0;
  return {
    source: scan.source,
    contractId: scan.contractId,
    pages: scan.pages,
    eventCount: scan.events.length,
    truncated: scan.truncated,
    lastEventLedger: scan.lastEventLedger,
    cursor: scan.cursor,
    histogram: eventHistogram(scan.events),
    // slice(-0) would return everything, so show=0 must be special-cased
    events: (limit > 0 ? scan.events.slice(-limit) : []).map((event) => ({
      ledger: event.ledger,
      txHash: event.txHash,
      eventId: event.eventId,
      summary: summarize(event),
      payload: event.payload,
    })),
  };
}

export function buildScanJsonReport(input: {
  network: string;
  rpcUrl: string;
  oldestLedger: number;
  latestLedger: number;
  targets: ScanJsonTarget[];
}): ScanJsonReport {
  return {
    format: "mimir-scan-v1",
    network: input.network,
    rpcUrl: input.rpcUrl,
    ledgers: { oldest: input.oldestLedger, latest: input.latestLedger },
    targets: input.targets,
  };
}

/** Pretty-printed JSON document ending in a newline (safe to pipe). */
export function formatScanJson(report: ScanJsonReport): string {
  return JSON.stringify(report, scanJsonReplacer, 2) + "\n";
}

function summarize(event: DecodedEvent): string {
  const p = event.payload;
  const money = (v: bigint) => `${formatUsdc(v)} USDC`;
  switch (p.name) {
    case "claim_created":
      return `claim #${p.claimId} created by ${p.creator} [${p.category}]`;
    case "claim_challenged":
      return `claim #${p.claimId} challenged by ${p.challenger} for ${money(p.stake)}`;
    case "claim_resolved":
      return `claim #${p.claimId} resolved winner_side=${p.winnerSide} confidence=${p.confidence}`;
    case "market_settled":
      return `claim #${p.claimId} settled paid=${money(p.totalPaid)} fees=${money(p.totalFees)}`;
    case "challenger_paid":
      return `claim #${p.claimId} paid ${p.challenger} net=${money(p.net)}`;
    case "market_created":
      return `squad market #${p.marketId} by ${p.captain}: ${p.question}`;
    case "deposited":
      return `squad #${p.marketId} side=${p.side} ${p.participant} deposited ${money(p.amount)}`;
    case "resolved":
      return `squad #${p.marketId} resolved result=${p.result}`;
    case "claimed":
      return `squad #${p.marketId} ${p.participant} claimed net=${money(p.net)}`;
    case "unknown":
      return `unknown "${p.eventName}"${p.reason ? ` (${p.reason})` : ""}`;
    default:
      return p.name;
  }
}

function boundedJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (typeof item !== "string") return typeof item === "bigint" ? item.toString() : item;
    const compact = item.replace(/\s+/g, " ").trim();
    return compact.length <= 240 ? compact : `${compact.slice(0, 239)}…`;
  });
}

async function main(): Promise<void> {
  // `--mock` opts into the local mock profile before config is read. An
  // explicit MIMIR_PROFILE in the environment still wins; blank counts as unset.
  if (process.argv.includes("--mock") && !process.env.MIMIR_PROFILE?.trim()) {
    process.env.MIMIR_PROFILE = "mock";
  }

  const config = loadStellarConfig();
  const server = createRpcServer(config);
  const pages = Number(flag("pages") ?? EVENT_MAX_PAGES);
  const show = Number(flag("show") ?? 3);
  const from = flag("from");
  const asJson = hasFlag("json");

  const health = await server.getHealth();
  const network = networkLabel(config);

  // When `--json` is set, stdout is reserved for one JSON document. Progress
  // goes to stderr so piping (`npm run scan -- --json | jq`) stays valid.
  const progress = asJson ? console.error.bind(console) : console.log.bind(console);

  if (!asJson) {
    console.log(`RPC        ${config.rpcUrl} (${network})`);
    console.log(`ledgers    oldest=${health.oldestLedger} latest=${health.latestLedger}`);
  } else {
    progress(
      `scanning ${network} ledgers oldest=${health.oldestLedger} latest=${health.latestLedger}`,
    );
  }

  const targets: WatchTarget[] = [
    { source: "market", contractId: config.marketContractId },
    { source: "squad", contractId: config.squadContractId },
  ];

  const jsonTargets: ScanJsonTarget[] = [];

  for (const target of targets) {
    if (!asJson) {
      console.log(`\n=== ${target.source}  ${target.contractId} ===`);
    }

    const scan = await readContractEvents(server, target, {
      maxPages: pages,
      startLedger: from ? Number(from) : health.oldestLedger,
    });

    if (asJson) {
      jsonTargets.push(buildScanJsonTarget(scan, show));
      progress(
        `scanned ${target.source}: events=${scan.events.length} pages=${scan.pages} truncated=${scan.truncated}`,
      );
      continue;
    }

    const counts = eventHistogram(scan.events);

    console.log(
      `pages=${scan.pages} events=${scan.events.length} truncated=${scan.truncated} ` +
        `lastEventLedger=${scan.lastEventLedger} cursor=${scan.cursor}`,
    );
    for (const [name, count] of Object.entries(counts)) {
      console.log(`  ${count.toString().padStart(4)}  ${name}`);
    }

    for (const event of show > 0 ? scan.events.slice(-show) : []) {
      console.log(`\n  ledger ${event.ledger}  tx ${event.txHash}`);
      console.log(`  ${summarize(event)}`);
      console.log(
        `  ${boundedJson(event.payload)}`,
      );
    }
  }

  if (asJson) {
    const report = buildScanJsonReport({
      network,
      rpcUrl: config.rpcUrl,
      oldestLedger: health.oldestLedger,
      latestLedger: health.latestLedger,
      targets: jsonTargets,
    });
    process.stdout.write(formatScanJson(report));
  }
}

// Only when executed directly, not when imported by the poller.
const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
