import assert from "node:assert/strict";
import test from "node:test";

import { nativeToScVal } from "@stellar/stellar-sdk";

import { DEFAULT_DEDUP_WINDOW, EventDedupWindow, eventKey } from "../dist/dedup.js";

// ── positive ─────────────────────────────────────────────────────────────────

test("a new id is accepted once and reported as duplicate afterwards", () => {
  const window = new EventDedupWindow(8);

  assert.equal(window.add("0000000005-0000000001"), true);
  assert.equal(window.has("0000000005-0000000001"), true);
  assert.equal(window.add("0000000005-0000000001"), false);
  assert.equal(window.size, 1);
});

test("eventKey prefers the RPC id and accepts a decoded event's eventId", () => {
  assert.equal(eventKey({ id: "1-2", eventId: "9-9", txHash: "aa" }), "1-2");
  assert.equal(eventKey({ eventId: "9-9", txHash: "aa", ledger: 5 }), "9-9");
  assert.equal(eventKey({ id: "", eventId: "9-9" }), "9-9");
});

test("eventKey derives a v2 content-derived composite when no id is present", () => {
  const base = {
    txHash: "aa",
    ledger: 5,
    transactionIndex: 7,
    operationIndex: 0,
    topic: ["t1", "t2"],
  };
  const key = eventKey(base);
  assert.match(key, /^v2:5:aa:7:0:[0-9a-f]{16}$/);

  // Deterministic: the same input derives the same key on every run, which is
  // what lets a persisted window suppress a redelivery after a restart.
  assert.equal(eventKey({ ...base }), key);
});

test("composite key separates events the old topic-count format merged", () => {
  // Both used to collapse to "5:aa:2" — a real event silently suppressed.
  const a = eventKey({ ledger: 5, txHash: "aa", topic: ["ab", "c"] });
  const b = eventKey({ ledger: 5, txHash: "aa", topic: ["a", "bc"] });
  assert.notEqual(a, b);

  // Element order is identity-bearing too.
  const swapped = eventKey({ ledger: 5, txHash: "aa", topic: ["t2", "t1"] });
  assert.notEqual(swapped, eventKey({ ledger: 5, txHash: "aa", topic: ["t1", "t2"] }));

  // Transaction/operation positions disambiguate events in the same tx.
  const positioned = eventKey({
    ledger: 5,
    txHash: "aa",
    transactionIndex: 2,
    operationIndex: 3,
    topic: ["t"],
  });
  const unpositioned = eventKey({ ledger: 5, txHash: "aa", topic: ["t"] });
  assert.match(unpositioned, /^v2:5:aa:\?:\?:[0-9a-f]{16}$/);
  assert.notEqual(positioned, unpositioned);
});

test("topic digest is representation-independent: base64 XDR string equals its ScVal", () => {
  // The HTTP layer sees base64 strings, the SDK layer ScVal objects; both are
  // the same on-chain bytes and must derive the same key.
  const scVal = nativeToScVal("claim_created", { type: "symbol" });
  const fromString = eventKey({ ledger: 5, txHash: "aa", topic: [scVal.toXDR("base64")] });
  const fromScVal = eventKey({ ledger: 5, txHash: "aa", topic: [scVal] });
  assert.equal(fromString, fromScVal);

  // Distinct ScVals never collide (JSON.stringify would yield "{}" for both).
  const other = eventKey({
    ledger: 5,
    txHash: "aa",
    topic: [nativeToScVal("claim_challenged", { type: "symbol" })],
  });
  assert.notEqual(fromScVal, other);
});

// ── negative ─────────────────────────────────────────────────────────────────

test("a window with capacity 0 disables dedup: every id is reported new", () => {
  const window = new EventDedupWindow(0);

  assert.equal(window.add("x"), true);
  assert.equal(window.add("x"), true);
  assert.equal(window.size, 0);
  assert.deepEqual(window.toJSON(), []);
});

test("eventKey returns null when there is nothing stable to key on", () => {
  assert.equal(eventKey({}), null);
  assert.equal(eventKey({ id: null, eventId: undefined, txHash: "" }), null);
  // No topic array to digest: identity is never invented.
  assert.equal(eventKey({ txHash: "aa", ledger: 5 }), null);
  assert.equal(eventKey({ txHash: "aa", ledger: 5, topic: "not-an-array" }), null);
  // Unencodable topic content: pass through rather than guess.
  const circular = {};
  circular.self = circular;
  assert.equal(eventKey({ txHash: "aa", topic: [circular] }), null);
  assert.equal(eventKey({ txHash: "aa", topic: [undefined] }), null);
});

test("a non-object input derives no key instead of crashing", () => {
  assert.equal(eventKey(null), null);
  assert.equal(eventKey(undefined), null);
  assert.equal(eventKey("primitive"), null);
  assert.equal(eventKey(42), null);
});

test("a null key is never recorded and never reported as duplicate", () => {
  const window = new EventDedupWindow(4);
  assert.equal(window.add(null), true);
  assert.equal(window.add(null), true);
  assert.equal(window.size, 0);
});

test("an oversized key passes through but is never retained (bounded persistence)", () => {
  const window = new EventDedupWindow(4);
  const hostile = `1-2-${"x".repeat(4096)}`;

  assert.equal(window.add(hostile), true, "treated as new, not rejected");
  assert.equal(window.has(hostile), false, "never retained");
  assert.equal(window.size, 0, "cursor-file entries stay bounded");
  assert.deepEqual(window.toJSON(), []);

  // Normal keys around the limit are unaffected: a realistic composite fits
  // with room to spare.
  const composite = eventKey({ ledger: 5, txHash: "a".repeat(64), topic: ["t"] });
  assert.ok(composite.length < 512);
  assert.equal(window.add(composite), true);
  assert.equal(window.add(composite), false);
});

// ── boundary ─────────────────────────────────────────────────────────────────

test("the window holds exactly capacity ids and evicts the oldest first", () => {
  const window = new EventDedupWindow(3);

  for (const id of ["a", "b", "c"]) assert.equal(window.add(id), true);
  assert.equal(window.size, 3);

  // Adding a fourth evicts "a" — the oldest — and not "b" or "c".
  assert.equal(window.add("d"), true);
  assert.equal(window.size, 3);
  assert.deepEqual(window.toJSON(), ["b", "c", "d"]);

  assert.equal(window.add("a"), true, "evicted id is new again");
  assert.equal(window.add("d"), false, "recent id is still a duplicate");
});

test("a capacity of 1 keeps only the most recent id", () => {
  const window = new EventDedupWindow(1);
  window.add("a");
  window.add("b");

  assert.equal(window.has("a"), false);
  assert.equal(window.has("b"), true);
});

test("the default capacity is applied when none is given", () => {
  const window = new EventDedupWindow();
  assert.equal(window.capacity, DEFAULT_DEDUP_WINDOW);
});

test("a non-finite or fractional capacity is sanitised to a whole number", () => {
  assert.equal(new EventDedupWindow(Number.NaN).capacity, 0);
  assert.equal(new EventDedupWindow(2.9).capacity, 2);
  assert.equal(new EventDedupWindow(-5).capacity, 0);
});

// ── restart / serialisation ──────────────────────────────────────────────────

test("a window survives a JSON round trip (restart) and still rejects redelivery", () => {
  const before = new EventDedupWindow(4);
  for (const id of ["1", "2", "3"]) before.add(id);

  const restored = EventDedupWindow.fromJSON(JSON.parse(JSON.stringify(before.toJSON())), 4);

  assert.deepEqual(restored.toJSON(), ["1", "2", "3"]);
  assert.equal(restored.add("3"), false, "redelivered id is suppressed after restart");
  assert.equal(restored.add("4"), true, "a genuinely new id is still accepted");
});

test("a restarted window keeps raw TOIDs, v2 composites and retired-format keys working", () => {
  // A cursor file written by an older release can hold the retired
  // `ledger:txHash:<count>` strings alongside raw TOIDs; a fresh release adds
  // v2 composites. All three must round-trip as opaque strings.
  const composite = eventKey({ ledger: 9, txHash: "cc", topic: ["t"] });
  const before = new EventDedupWindow(8);
  before.add("4226500-1");
  before.add(composite);
  before.add("9:cc:1");

  const restored = EventDedupWindow.fromJSON(JSON.parse(JSON.stringify(before.toJSON())), 8);

  assert.equal(restored.add("4226500-1"), false, "raw TOID still suppressed");
  assert.equal(restored.add(eventKey({ ledger: 9, txHash: "cc", topic: ["t"] })), false, "v2 composite still suppressed");
  assert.equal(restored.add("9:cc:1"), false, "retired-format key still round-trips");
});

test("fromJSON tolerates garbage, non-string entries, and oversized input", () => {
  for (const garbage of [null, undefined, 42, "not-an-array", {}, [1, null, "ok", {}]]) {
    const window = EventDedupWindow.fromJSON(garbage, 2);
    assert.ok(window.size <= 2, "window stays bounded");
  }

  const oversized = Array.from({ length: 100 }, (_, i) => `e${i}`);
  const window = EventDedupWindow.fromJSON(oversized, 8);
  assert.equal(window.size, 8);
  assert.deepEqual(window.toJSON(), ["e92", "e93", "e94", "e95", "e96", "e97", "e98", "e99"]);
});

// ── regression ───────────────────────────────────────────────────────────────

test("dedup is order-stable: duplicates in a stream are dropped in place", () => {
  const window = new EventDedupWindow(16);
  const stream = ["a", "b", "a", "c", "b", "d"];
  const kept = stream.filter((id) => window.add(id));

  assert.deepEqual(kept, ["a", "b", "c", "d"]);
});
