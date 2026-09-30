import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createNotifier } from "../dist/bot.js";
import { formatEvent } from "../dist/notifications/format.js";
import { eventCursorLedger } from "../dist/stellar/events.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, "fixtures");

/** Money keys on decoded payloads that fixtures store as decimal strings. */
const MONEY_KEYS = new Set([
  "stake",
  "totalPaid",
  "totalFees",
  "owedToChallengers",
  "dust",
  "gross",
  "fee",
  "net",
  "amount",
  "shares",
  "poolA",
  "poolB",
]);

function hydratePayload(payload) {
  const out = { ...payload };
  for (const key of MONEY_KEYS) {
    if (typeof out[key] === "string" && /^-?\d+$/.test(out[key])) {
      out[key] = BigInt(out[key]);
    }
  }
  return out;
}

function hydrateEvent(raw) {
  return {
    ...raw,
    payload: hydratePayload(raw.payload),
  };
}

async function loadCatalog() {
  const raw = await readFile(path.join(fixturesDir, "events.json"), "utf8");
  return JSON.parse(raw);
}

test("fixture catalog covers positive, negative, and boundary kinds", async () => {
  const catalog = await loadCatalog();
  const kinds = new Set(catalog.cases.map((c) => c.kind));
  assert.ok(kinds.has("positive"), "missing positive cases");
  assert.ok(kinds.has("negative"), "missing negative cases");
  assert.ok(kinds.has("boundary"), "missing boundary cases");
  assert.ok(catalog.cases.length >= 8, "catalog too thin");
});

test("fixture config never points at live RPC or embeds secrets", async () => {
  const catalog = await loadCatalog();
  const { config } = catalog;
  assert.match(config.rpcUrl, /example\.invalid/);
  assert.match(config.horizonUrl, /example\.invalid/);
  const blob = JSON.stringify(catalog);
  assert.doesNotMatch(blob, /BOT_TOKEN|ghp_|sk_live/);
  assert.doesNotMatch(blob, /api\.telegram\.org/i);
});

test("event fixtures drive formatEvent notify/skip expectations", async () => {
  const catalog = await loadCatalog();
  const { config } = catalog;

  for (const c of catalog.cases) {
    const event = hydrateEvent(c.event);
    const message = formatEvent(config, event);

    if (c.expect === "skip") {
      assert.equal(message, null, `${c.id}: expected skip`);
      continue;
    }

    assert.equal(c.expect, "notify", `${c.id}: unknown expect`);
    assert.equal(typeof message, "string", `${c.id}: expected notify string`);
    assert.ok(message.length > 0, `${c.id}: empty message`);
    for (const needle of c.messageIncludes ?? []) {
      assert.ok(
        message.includes(needle),
        `${c.id}: missing ${JSON.stringify(needle)} in ${JSON.stringify(message)}`,
      );
    }
    assert.doesNotMatch(message, /BOT_TOKEN|ghp_/);
  }
});

test("fixture claim_challenged reaches Telegram via fake notifier", async () => {
  const catalog = await loadCatalog();
  const c = catalog.cases.find((x) => x.id === "claim_challenged_happy");
  assert.ok(c, "claim_challenged_happy fixture missing");

  const event = hydrateEvent(c.event);
  const message = formatEvent(catalog.config, event);
  assert.ok(message);

  const sent = [];
  const fakeBot = {
    api: {
      sendMessage: async (...args) => {
        sent.push(args);
        return {};
      },
    },
  };

  await createNotifier(fakeBot)(catalog.config.chatId, message);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], catalog.config.chatIds[0]);
  assert.equal(sent[0][1], message);
  assert.equal(sent[0][2].parse_mode, "MarkdownV2");
});

test("Telegram send failure from fixture path preserves the error (no token leak)", async () => {
  const catalog = await loadCatalog();
  const error = new Error("Telegram API unavailable");
  const fakeBot = {
    api: {
      sendMessage: async () => Promise.reject(error),
    },
  };
  const notify = createNotifier(fakeBot, { chatIds: catalog.config.chatIds });
  await assert.rejects(notify("fixture-message"), (err) => {
    assert.equal(err, error);
    assert.doesNotMatch(String(err), /BOT_TOKEN/);
    return true;
  });
});

test("valid cursor fixture parses as version-1 poller shape", async () => {
  const raw = await readFile(path.join(fixturesDir, "cursor-valid.json"), "utf8");
  const parsed = JSON.parse(raw);
  assert.equal(parsed.version, 1);
  assert.ok(parsed.targets.market.cursor);
  assert.ok(parsed.targets.squad.cursor);
  assert.equal(typeof parsed.targets.market.lastEventLedger, "number");
});

test("corrupt cursor fixture is not JSON (cold-start path)", async () => {
  const raw = await readFile(path.join(fixturesDir, "cursor-corrupt.txt"), "utf8");
  assert.throws(() => JSON.parse(raw));
});

test("opaque cursor ledger hint accepts bounded Soroban TOIDs", () => {
  assert.equal(eventCursorLedger("0018276211125911551-4294967295"), 4255261);
  assert.equal(eventCursorLedger("18446744073709551615-4294967295"), 4294967295);
});

test("opaque cursor ledger hint rejects malformed and oversized tokens", () => {
  for (const cursor of [
    "",
    "not-a-cursor",
    "123",
    "123-",
    "123-1-extra",
    "18446744073709551616-0",
    "1-4294967296",
    `${"9".repeat(100000)}-0`,
  ]) {
    assert.equal(eventCursorLedger(cursor), null, cursor.slice(0, 32));
  }
});

test("long summary boundary fixture clips before sizing a chat message", async () => {
  const catalog = await loadCatalog();
  const c = catalog.cases.find((x) => x.id === "long_summary_clipped");
  const message = formatEvent(catalog.config, hydrateEvent(c.event));
  assert.ok(message);
  assert.ok(message.includes("…"));
  assert.ok(message.length < 800, "message unexpectedly huge");
});
