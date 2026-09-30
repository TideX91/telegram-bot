import assert from "node:assert/strict";
import test from "node:test";
import { xdr } from "@stellar/stellar-sdk";

import {
  decodeEvent,
  sanitizeReason,
  validateTopicSchema,
  MARKET_TOPIC_SCHEMAS,
  SQUAD_TOPIC_SCHEMAS,
} from "../dist/stellar/decode.js";
import { paginatedGetEvents, readContractEvents, eventCursorLedger } from "../dist/stellar/events.js";

const VALID_ADDRESS = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW";
const VALID_CONTRACT = "CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW";

test("validateTopicSchema covers all expected market and squad event schemas", () => {
  assert.equal(typeof MARKET_TOPIC_SCHEMAS.claim_created, "object");
  assert.equal(MARKET_TOPIC_SCHEMAS.claim_created.expectedCount, 3);
  assert.equal(typeof SQUAD_TOPIC_SCHEMAS.market_created, "object");
  assert.equal(SQUAD_TOPIC_SCHEMAS.market_created.expectedCount, 3);
});

test("validateTopicSchema positive checks pass for valid topic arguments", () => {
  const claimCreatedRes = validateTopicSchema("market", "claim_created", [
    "claim_created",
    1,
    VALID_ADDRESS,
  ]);
  assert.equal(claimCreatedRes.valid, true);

  const depositedRes = validateTopicSchema("squad", "deposited", [
    "deposited",
    10,
    1,
    VALID_ADDRESS,
  ]);
  assert.equal(depositedRes.valid, true);
});

test("validateTopicSchema negative checks detect incorrect topic counts", () => {
  const shortRes = validateTopicSchema("market", "claim_created", ["claim_created", 1]);
  assert.equal(shortRes.valid, false);
  assert.match(shortRes.reason, /expected 3 topics, got 2/);

  const longRes = validateTopicSchema("squad", "deposited", [
    "deposited",
    10,
    1,
    VALID_ADDRESS,
    "extra_topic",
  ]);
  assert.equal(longRes.valid, false);
  assert.match(longRes.reason, /expected 4 topics, got 5/);
});

test("validateTopicSchema negative checks detect invalid topic argument types", () => {
  const invalidIdRes = validateTopicSchema("market", "claim_created", [
    "claim_created",
    "not-an-int",
    VALID_ADDRESS,
  ]);
  assert.equal(invalidIdRes.valid, false);
  assert.match(invalidIdRes.reason, /expected an integer/);

  const invalidAddrRes = validateTopicSchema("market", "claim_created", [
    "claim_created",
    1,
    "INVALID_STRKEY",
  ]);
  assert.equal(invalidAddrRes.valid, false);
  assert.match(invalidAddrRes.reason, /expected a Stellar address strkey/);
});

test("decodeEvent handles malformed XDR without throwing", () => {
  const malformedTopicEvent = {
    contractId: VALID_CONTRACT,
    ledger: 100,
    txHash: "00".repeat(32),
    ledgerClosedAt: "2026-09-24T00:00:00Z",
    id: "100-0",
    topic: ["invalid_base64_xdr!!!"],
    value: null,
  };

  const decoded = decodeEvent("market", malformedTopicEvent);
  assert.equal(decoded.payload.name, "unknown");
  assert.equal(typeof decoded.payload.reason, "string");
  assert.ok(decoded.payload.reason.length > 0);
});

test("decodeEvent handles missing, empty, or non-string topics gracefully", () => {
  const missingTopic = decodeEvent("market", {
    contractId: VALID_CONTRACT,
    ledger: 100,
    topic: null,
  });
  assert.equal(missingTopic.payload.name, "unknown");
  assert.equal(missingTopic.payload.reason, "missing or invalid topic array");

  const emptyTopic = decodeEvent("market", {
    contractId: VALID_CONTRACT,
    ledger: 100,
    topic: [],
  });
  assert.equal(emptyTopic.payload.name, "unknown");
  assert.equal(emptyTopic.payload.reason, "empty topic array");

  const nonStringTopic0 = decodeEvent("market", {
    contractId: VALID_CONTRACT,
    ledger: 100,
    topic: [12345],
  });
  assert.equal(nonStringTopic0.payload.name, "unknown");
  assert.equal(nonStringTopic0.payload.reason, "topic[0] is not an event name string");
});

test("decodeEvent handles synthetic ScVal topics and values", () => {
  const eventNameVal = xdr.ScVal.scvSymbol("claim_cancelled");
  const claimIdVal = xdr.ScVal.scvU64(new xdr.Uint64(42n));

  const syntheticEvent = {
    contractId: VALID_CONTRACT,
    ledger: 101,
    txHash: "11".repeat(32),
    ledgerClosedAt: "2026-09-24T00:01:00Z",
    id: "101-0",
    topic: [eventNameVal, claimIdVal],
    value: xdr.ScVal.scvVoid(),
  };

  const decoded = decodeEvent("market", syntheticEvent);
  assert.equal(decoded.payload.name, "claim_cancelled");
  assert.equal(decoded.payload.claimId, 42);
});

test("sanitizeReason redacts bot tokens, secret keys, and caps reason length", () => {
  const botToken = "123456789:ABCdefGHIjklMNOpqrsTUVwxyz123456";
  const secretKey = "S" + "A".repeat(55);
  const longPayload = "error-detail ".repeat(50);
  const rawReason = `Failed with ${botToken} and ${secretKey}: ${longPayload}`;

  const sanitized = sanitizeReason(rawReason, 150);
  assert.equal(sanitized.includes(botToken), false);
  assert.equal(sanitized.includes(secretKey), false);
  assert.ok(sanitized.includes("[REDACTED]"));
  assert.ok(sanitized.length <= 150);
});

test("readContractEvents scanner survives malformed XDR events in RPC response", async () => {
  const fakeServer = {
    getHealth: async () => ({ latestLedger: 1000, oldestLedger: 100 }),
    getEvents: async () => ({
      events: [
        {
          contractId: VALID_CONTRACT,
          ledger: 500,
          txHash: "aa".repeat(32),
          ledgerClosedAt: "2026-09-24T00:00:00Z",
          id: "500-0",
          topic: ["invalid_xdr_data"],
          value: "invalid_val",
        },
      ],
      cursor: "0000000214748364800-0",
      latestLedger: 1000,
    }),
  };

  const scan = await readContractEvents(
    fakeServer,
    { source: "market", contractId: VALID_CONTRACT },
    { startLedger: 500, maxPages: 1 },
  );

  assert.equal(scan.events.length, 1);
  assert.equal(scan.events[0].payload.name, "unknown");
});

test("paginatedGetEvents falls back to startLedger when cursor is behind oldestLedger", async () => {
  let requestedWithCursor = false;
  let requestedWithStartLedger = false;

  const fakeServer = {
    getHealth: async () => ({ latestLedger: 1000, oldestLedger: 500 }),
    getEvents: async (opts) => {
      if (opts.cursor) requestedWithCursor = true;
      if (opts.startLedger) requestedWithStartLedger = true;
      return {
        events: [],
        cursor: "",
        latestLedger: 1000,
      };
    },
  };

  // Cursor for ledger 100, which is < oldestLedger 500
  const staleCursor = `${BigInt(100) << 32n}-0`;
  assert.equal(eventCursorLedger(staleCursor), 100);

  const scan = await paginatedGetEvents(
    fakeServer,
    [],
    { cursor: staleCursor, maxPages: 1 },
  );

  assert.equal(requestedWithCursor, false, "stale cursor should not be sent to RPC");
  assert.equal(requestedWithStartLedger, true, "should fall back to startLedger");
  assert.equal(scan.oldestLedger, 500);
});
