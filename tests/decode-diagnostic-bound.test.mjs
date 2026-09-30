/**
 * Boundary test for the decoder's diagnostic bound.
 *
 * `src/stellar/decode.ts` turns any decode failure into
 * `{ name: "unknown", eventName, reason }`, where `reason` comes from
 * `diagnostic(err.message)`. `diagnostic` has two branches:
 *
 *   message.length <= MAX_DIAGNOSTIC_LENGTH  -> returned as-is
 *   otherwise                                -> `${slice(0, 199)}…`
 *
 * The existing malformed-admin test in `decode.test.mjs` only asserts
 * `reason.length <= 200` for a failure whose message is short, so it exercises
 * the first branch and would still pass if the bounding branch were deleted -
 * the reason would simply be the short message. Nothing pinned the truncation.
 *
 * The decoder is reachable with an attacker-controlled string: `addr()` embeds
 * the offending value verbatim in its error message
 * (`expected a Stellar address strkey, got "<value>"`), and a topic is a
 * perfectly good place to put one. A 600-character topic therefore produces a
 * message well over the bound, which is the only way to exercise the
 * truncating branch from the public `decodeEvent` entry point.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { nativeToScVal, Keypair } from "@stellar/stellar-sdk";

import { decodeEvent } from "../dist/stellar/decode.js";

const TEST_KP = Keypair.random();
const ADDR = TEST_KP.publicKey(); // predictable G... strkey, 56 chars

function scStr(s) {
  return nativeToScVal(String(s), { type: "string" });
}

function scU64(n) {
  return nativeToScVal(BigInt(n), { type: "u64" });
}

function scAddress(gAddr) {
  return nativeToScVal(gAddr, { type: "address" });
}

test("decodeEvent: an oversized topic is truncated to the diagnostic bound", () => {
  // 600 chars: comfortably past MAX_DIAGNOSTIC_LENGTH (200) before `addr()`
  // wraps it in a message, so the truncating branch is the only way to satisfy
  // any length assertion below.
  const LONG = "A".repeat(600);

  const raw = {
    id: "11-0",
    contractId: "C1",
    ledger: 11,
    txHash: "aabbcc",
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    // topic[2] is `claim_created`'s creator, which `addr()` validates.
    topic: [scStr("claim_created"), scU64(42), scStr(LONG)],
    value: nativeToScVal({ category: "sports" }),
  };

  let result;
  assert.doesNotThrow(() => {
    result = decodeEvent("market", raw);
  });

  assert.equal(result.payload.name, "unknown");
  assert.equal(result.payload.eventName, "claim_created");

  const reason = result.payload.reason;
  assert.equal(typeof reason, "string");

  // Exactly the bound: the truncating branch appends an ellipsis after
  // MAX_DIAGNOSTIC_LENGTH - 1 characters, so the result is exactly 200 long.
  assert.equal(
    reason.length,
    200,
    `expected the reason to be truncated to 200 chars, got ${reason.length}`,
  );
  assert.ok(reason.endsWith("…"), "a truncated reason must end with an ellipsis");

  // The half-kilobyte value must not survive into the payload.
  assert.ok(!reason.includes(LONG), "the raw 600-character topic leaked into the reason");
  assert.ok(
    reason.includes(LONG.slice(0, 16)),
    "the reason should still identify which value was rejected",
  );
});

test("decodeEvent: repeated pathological decodes are stable (no cross-call state)", () => {
  const LONG = "B".repeat(600);
  const raw = {
    id: "12-0",
    contractId: "C1",
    ledger: 12,
    txHash: "aabbcc",
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    topic: [scStr("claim_created"), scU64(43), scStr(LONG)],
    value: nativeToScVal({ category: "sports" }),
  };

  const first = decodeEvent("market", raw);
  for (let i = 0; i < 500; i += 1) {
    // Identical input, identical output: the decoder holds no accumulator, so
    // a long-running poller cannot grow this payload cycle over cycle.
    assert.deepEqual(decodeEvent("market", raw), first);
  }

  // And a following well-formed event still decodes normally.
  const good = {
    id: "13-0",
    contractId: "C1",
    ledger: 13,
    txHash: "deadbeef",
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    topic: [scStr("claim_created"), scU64(44), scAddress(ADDR)],
    value: nativeToScVal({ category: "sports" }),
  };
  const decoded = decodeEvent("market", good);
  assert.equal(decoded.payload.name, "claim_created");
  assert.equal(decoded.payload.creator, ADDR);
});
