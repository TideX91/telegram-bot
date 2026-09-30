import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { nativeToScVal, xdr } from "@stellar/stellar-sdk";

import { createPoller } from "../dist/poller.js";
import { paginatedGetEvents, readContractEvents } from "../dist/stellar/events.js";

// ── deterministic, offline doubles ───────────────────────────────────────────

const MARKET = "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";
const SQUAD = "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY";
const TIP = 100;

/** A cursor whose packed TOID reports `ledger` (see eventCursorLedger). */
function cursorAt(ledger, index = 0) {
  return `${(BigInt(ledger) << 32n).toString()}-${index}`;
}

const TIP_CURSOR = cursorAt(TIP, 0);

/** Minimal RPC event shape — paginatedGetEvents never decodes it. */
function rawEvent(id, ledger) {
  return {
    id,
    type: "contract",
    ledger,
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    contractId: MARKET,
    txHash: "ab".repeat(32),
    topic: [],
    value: null,
  };
}

/** A real, decodable `claim_created` event so the poller notifies on it. */
function claimCreatedEvent(id, ledger) {
  return {
    ...rawEvent(id, ledger),
    topic: [
      nativeToScVal("claim_created", { type: "symbol" }),
      nativeToScVal(7n, { type: "u64" }),
      nativeToScVal(MARKET, { type: "address" }),
    ],
    value: xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: nativeToScVal("category", { type: "symbol" }),
        val: nativeToScVal("crypto", { type: "string" }),
      }),
    ]),
  };
}

const HEALTH = { status: "healthy", oldestLedger: 1, latestLedger: TIP };

function serverReturning(pages) {
  let call = 0;
  return {
    getHealth: async () => HEALTH,
    getEvents: async () => pages[Math.min(call++, pages.length - 1)],
  };
}

function baseConfig(cursorFile, overrides = {}) {
  return {
    marketContractId: MARKET,
    squadContractId: SQUAD,
    rpcUrl: "https://example.invalid/rpc",
    horizonUrl: "https://example.invalid/horizon",
    networkPassphrase: "Test SDF Network ; September 2015",
    botToken: "TEST-TOKEN-DO-NOT-LEAK",
    chatId: "-1001234567890",
    pollIntervalMs: 5,
    startLookbackLedgers: 60,
    cursorFile,
    maxNotificationsPerCycle: 1,
    dedupWindow: 8,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 0,
    ...overrides,
  };
}

async function waitFor(predicate, { timeoutMs = 5000, stepMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

// ── reader: overlapping pages ────────────────────────────────────────────────

test("paginatedGetEvents keeps the first copy of an event repeated by an overlapping page", async () => {
  const server = serverReturning([
    {
      events: [rawEvent("e1", 40), rawEvent("e2", 41)],
      cursor: cursorAt(50, 1),
      latestLedger: TIP,
    },
    {
      events: [rawEvent("e2", 41), rawEvent("e3", 60)],
      cursor: cursorAt(TIP, 2),
      latestLedger: TIP,
    },
  ]);

  const scan = await paginatedGetEvents(
    server,
    [{ type: "contract", contractIds: [MARKET] }],
    { startLedger: 1 },
  );

  assert.deepEqual(scan.events.map((e) => e.id), ["e1", "e2", "e3"]);
  assert.equal(scan.duplicates, 1);
  assert.equal(scan.pages, 2);
  assert.equal(scan.cursor, cursorAt(TIP, 2));
});

test("an event redelivered at the cursor boundary is suppressed by a seeded window", async () => {
  const server = serverReturning([
    { events: [rawEvent("e9", 90)], cursor: TIP_CURSOR, latestLedger: TIP },
  ]);

  const scan = await paginatedGetEvents(
    server,
    [{ type: "contract", contractIds: [MARKET] }],
    { cursor: cursorAt(89, 0), seenEventIds: ["e9"] },
  );

  assert.deepEqual(scan.events, []);
  assert.equal(scan.duplicates, 1);
  // A duplicate must not cost the resume token: the cursor still advances.
  assert.equal(scan.cursor, TIP_CURSOR);
});

// ── negative / boundary ──────────────────────────────────────────────────────

test("EVENT_DEDUP_WINDOW=0 (dedupWindow 0) disables suppression entirely", async () => {
  const server = serverReturning([
    {
      events: [rawEvent("e1", 40)],
      cursor: cursorAt(50, 1),
      latestLedger: TIP,
    },
    {
      events: [rawEvent("e1", 40)],
      cursor: TIP_CURSOR,
      latestLedger: TIP,
    },
  ]);

  const scan = await paginatedGetEvents(
    server,
    [{ type: "contract", contractIds: [MARKET] }],
    { startLedger: 1, dedupWindow: 0 },
  );

  assert.equal(scan.events.length, 2);
  assert.equal(scan.duplicates, 0);
});

test("a page made entirely of duplicates still terminates and returns the cursor", async () => {
  const server = serverReturning([
    { events: [rawEvent("e1", 40), rawEvent("e1", 40)], cursor: TIP_CURSOR, latestLedger: TIP },
  ]);

  const scan = await paginatedGetEvents(
    server,
    [{ type: "contract", contractIds: [MARKET] }],
    { startLedger: 1 },
  );

  assert.deepEqual(scan.events.map((e) => e.id), ["e1"]);
  assert.equal(scan.duplicates, 1);
  assert.equal(scan.cursor, TIP_CURSOR);
  assert.equal(scan.pages, 1);
});

test("an event with no id and no tx hash is not silently dropped", async () => {
  const anonymous = { ...rawEvent("ignored", 40), id: "", txHash: "" };
  const server = serverReturning([{ events: [anonymous], cursor: TIP_CURSOR, latestLedger: TIP }]);

  const scan = await paginatedGetEvents(
    server,
    [{ type: "contract", contractIds: [MARKET] }],
    { startLedger: 1 },
  );

  assert.equal(scan.events.length, 1);
  assert.equal(scan.duplicates, 0);
});

test("id-less events sharing a transaction are never falsely merged", async () => {
  // The retired `ledger:txHash:<topic-count>` key collapsed both of these
  // into "40:<txHash>:2" — one real event silently suppressed. Content-derived
  // keys keep them apart.
  const txHash = "cd".repeat(32);
  const first = { ...rawEvent("", 40), txHash, topic: ["ab", "c"] };
  const second = { ...rawEvent("", 40), txHash, topic: ["a", "bc"] };
  const server = serverReturning([
    { events: [first, second], cursor: TIP_CURSOR, latestLedger: TIP },
  ]);

  const scan = await paginatedGetEvents(
    server,
    [{ type: "contract", contractIds: [MARKET] }],
    { startLedger: 1 },
  );

  assert.equal(scan.events.length, 2, "distinct id-less events both survive");
  assert.equal(scan.duplicates, 0);
});

test("an id-less event repeated by an overlapping page is still suppressed", async () => {
  const idless = { ...rawEvent("", 40), topic: ["same"] };
  const server = serverReturning([
    { events: [idless], cursor: cursorAt(50, 1), latestLedger: TIP },
    { events: [idless], cursor: TIP_CURSOR, latestLedger: TIP },
  ]);

  const scan = await paginatedGetEvents(
    server,
    [{ type: "contract", contractIds: [MARKET] }],
    { startLedger: 1 },
  );

  assert.equal(scan.events.length, 1, "the composite key suppresses the repeat");
  assert.equal(scan.duplicates, 1);
  assert.equal(scan.pages, 2);
  assert.equal(scan.cursor, TIP_CURSOR, "a duplicate never costs the resume token");
});

test("malformed XDR and non-object entries never crash the scanner", async () => {
  const target = { source: "market", contractId: MARKET };
  const malformed = {
    ...rawEvent("", 42),
    topic: ["!!!not-xdr!!!"],
    value: "!!!also-not-xdr!!!",
  };
  const server = serverReturning([
    {
      events: [null, "primitive", 42, malformed, rawEvent("good", 43)],
      cursor: TIP_CURSOR,
      latestLedger: TIP,
    },
  ]);

  const scan = await readContractEvents(server, target, { startLedger: 1 });

  // The walk completes, non-objects are skipped, and nothing threw.
  assert.ok(scan.events.every((e) => e !== null && typeof e === "object"));
  assert.ok(scan.events.some((e) => e.eventId === "good"), "the decodable event survives");
  const degraded = scan.events.find((e) => e.eventId === "");
  assert.ok(degraded, "the malformed entry is decoded, not dropped");
  assert.equal(degraded.payload.name, "unknown");
  assert.ok(typeof degraded.payload.reason === "string" && degraded.payload.reason.length > 0);
});

// ── poller: cross-cycle + restart integration ────────────────────────────────

/** A fake RPC that redelivers the same market event on every page, forever. */
function redeliveringServer(event) {
  return {
    getHealth: async () => HEALTH,
    getEvents: async (req) => {
      const contractId = req.filters?.[0]?.contractIds?.[0];
      return {
        events: contractId === MARKET ? [event] : [],
        cursor: TIP_CURSOR,
        latestLedger: TIP,
      };
    },
  };
}

async function withTempCursor(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "mimir-dedup-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return path.join(dir, "cursor.json");
}

test("the poller notifies a redelivered event once and counts the duplicates", async (t) => {
  const cursorFile = await withTempCursor(t);
  const event = claimCreatedEvent("0000000064-0000000001", 80);
  const sent = [];

  const poller = createPoller({
    config: baseConfig(cursorFile),
    server: redeliveringServer(event),
    send: async (text) => {
      sent.push(text);
    },
  });

  await poller.start();
  try {
    await waitFor(() => poller.status().notificationsSent >= 1);
    await waitFor(() => poller.status().cycles >= 3);

    const status = poller.status();
    assert.equal(status.notificationsSent, 1, "one on-chain event => one message");
    assert.equal(sent.length, 1);
    assert.ok(status.eventsDeduplicated >= 1, "redelivery counted, not re-sent");
  } finally {
    await poller.stop();
  }

  const saved = JSON.parse(await readFile(cursorFile, "utf8"));
  const market = saved.targets.market;
  assert.equal(market.cursor, TIP_CURSOR);
  assert.ok(Array.isArray(market.recentEventIds));
  assert.deepEqual(market.recentEventIds, [event.id], "window is bounded and persisted");
  assert.ok(saved.targets.squad.recentEventIds.length === 0);
});

test("a restart restores the window and does not re-notify the boundary event", async (t) => {
  const cursorFile = await withTempCursor(t);
  const event = claimCreatedEvent("0000000064-0000000002", 80);
  const server = redeliveringServer(event);

  const firstSent = [];
  const first = createPoller({
    config: baseConfig(cursorFile),
    server,
    send: async (text) => {
      firstSent.push(text);
    },
  });
  await first.start();
  try {
    await waitFor(() => first.status().notificationsSent >= 1);
    await waitFor(() => first.status().cycles >= 2); // cycle 1 has saved the cursor
  } finally {
    await first.stop();
  }
  assert.equal(firstSent.length, 1);

  // Second process, same cursor file, same redelivered page.
  const secondSent = [];
  const second = createPoller({
    config: baseConfig(cursorFile),
    server,
    send: async (text) => {
      secondSent.push(text);
    },
  });
  await second.start();
  try {
    await waitFor(() => second.status().cycles >= 2);
    assert.deepEqual(secondSent, [], "restart must not replay the boundary event");
    assert.ok(second.status().eventsDeduplicated >= 1);
  } finally {
    await second.stop();
  }
});

test("a corrupt cursor file still cold-starts and notifies (dedup never wedges the poller)", async (t) => {
  const cursorFile = await withTempCursor(t);
  await rm(cursorFile, { force: true });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(cursorFile, "{ not json", "utf8");

  const event = claimCreatedEvent("0000000064-0000000003", 80);
  const sent = [];
  const poller = createPoller({
    config: baseConfig(cursorFile),
    server: redeliveringServer(event),
    send: async (text) => {
      sent.push(text);
    },
  });

  await poller.start();
  try {
    await waitFor(() => poller.status().notificationsSent >= 1);
    assert.equal(sent.length, 1);
  } finally {
    await poller.stop();
  }
});

test("an id-less redelivered event is notified once and persisted as a v2 composite key", async (t) => {
  const cursorFile = await withTempCursor(t);
  const event = claimCreatedEvent("", 80);
  const sent = [];

  const poller = createPoller({
    config: baseConfig(cursorFile),
    server: redeliveringServer(event),
    send: async (text) => {
      sent.push(text);
    },
  });

  await poller.start();
  try {
    await waitFor(() => poller.status().notificationsSent >= 1);
    await waitFor(() => poller.status().cycles >= 3);

    assert.equal(sent.length, 1, "the redelivery is suppressed, not re-sent");
    assert.ok(poller.status().eventsDeduplicated >= 1, "redelivery counted");
  } finally {
    await poller.stop();
  }

  // The derived key — not an RPC id — is what lands in the cursor file, so a
  // restart restores exactly the window the next cycle needs.
  const saved = JSON.parse(await readFile(cursorFile, "utf8"));
  const ids = saved.targets.market.recentEventIds;
  assert.equal(ids.length, 1, "window is bounded and persisted");
  assert.match(ids[0], /^v2:80:[0-9a-f]{64}:\?:\?:[0-9a-f]{16}$/);
});
