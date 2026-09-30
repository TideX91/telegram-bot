import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_DECODED_EVENT_XDR_BYTES,
  MAX_DECODED_STRING_CHARS,
  MAX_EVENT_TOPIC_XDR_BYTES,
  decodeEvent,
  summarizePayloadForLog,
} from "../dist/stellar/decode.js";
import { xdr } from "@stellar/stellar-sdk";

function scvString(value) {
  return xdr.ScVal.scvString(value);
}

function scvSymbol(value) {
  return xdr.ScVal.scvSymbol(value);
}

function scvU64(value) {
  return xdr.ScVal.scvU64(xdr.Uint64.fromString(String(value)));
}

function scvAddressG() {
  // 32 zero bytes -> valid contract/account encoding path via scvBytes is awkward;
  // use a map-less event where address is not required: claim_cancelled only needs id.
  return null;
}

function baseEvent(overrides = {}) {
  return {
    contractId: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCM",
    ledger: 42,
    txHash: "abcd",
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    id: "42-0",
    topic: [scvSymbol("claim_cancelled"), scvU64(7)],
    value: xdr.ScVal.scvMap([]),
    ...overrides,
  };
}

test("decode constants expose explicit payload caps", () => {
  assert.equal(MAX_DECODED_EVENT_XDR_BYTES, 16_384);
  assert.equal(MAX_EVENT_TOPIC_XDR_BYTES, 1_024);
  assert.equal(MAX_DECODED_STRING_CHARS, 2_048);
});

test("positive: small claim_cancelled event decodes normally", () => {
  const decoded = decodeEvent("market", baseEvent());
  assert.equal(decoded.payload.name, "claim_cancelled");
  assert.equal(decoded.payload.claimId, 7);
});

test("negative: oversized event.value XDR becomes unknown with size reason", () => {
  const huge = "x".repeat(MAX_DECODED_EVENT_XDR_BYTES);
  const decoded = decodeEvent(
    "market",
    baseEvent({
      topic: [scvSymbol("claim_created"), scvU64(1), scvString("G" + "A".repeat(55))],
      value: xdr.ScVal.scvMap([
        new xdr.ScMapEntry({ key: scvSymbol("category"), val: scvString(huge) }),
      ]),
    }),
  );
  assert.equal(decoded.payload.name, "unknown");
  assert.match(decoded.payload.reason ?? "", /exceeds cap/i);
  assert.ok((decoded.payload.reason ?? "").length <= 241);
});

test("boundary: string field at MAX_DECODED_STRING_CHARS still decodes", () => {
  const category = "c".repeat(MAX_DECODED_STRING_CHARS);
  // Keep XDR under the value cap: 2048 char string XDR is well under 16KiB.
  const decoded = decodeEvent(
    "market",
    baseEvent({
      topic: [
        scvSymbol("claim_created"),
        scvU64(9),
        // Address topic: use scvString of a plausible G-strkey shape for addr()
        scvString("G" + "A".repeat(55)),
      ],
      value: xdr.ScVal.scvMap([
        new xdr.ScMapEntry({ key: scvSymbol("category"), val: scvString(category) }),
      ]),
    }),
  );
  assert.equal(decoded.payload.name, "claim_created");
  assert.equal(decoded.payload.category.length, MAX_DECODED_STRING_CHARS);
});

test("boundary: string field one past the cap becomes unknown", () => {
  const category = "c".repeat(MAX_DECODED_STRING_CHARS + 1);
  const decoded = decodeEvent(
    "market",
    baseEvent({
      topic: [scvSymbol("claim_created"), scvU64(9), scvString("G" + "A".repeat(55))],
      value: xdr.ScVal.scvMap([
        new xdr.ScMapEntry({ key: scvSymbol("category"), val: scvString(category) }),
      ]),
    }),
  );
  assert.equal(decoded.payload.name, "unknown");
  assert.match(decoded.payload.reason ?? "", /string length/i);
});

test("malformed XDR topic does not crash the scanner", () => {
  const bad = {
    contractId: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCM",
    ledger: 1,
    txHash: "",
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    id: "1-0",
    topic: [null],
    value: null,
  };
  const decoded = decodeEvent("market", bad);
  assert.equal(decoded.payload.name, "unknown");
});

test("summarizePayloadForLog truncates long JSON", () => {
  const payload = {
    name: "unknown",
    eventName: "x",
    reason: "r".repeat(2000),
  };
  const out = summarizePayloadForLog(payload, 64);
  assert.ok(out.length <= 65);
  assert.ok(out.endsWith("…"));
});
