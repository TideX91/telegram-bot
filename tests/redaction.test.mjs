import assert from "node:assert/strict";
import test from "node:test";

import { buildHealthReport } from "../dist/health.js";
import { safeErrorMessage } from "../dist/notifications/format.js";
import {
  clearSecrets,
  DEFAULT_MAX_LEN,
  REDACTED,
  redactError,
  redactText,
  redactUrl,
  registerSecret,
  registerSecrets,
} from "../dist/redact.js";

/** Shaped like a real token (`digits:35chars`), from Telegram's own docs. */
const BOT_TOKEN = "1234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";
const CHAT_ID = "-1001234567890";
/** 56-char ed25519 seed strkey shape (`S` + 55 base32). Not a real key. */
const STELLAR_SECRET = `S${"A".repeat(55)}`;
/** 64-char transaction hash, as the RPC and the explorer URL report it. */
const TX_HASH = "ab12".repeat(16);

function baseConfig(overrides = {}) {
  return {
    marketContractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    squadContractId: "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY",
    rpcUrl: "https://soroban-testnet.stellar.org",
    botToken: BOT_TOKEN,
    chatId: CHAT_ID,
    pollIntervalMs: 30_000,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
    ...overrides,
  };
}

function baseStatus(overrides = {}) {
  return {
    running: true,
    paused: false,
    stopping: false,
    startedAt: 1_000,
    cycles: 4,
    lastPollAt: 5_000,
    lastSuccessAt: 5_000,
    latestLedger: 42,
    oldestLedger: 1,
    notificationsSent: 2,
    notificationsFailed: 0,
    eventsSkipped: 1,
    eventsDeduplicated: 0,
    notificationsDropped: 0,
    cursorRewinds: 0,
    consecutiveFailures: 0,
    lastError: null,
    targets: [
      {
        source: "market",
        contractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
        cursor: "0018276211125911551-4294967295",
        lastEventLedger: 40,
        cursorStale: false,
        lastError: null,
      },
    ],
    ...overrides,
  };
}

// The registry is process-wide state, so every case starts from an empty one.
test.beforeEach(() => {
  clearSecrets();
});

// ── Positive: ordinary error text must survive verbatim ───────────────────────

test("positive: an operational error with no credentials is unchanged", () => {
  const raw = "RPC getEvents failed: timeout after 5000ms";
  assert.equal(redactText(raw), raw);
  assert.equal(redactError(new Error(raw)), raw);
  assert.equal(safeErrorMessage(new Error(raw)), raw);
});

test("positive: short identifiers stay readable", () => {
  assert.equal(redactText("ledger 42 cursor none"), "ledger 42 cursor none");
  assert.equal(redactText("market scan failed"), "market scan failed");
});

test("positive: a transaction hash is not mistaken for a credential", () => {
  // The audit trail replaces any ≥40-character opaque token, which is right for
  // a trail meant to be pasted into an issue. Error text must not: the tx hash
  // in an explorer URL is the most useful part of the message.
  const raw = `send failed · https://stellar.expert/explorer/testnet/tx/${TX_HASH}`;
  assert.equal(redactText(raw), raw);
  assert.equal(redactText(raw).includes(TX_HASH), true);

  // ...and neither is a resume cursor, which is how an operator diagnoses a gap.
  const cursor = "0018276211125911551-4294967295";
  assert.equal(redactText(`cursor ${cursor} rejected`).includes(cursor), true);
});

test("negative: public chain identifiers are not redacted", () => {
  const contract = "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";
  const account = `G${"A".repeat(55)}`;
  const out = redactText(`market ${contract} operator ${account}`);
  assert.equal(out.includes(contract), true);
  assert.equal(out.includes(account), true);
});

// ── Negative: the shapes this module exists for ───────────────────────────────

test("negative: a Telegram bot token is redacted, bare and inside a URL", () => {
  const inUrl = redactText(
    `Unauthorized: call to https://api.telegram.org/bot${BOT_TOKEN}/sendMessage failed`,
  );
  assert.equal(inUrl.includes(BOT_TOKEN), false);
  assert.equal(inUrl.includes("api.telegram.org"), true);
  assert.equal(inUrl.includes(REDACTED), true);

  const bare = redactText(`getMe failed for ${BOT_TOKEN}`);
  assert.equal(bare.includes(BOT_TOKEN), false);
});

test("negative: a registered secret is redacted without a caller-supplied list", () => {
  registerSecret(CHAT_ID);
  const out = redactText(`failed to deliver to chat ${CHAT_ID}`);
  assert.equal(out.includes(CHAT_ID), false);
  assert.equal(out.includes(REDACTED), true);

  // ...and boot registration is what makes that work for every call site.
  clearSecrets();
  assert.equal(redactText(`failed to deliver to chat ${CHAT_ID}`).includes(CHAT_ID), true);
  registerSecrets([BOT_TOKEN, CHAT_ID]);
  const afterBoot = safeErrorMessage(new Error(`chat ${CHAT_ID} token ${BOT_TOKEN}`));
  assert.equal(afterBoot.includes(CHAT_ID), false);
  assert.equal(afterBoot.includes(BOT_TOKEN), false);
});

test("negative: a Stellar secret strkey is redacted", () => {
  const out = redactText(`never paste ${STELLAR_SECRET} into a log`);
  assert.equal(out.includes(STELLAR_SECRET), false);
  assert.equal(out.includes(REDACTED), true);
});

test("negative: URL userinfo credentials are redacted, the endpoint is not", () => {
  const out = redactText("fetch failed for https://user:hunter2@rpc.example/soroban");
  assert.equal(out.includes("hunter2"), false);
  assert.equal(out.includes("user:hunter2"), false);
  assert.equal(out.includes("rpc.example"), true);
});

test("negative: credentials in a query string are redacted", () => {
  const out = redactText("POST https://rpc.example/x?api_key=abcdef1234567890&limit=10 failed");
  assert.equal(out.includes("abcdef1234567890"), false);
  assert.equal(out.includes("limit=10"), true);
});

test("negative: Bearer and key/value echoes are redacted", () => {
  const bearer = redactText(`Authorization: Bearer ${"s".repeat(24)}`);
  assert.equal(bearer.includes("s".repeat(24)), false);
  assert.match(bearer, /Bearer \[REDACTED]/);

  const pair = redactText("TELEGRAM_BOT_TOKEN=abcdef1234567890 rejected");
  assert.equal(pair.includes("abcdef1234567890"), false);
});

test("boundary: a short non-value stays readable", () => {
  // `token: unset` is a message an operator needs, not a credential.
  assert.equal(redactText("token: unset"), "token: unset");
  assert.equal(redactText("123:short"), "123:short");
});

// ── Boundary ──────────────────────────────────────────────────────────────────

test("boundary: empty and non-string throws", () => {
  assert.equal(redactText(""), "");
  assert.equal(redactError(null), "null");
  assert.equal(redactError(undefined), "undefined");
  assert.equal(safeErrorMessage(null), "unknown error");
});

test("boundary: an unbounded remote payload is truncated", () => {
  const huge = `ok ${"x".repeat(DEFAULT_MAX_LEN + 500)}`;
  const out = redactText(huge);
  assert.ok(out.length <= DEFAULT_MAX_LEN, `length ${out.length}`);
  assert.equal(out.endsWith("…"), true);
  assert.equal(redactText("abcdef", { maxLen: 4 }), "abc…");
  // safeErrorMessage keeps its own, tighter historical bound.
  assert.ok(safeErrorMessage(new Error(huge)).length <= 240);
});

test("boundary: redactError takes Error, string, and JSON-able objects", () => {
  assert.equal(redactError(new Error(`tok ${BOT_TOKEN}`)).includes(BOT_TOKEN), false);
  assert.equal(redactError(`tok ${BOT_TOKEN}`).includes(BOT_TOKEN), false);
  assert.equal(
    redactError({ url: `https://api.telegram.org/bot${BOT_TOKEN}/getMe` }).includes(BOT_TOKEN),
    false,
  );
  // A JSON-RPC failure arrives as a plain object, not an Error.
  const rpc = redactError({ code: -32602, message: `bad params for ${BOT_TOKEN}` });
  assert.equal(rpc.includes(BOT_TOKEN), false);
  assert.equal(rpc.includes("-32602"), true);
});

test("boundary: redactUrl scrubs credentials and leaves a clean URL alone", () => {
  assert.equal(redactUrl("https://soroban-testnet.stellar.org"), "https://soroban-testnet.stellar.org");
  assert.equal(
    redactUrl("https://user:pass@soroban-testnet.stellar.org"),
    `https://${REDACTED}@soroban-testnet.stellar.org`,
  );
  const query = redactUrl("https://rpc.example/?token=abcdef1234567890");
  assert.equal(query.includes("abcdef1234567890"), false);
});

// ── Regression: the ops surfaces that read error text ─────────────────────────

test("regression: health lastError is redacted on the way out", () => {
  const report = buildHealthReport(
    baseConfig(),
    baseStatus({
      lastError: {
        at: 5_000,
        message: `Telegram send failed: https://api.telegram.org/bot${BOT_TOKEN}/sendMessage 401`,
      },
      targets: [
        {
          source: "market",
          contractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
          cursor: "0018276211125911551-4294967295",
          lastEventLedger: 40,
          cursorStale: false,
          lastError: `bot${BOT_TOKEN} rejected`,
        },
      ],
    }),
    5_500,
  );
  const blob = JSON.stringify(report);
  assert.equal(blob.includes(BOT_TOKEN), false);
  assert.equal(blob.includes(CHAT_ID), false);
});

test("regression: the health report never carries a config secret", () => {
  const config = baseConfig();
  const blob = JSON.stringify(buildHealthReport(config, baseStatus(), 5_500));
  assert.equal(blob.includes(config.botToken), false);
  assert.equal(blob.includes(config.chatId), false);
});

test("regression: a seed strkey in an RPC error never reaches an operator", () => {
  // The realistic leak: a seed pasted into the wrong variable, then echoed back
  // in an upstream error message.
  const message = safeErrorMessage(
    new Error(`G3 bad request: invalid key ${STELLAR_SECRET}`),
  );
  assert.equal(message.includes(STELLAR_SECRET), false);
  assert.equal(message.includes(REDACTED), true);
});
